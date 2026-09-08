package hub

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestManifestRejectsUnsafeOrAmbiguousConfiguration(t *testing.T) {
	for _, pair := range [][2]string{{"project: shop", "project: ../escape"}, {"image: web:1", "image: web:1\n    unexpected: true"}, {"depends_on: [postgres, redis]", "depends_on: [web]"}, {"depends_on: [postgres, redis]", "depends_on: [missing]"}, {"uploads: /uploads", "../uploads: /uploads"}, {"image: web:1", "build: ../escape"}} {
		t.Run(pair[1], func(t *testing.T) {
			if _, e := ParseManifest([]byte(strings.Replace(testManifest, pair[0], pair[1], 1))); e == nil {
				t.Fatal("invalid manifest accepted")
			}
		})
	}
}
func TestSafePathRejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	if e := os.Symlink(t.TempDir(), filepath.Join(root, "outside")); e != nil {
		t.Fatal(e)
	}
	if _, e := SafePath(root, "outside"); e == nil {
		t.Fatal("symlink escaped source root")
	}
}
func TestComposeFailsOnUnsupportedSemantics(t *testing.T) {
	_, e := ImportCompose([]byte("services:\n  web:\n    image: nginx\n    privileged: true\n"), "shop")
	if e == nil {
		t.Fatal("silently dropped compose semantics")
	}
}
func TestRuntimeInspectionFormats(t *testing.T) {
	for _, b := range []string{`[{"status":{"state":"running","networks":[{"ipv4Address":"192.168.64.2/24"}]}}]`, `[{"status":"running","networks":[{"ipv4Address":"192.168.64.2/24"}]}]`} {
		v, e := DecodeContainer([]byte(b))
		if e != nil || !v.Running || v.IP != "192.168.64.2" {
			t.Fatalf("inspection: %#v %v", v, e)
		}
	}
}
