package hub

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/moby/patternmatcher"
	"github.com/moby/patternmatcher/ignorefile"
)

type BuildRecord struct {
	Digest string `json:"digest"`
	Image  string `json:"image"`
}
type buildContext struct {
	Root, Dockerfile, Digest string
	Files                    int
	Bytes                    int64
	cleanup                  func()
}

// Stage only included entries. In particular, do not let the Apple builder
// repeatedly enumerate excluded dependency trees during its metadata requests.
func prepareBuildContext(ctx context.Context, root, dockerfile string) (_ *buildContext, err error) {
	root, err = filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if !filepath.IsAbs(dockerfile) {
		dockerfile = filepath.Join(root, dockerfile)
	}
	dockerfile, err = filepath.Abs(dockerfile)
	if err != nil {
		return nil, err
	}
	ignorePath := dockerfile + ".dockerignore"
	if _, e := os.Stat(ignorePath); os.IsNotExist(e) {
		ignorePath = filepath.Join(root, ".dockerignore")
	} else if e != nil {
		return nil, e
	}
	var patterns []string
	if input, e := os.Open(ignorePath); e == nil {
		patterns, err = ignorefile.ReadAll(input)
		input.Close()
		if err != nil {
			return nil, err
		}
	} else if !os.IsNotExist(e) {
		return nil, e
	}
	matcher, err := patternmatcher.New(patterns)
	if err != nil {
		return nil, fmt.Errorf("invalid dockerignore: %w", err)
	}
	// Apple's filesystem sync omits nested entries under macOS temporary
	// directories. Use the user cache, where recursive COPY remains intact.
	cache, err := os.UserCacheDir()
	if err != nil {
		return nil, err
	}
	cache = filepath.Join(cache, "contremaitre", "builds")
	if err = os.MkdirAll(cache, 0700); err != nil {
		return nil, err
	}
	directory, err := os.MkdirTemp(cache, "context-")
	if err != nil {
		return nil, err
	}
	staged := &buildContext{Root: filepath.Join(directory, "context"), Dockerfile: filepath.Join(directory, "definition", "Dockerfile"), cleanup: func() {
		_ = filepath.WalkDir(directory, func(path string, entry fs.DirEntry, e error) error {
			if e == nil && entry.IsDir() {
				_ = os.Chmod(path, 0700)
			}
			return nil
		})
		_ = os.RemoveAll(directory)
	}}
	defer func() {
		if err != nil {
			staged.cleanup()
		}
	}()
	if err = os.MkdirAll(staged.Root, 0700); err != nil {
		return nil, err
	}
	if err = os.MkdirAll(filepath.Dir(staged.Dockerfile), 0700); err != nil {
		return nil, err
	}
	definition, err := os.ReadFile(dockerfile)
	if err != nil {
		return nil, err
	}
	if err = os.WriteFile(staged.Dockerfile, definition, 0600); err != nil {
		return nil, err
	}
	digest := sha256.New()
	fmt.Fprintf(digest, "context-v1\x00%d\x00%s\x00%q\n", len(definition), definition, patterns)
	// os.Root prevents a path swapped for a symlink during copying from escaping
	// the source tree. Symlinks themselves are copied, never traversed.
	type directoryMode struct {
		path string
		info fs.FileInfo
	}
	var directories []directoryMode
	source, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	defer source.Close()
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		rel, e := filepath.Rel(root, path)
		if e != nil {
			return e
		}
		if rel == "." {
			return nil
		}
		ignored, e := matcher.MatchesOrParentMatches(filepath.ToSlash(rel))
		if e != nil {
			return e
		}
		if entry.IsDir() {
			info, e := entry.Info()
			if e != nil {
				return e
			}
			directories = append(directories, directoryMode{filepath.Join(staged.Root, rel), info})
		}
		if ignored {
			if entry.IsDir() && !matcher.Exclusions() {
				return filepath.SkipDir
			}
			// Negations may re-include descendants. Keep walking in that case instead
			// of guessing which glob prefixes can reach this directory.
			return nil
		}
		info, e := entry.Info()
		if e != nil {
			return e
		}
		target := filepath.Join(staged.Root, rel)
		if e = os.MkdirAll(filepath.Dir(target), 0700); e != nil {
			return e
		}
		fmt.Fprintf(digest, "%q\x00%d\x00", filepath.ToSlash(rel), info.Mode())
		switch {
		case info.IsDir():
			if e = os.MkdirAll(target, 0700); e != nil {
				return e
			}
		case info.Mode()&os.ModeSymlink != 0:
			link, e := source.Readlink(rel)
			if e != nil {
				return e
			}
			resolved := link
			if !filepath.IsAbs(link) {
				resolved = filepath.Join(filepath.Dir(path), link)
			}
			destination, e := filepath.Rel(root, resolved)
			if e != nil || destination == ".." || strings.HasPrefix(destination, ".."+string(filepath.Separator)) {
				return fmt.Errorf("build symlink escapes context: %s", rel)
			}
			// Absolute in-tree links must point at their staged equivalent.
			if filepath.IsAbs(link) {
				link, e = filepath.Rel(filepath.Dir(target), filepath.Join(staged.Root, destination))
				if e != nil {
					return e
				}
			}
			fmt.Fprintf(digest, "%q\x00", link)
			if e = os.Symlink(link, target); e != nil {
				return e
			}
		case info.Mode().IsRegular():
			input, e := source.Open(rel)
			if e != nil {
				return e
			}
			output, e := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if e != nil {
				input.Close()
				return e
			}
			fmt.Fprintf(digest, "%d\x00", info.Size())
			n, copyErr := io.Copy(io.MultiWriter(output, digest), input)
			input.Close()
			closeErr := output.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
			if n != info.Size() {
				return fmt.Errorf("build source changed while copying: %s; retry deploy", rel)
			}
			if e = os.Chmod(target, info.Mode().Perm()); e != nil {
				return e
			}
			if e = os.Chtimes(target, info.ModTime(), info.ModTime()); e != nil {
				return e
			}
			staged.Files++
			staged.Bytes += n
		default:
			return fmt.Errorf("unsupported build context entry: %s", rel)
		}
		_, e = digest.Write([]byte{0})
		return e
	})
	if err != nil {
		return nil, err
	}
	for i := len(directories) - 1; i >= 0; i-- {
		dir := directories[i]
		if _, e := os.Stat(dir.path); os.IsNotExist(e) {
			continue
		}
		rel, _ := filepath.Rel(staged.Root, dir.path)
		fmt.Fprintf(digest, "parent:%q:%d\x00", filepath.ToSlash(rel), dir.info.Mode())
		if err = os.Chmod(dir.path, dir.info.Mode().Perm()); err != nil {
			return nil, err
		}
		if err = os.Chtimes(dir.path, dir.info.ModTime(), dir.info.ModTime()); err != nil {
			return nil, err
		}
	}
	// Docker's selected ignore rules must also govern COPY in the staged context.
	// The definition lives outside it, so even an excluded Dockerfile remains usable.
	// An empty Dockerfile-specific file also overrides root ignore rules.
	if err = os.WriteFile(staged.Dockerfile+".dockerignore", []byte(strings.Join(patterns, "\n")+"\n"), 0600); err != nil {
		return nil, err
	}
	rootInfo, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	if err = os.Chmod(staged.Root, rootInfo.Mode().Perm()); err != nil {
		return nil, err
	}
	fmt.Fprintf(digest, "root-mode:%d", rootInfo.Mode())
	staged.Digest = hex.EncodeToString(digest.Sum(nil))
	return staged, nil
}

func (a Apple) BuildCached(ctx context.Context, root, dockerfile, tag string, previous BuildRecord) (BuildRecord, error) {
	progress(ctx, "Preparing filtered build context")
	staged, err := prepareBuildContext(ctx, root, dockerfile)
	if err != nil {
		return BuildRecord{}, err
	}
	defer staged.cleanup()
	progress(ctx, "Build context: %d files, %.2f MB", staged.Files, float64(staged.Bytes)/1e6)
	if previous.Digest == staged.Digest && previous.Image != "" {
		if _, err := a.output(ctx, "image", "inspect", previous.Image); err == nil {
			progress(ctx, "Reusing unchanged image %s", previous.Image)
			return previous, nil
		}
	}
	args := []string{"build", "--tag", tag, "--file", staged.Dockerfile, "--progress", "plain"}
	// Apple build otherwise recreates a configured builder at its defaults.
	// Inspect only its resource allocation; never emit process environment.
	if data, inspectErr := a.output(ctx, "inspect", "buildkit"); inspectErr == nil {
		var builders []struct {
			Configuration struct {
				Resources struct {
					CPUs   int   `json:"cpus"`
					Memory int64 `json:"memoryInBytes"`
				} `json:"resources"`
			} `json:"configuration"`
		}
		if json.Unmarshal(data, &builders) == nil && len(builders) == 1 {
			r := builders[0].Configuration.Resources
			if r.CPUs > 0 && r.Memory > 0 {
				args = append(args, "--cpus", fmt.Sprint(r.CPUs), "--memory", fmt.Sprint(r.Memory))
				progress(ctx, "Builder: %d CPUs, %d MB RAM", r.CPUs, r.Memory/(1024*1024))
			}
		}
	}
	args = append(args, staged.Root)
	c := a.command(ctx, args...)
	c.Stdout = deploymentOutput(ctx)
	c.Stderr = c.Stdout
	if err = c.Run(); err != nil {
		return BuildRecord{}, err
	}
	return BuildRecord{Digest: staged.Digest, Image: tag}, nil
}
