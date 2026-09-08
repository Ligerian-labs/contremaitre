package hub

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

func (m *Manager) clone(ctx context.Context, source, target *Environment) (err error) {
	var temporary []string
	resume := map[string]bool{}
	manifest := Manifest{Services: map[string]Service{}}
	for name, s := range source.Services {
		manifest.Services[name] = s.Spec
	}
	order, orderErr := manifest.Order()
	if orderErr != nil {
		return orderErr
	}
	// Cleanup gets its own deadline: canceling deploy must still resume main.
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		for _, name := range order {
			if !resume[name] {
				continue
			}
			service := source.Services[name]
			restartErr := m.Runtime.Remove(cleanup, service.Container)
			if restartErr == nil {
				restartErr = m.startService(cleanup, source, service, false)
			}
			if restartErr != nil {
				err = errors.Join(err, fmt.Errorf("resume main %s: %w", name, restartErr))
				source.Status = "failed"
				source.Error = "failed to resume after clone"
			}
		}
		for _, name := range temporary {
			if e := m.Runtime.Stop(cleanup, name); e != nil {
				err = errors.Join(err, e)
			}
			if e := m.Runtime.Remove(cleanup, name); e != nil {
				err = errors.Join(err, e)
			}
		}
	}()
	for _, name := range sortedKeys(source.Services) {
		s := source.Services[name]
		if s.Spec.Kind != "app" {
			continue
		}
		v, e := m.Runtime.Inspect(ctx, s.Container)
		if errors.Is(e, ErrNotFound) {
			continue
		}
		if e != nil {
			return e
		}
		if v.Running {
			resume[name] = true
			if e = m.Runtime.Stop(ctx, s.Container); e != nil {
				return e
			}
			s.IP = ""
			if e = m.save(); e != nil {
				return e
			}
		}
	}
	if source.Status == "stopped" {
		for _, s := range source.Services {
			if e := m.Runtime.Remove(ctx, s.Container); e != nil {
				return e
			}
		}
		if e := m.Runtime.RemoveNetwork(ctx, source.Network); e != nil {
			return e
		}
		if e := m.Runtime.Network(ctx, source.Network); e != nil {
			return e
		}
	}
	for _, name := range sortedKeys(target.Services) {
		to := target.Services[name]
		if to.Spec.Kind != "postgres" {
			continue
		}
		from := source.Services[name]
		if from == nil {
			continue
		}
		if from.Spec.Kind != "postgres" || from.Image != to.Image {
			return fmt.Errorf("clone %s: main database image must match target", name)
		}
		v, e := m.Runtime.Inspect(ctx, from.Container)
		if e != nil && !errors.Is(e, ErrNotFound) {
			return e
		}
		if e == nil && !v.Running {
			temporary = append(temporary, from.Container)
			if e = m.Runtime.Start(ctx, from.Container); e != nil {
				return e
			}
			if e = m.waitReady(ctx, from); e != nil {
				return e
			}
		} else if errors.Is(e, ErrNotFound) {
			temporary = append(temporary, from.Container)
			if e = m.startService(ctx, source, from, false); e != nil {
				return e
			}
		}
		if e = os.MkdirAll(filepath.Join(m.Store.Home, "tmp"), 0700); e != nil {
			return e
		}
		dump, e := os.CreateTemp(filepath.Join(m.Store.Home, "tmp"), "database-*.dump")
		if e != nil {
			return e
		}
		e = func() error {
			defer os.Remove(dump.Name())
			defer dump.Close()
			if e := m.Runtime.Exec(ctx, from.Container, []string{"pg_dump", "-Fc", "--no-owner", "-U", "app", "-d", "app"}, nil, dump, os.Stderr); e != nil {
				return e
			}
			if _, e := dump.Seek(0, 0); e != nil {
				return e
			}
			return m.Runtime.Exec(ctx, to.Container, []string{"pg_restore", "--clean", "--if-exists", "--no-owner", "--exit-on-error", "-U", "app", "-d", "app"}, dump, io.Discard, os.Stderr)
		}()
		if e != nil {
			return fmt.Errorf("clone database %s: %w", name, e)
		}
	}
	names := map[string]bool{}
	for _, s := range target.Services {
		for name := range s.Spec.Volumes {
			names[name] = true
		}
	}
	for _, name := range sortedKeys(names) {
		src := filepath.Join(m.Store.Home, "data", source.Identity.ID, name)
		if _, e := os.Stat(src); os.IsNotExist(e) {
			continue
		} else if e != nil {
			return e
		}
		dst := filepath.Join(m.Store.Home, "data", target.Identity.ID, name)
		if e := os.RemoveAll(dst); e != nil {
			return e
		}
		if e := copyTree(ctx, src, dst); e != nil {
			return fmt.Errorf("clone uploaded files %s: %w", name, e)
		}
	}
	for name, to := range target.Services {
		if from := source.Services[name]; from != nil && from.Spec.Kind == to.Spec.Kind {
			to.Initialized = from.Initialized
		}
	}
	return nil
}
func copyTree(ctx context.Context, source, target string) error {
	return filepath.WalkDir(source, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if e := ctx.Err(); e != nil {
			return e
		}
		rel, e := filepath.Rel(source, path)
		if e != nil {
			return e
		}
		dst := filepath.Join(target, rel)
		info, e := d.Info()
		if e != nil {
			return e
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlinks in persistent files are unsupported: %s", rel)
		}
		if d.IsDir() {
			return os.MkdirAll(dst, info.Mode().Perm())
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("unsupported persistent file: %s", rel)
		}
		if info, err := os.Lstat(dst); err == nil && info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("destination symlink: %s", rel)
		}
		in, e := os.Open(path)
		if e != nil {
			return e
		}
		defer in.Close()
		out, e := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, info.Mode().Perm())
		if e != nil {
			return e
		}
		_, e = io.Copy(out, contextReader{ctx, in})
		ce := out.Close()
		if e != nil {
			return e
		}
		return ce
	})
}

type contextReader struct {
	ctx    context.Context
	source io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if e := r.ctx.Err(); e != nil {
		return 0, e
	}
	return r.source.Read(p)
}
