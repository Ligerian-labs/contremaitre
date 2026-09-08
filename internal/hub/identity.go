package hub

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

type Identity struct{ Project, Workspace, Branch, ID, Name, Host string }

var slugPattern = regexp.MustCompile(`[^a-z0-9-]+`)

func Slug(s string) string {
	s = strings.Trim(slugPattern.ReplaceAllString(strings.ToLower(s), "-"), "-")
	if len(s) > 40 {
		s = strings.TrimRight(s[:40], "-")
	}
	if s == "" {
		return "workspace"
	}
	return s
}
func NewIdentity(project, workspace, branch string) Identity {
	sum := sha256.Sum256([]byte(project + "\x00" + workspace + "\x00" + branch))
	id := fmt.Sprintf("%x", sum[:8])
	name := Slug(branch) + "-" + Slug(filepath.Base(workspace))
	if len(name) > 44 {
		name = strings.TrimRight(name[:44], "-")
	}
	name += "-" + id[:8]
	return Identity{project, workspace, branch, id, project + "/" + name, name + "." + Slug(project) + ".localhost"}
}
func vcs(ctx context.Context, dir string, args ...string) (string, error) {
	c := exec.CommandContext(ctx, args[0], args[1:]...)
	c.Dir = dir
	b, e := c.Output()
	return strings.TrimSpace(string(b)), e
}
func DetectIdentity(ctx context.Context, dir, project, branch string) (Identity, error) {
	root, err := filepath.Abs(dir)
	if err != nil {
		return Identity{}, err
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return Identity{}, err
	}
	isJJ := false
	for p := root; ; p = filepath.Dir(p) {
		if _, e := os.Stat(filepath.Join(p, ".jj")); e == nil {
			isJJ = true
			break
		}
		if filepath.Dir(p) == p {
			break
		}
	}
	if isJJ {
		root, err = vcs(ctx, dir, "jj", "root")
		if err != nil {
			return Identity{}, fmt.Errorf("resolve jj workspace: %w", err)
		}
		if branch == "" {
			branch, err = vcs(ctx, dir, "jj", "log", "--ignore-working-copy", "-r", "heads(::@ & bookmarks())", "--no-graph", "-T", `local_bookmarks.map(|b| b.name()).join("\n") ++ "\n"`)
			if err != nil {
				return Identity{}, fmt.Errorf("resolve jj bookmark: %w", err)
			}
			fields := strings.Fields(branch)
			if len(fields) > 1 {
				return Identity{}, fmt.Errorf("multiple jj bookmarks; select one with --branch")
			}
			if len(fields) == 1 {
				branch = fields[0]
			}
		}
	} else if gitRoot, e := vcs(ctx, dir, "git", "rev-parse", "--show-toplevel"); e == nil {
		root = gitRoot
		if branch == "" {
			branch, _ = vcs(ctx, dir, "git", "symbolic-ref", "--quiet", "--short", "HEAD")
			if branch == "" {
				sha, e := vcs(ctx, dir, "git", "rev-parse", "--short=12", "HEAD")
				if e == nil {
					branch = "detached-" + sha
				}
			}
		}
	}
	if branch == "" {
		branch = "workspace"
	}
	return NewIdentity(project, root, branch), nil
}
