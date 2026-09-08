package hub

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestEnvironmentIdentityIsolation(t *testing.T) {
	a := NewIdentity("shop", "/work/one", "feat/checkout")
	b := NewIdentity("shop", "/work/two", "feat/checkout")
	c := NewIdentity("shop", "/work/one", "main")
	if a.ID == "" || a.ID == b.ID || a.ID == c.ID {
		t.Fatal("workspace and branch must each isolate environment identity")
	}
	if a != NewIdentity("shop", "/work/one", "feat/checkout") {
		t.Fatal("identity must survive redeployment")
	}
}

func TestHostnameIsBoundedAndCollisionSafe(t *testing.T) {
	a := NewIdentity("shop", "/work/one", "feat/a")
	b := NewIdentity("shop", "/work/one", "feat-a")
	if a.Host == b.Host {
		t.Fatal("normalized branch names must not collide")
	}
}

func TestRealJujutsuWorkspaces(t *testing.T) {
	if _, e := exec.LookPath("jj"); e != nil {
		t.Skip("jj unavailable")
	}
	base := t.TempDir()
	root := filepath.Join(base, "repo")
	if e := os.Mkdir(root, 0700); e != nil {
		t.Fatal(e)
	}
	run := func(dir string, args ...string) {
		t.Helper()
		c := exec.Command("jj", args...)
		c.Dir = dir
		if b, e := c.CombinedOutput(); e != nil {
			t.Fatalf("jj %v: %s %v", args, b, e)
		}
	}
	run(root, "git", "init")
	first, e := DetectIdentity(context.Background(), root, "shop", "")
	if e != nil {
		t.Fatal(e)
	}
	run(root, "new")
	again, e := DetectIdentity(context.Background(), root, "shop", "")
	if e != nil || first.ID != again.ID {
		t.Fatal("unbookmarked change created a new environment", e)
	}
	run(root, "bookmark", "create", "main")
	bookmarked, e := DetectIdentity(context.Background(), root, "shop", "")
	if e != nil || bookmarked.Branch != "main" {
		t.Fatal("bookmark detection failed", e)
	}
	other := filepath.Join(base, "other")
	run(root, "workspace", "add", other, "--name", "agent-2")
	second, e := DetectIdentity(context.Background(), other, "shop", "")
	if e != nil || first.ID == second.ID {
		t.Fatal("jj workspaces share environment", e)
	}
}
