package hub

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestAppleBuildDoesNotSendIgnoredDependencies(t *testing.T) {
	root := t.TempDir()
	for name, contents := range map[string]string{"Dockerfile": "FROM scratch\nCOPY source /source\n", ".dockerignore": "node_modules\n.env\n", "source": "application", "node_modules/large/tree": "ignored", ".env": "private"} {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
			t.Fatal(err)
		}
	}
	engine := filepath.Join(t.TempDir(), "container")
	script := "#!/bin/sh\nfor context do :; done\ntest ! -e \"$context/node_modules\" && test ! -e \"$context/.env\" && test -f \"$context/source\"\n"
	if err := os.WriteFile(engine, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	if err := (Apple{Binary: engine}).Build(context.Background(), root, filepath.Join(root, "Dockerfile"), "test"); err != nil {
		t.Fatalf("builder received the unfiltered working directory: %v", err)
	}
}

func TestFilteredContextPreservesRulesModesAndFingerprint(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{"Dockerfile": "FROM scratch\nCOPY . /app\n", ".dockerignore": "node_modules\n.env\nassets\n!assets/keep.txt\n", "app/run.sh": "#!/bin/sh\n", "node_modules/pkg/file": "large ignored tree", ".env": "private", "assets/keep.txt": "keep", "assets/drop.txt": "drop"}
	for name, body := range files {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chmod(filepath.Join(root, "app/run.sh"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("app/run.sh", filepath.Join(root, "entry")); err != nil {
		t.Fatal(err)
	}
	stage := func() *buildContext {
		t.Helper()
		c, e := prepareBuildContext(context.Background(), root, "Dockerfile")
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(c.cleanup)
		return c
	}
	first := stage()
	for _, name := range []string{"node_modules", ".env", "assets/drop.txt"} {
		if _, e := os.Lstat(filepath.Join(first.Root, name)); !os.IsNotExist(e) {
			t.Fatalf("included ignored path %s", name)
		}
	}
	if b, e := os.ReadFile(filepath.Join(first.Root, "assets/keep.txt")); e != nil || string(b) != "keep" {
		t.Fatal("lost negation")
	}
	for _, name := range []string{"app", "app/run.sh"} {
		info, e := os.Stat(filepath.Join(first.Root, name))
		if e != nil || info.Mode().Perm() != 0755 {
			t.Fatalf("lost permissions on %s", name)
		}
	}
	if link, e := os.Readlink(filepath.Join(first.Root, "entry")); e != nil || link != "app/run.sh" {
		t.Fatal("lost symlink")
	}
	if e := os.WriteFile(filepath.Join(root, "node_modules/pkg/file"), []byte("changed ignored file"), 0644); e != nil {
		t.Fatal(e)
	}
	if stage().Digest != first.Digest {
		t.Fatal("ignored dependency changed fingerprint")
	}
	if e := os.WriteFile(filepath.Join(root, "app/run.sh"), []byte("changed source"), 0755); e != nil {
		t.Fatal(e)
	}
	if stage().Digest == first.Digest {
		t.Fatal("source edit did not invalidate fingerprint")
	}
}
func TestDockerfileSpecificIgnoreAndExcludedDefinition(t *testing.T) {
	root := t.TempDir()
	for name, body := range map[string]string{"Dockerfile": "FROM scratch\n", ".dockerignore": "needed\n", "Dockerfile.dockerignore": "secret\nDockerfile\n", "needed": "source", "secret": "private"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	staged, err := prepareBuildContext(context.Background(), root, "Dockerfile")
	if err != nil {
		t.Fatal(err)
	}
	defer staged.cleanup()
	if _, err = os.Stat(filepath.Join(staged.Root, "needed")); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(staged.Root, "secret")); !os.IsNotExist(err) {
		t.Fatal("specific ignore rules lost")
	}
	if _, err = os.Stat(filepath.Join(staged.Root, "Dockerfile")); !os.IsNotExist(err) {
		t.Fatal("excluded Dockerfile became COPY input")
	}
	if _, err = os.Stat(staged.Dockerfile); err != nil {
		t.Fatal("excluded Dockerfile cannot build")
	}
}
func TestBuildContextRejectsEscapingSymlinkAndCancellation(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "Dockerfile"), []byte("FROM scratch\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../../private", filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	if c, err := prepareBuildContext(context.Background(), root, "Dockerfile"); err == nil {
		c.cleanup()
		t.Fatal("accepted escaping link")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if c, err := prepareBuildContext(ctx, root, "Dockerfile"); err == nil {
		c.cleanup()
		t.Fatal("ignored cancellation")
	}
}
func TestBuildCacheChecksImageAndSource(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "Dockerfile"), []byte("FROM scratch\n"), 0600); err != nil {
		t.Fatal(err)
	}
	engine := filepath.Join(t.TempDir(), "container")
	if err := os.WriteFile(engine, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	runtime := Apple{Binary: engine}
	first, err := runtime.BuildCached(context.Background(), root, "Dockerfile", "first", BuildRecord{})
	if err != nil {
		t.Fatal(err)
	}
	second, err := runtime.BuildCached(context.Background(), root, "Dockerfile", "second", first)
	if err != nil {
		t.Fatal(err)
	}
	if second.Image != "first" {
		t.Fatal("unchanged image was rebuilt")
	}
	if err = os.WriteFile(engine, []byte("#!/bin/sh\nif [ \"$1\" = image ]; then exit 1; fi\n"), 0700); err != nil {
		t.Fatal(err)
	}
	missing, err := runtime.BuildCached(context.Background(), root, "Dockerfile", "missing", first)
	if err != nil || missing.Image != "missing" {
		t.Fatal("missing cached image was reused")
	}
	if err = os.WriteFile(filepath.Join(root, "Dockerfile"), []byte("FROM scratch\nLABEL changed=yes\n"), 0600); err != nil {
		t.Fatal(err)
	}
	changed, err := runtime.BuildCached(context.Background(), root, "Dockerfile", "changed", first)
	if err != nil || changed.Digest == first.Digest {
		t.Fatal("Dockerfile change reused image")
	}
}

func TestBuildPreservesBuilderResources(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "Dockerfile"), []byte("FROM scratch\n"), 0600); err != nil {
		t.Fatal(err)
	}
	engine := filepath.Join(t.TempDir(), "container")
	script := `#!/bin/sh
if [ "$1" = inspect ]; then
 printf '%s\n' '[{"configuration":{"resources":{"cpus":4,"memoryInBytes":8589934592}}}]'
 exit 0
fi
cpus= memory=
while [ "$#" -gt 0 ]; do
 case "$1" in
 --cpus) shift; cpus=$1 ;;
 --memory) shift; memory=$1 ;;
 esac
 shift
done
test "$cpus" = 4 && test "$memory" = 8589934592
`
	if err := os.WriteFile(engine, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	if err := (Apple{Binary: engine}).Build(context.Background(), root, "Dockerfile", "test"); err != nil {
		t.Fatalf("builder configuration was reset: %v", err)
	}
}
