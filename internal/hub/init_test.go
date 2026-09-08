package hub

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func initFixture(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "project")
	for name, contents := range files {
		path := filepath.Join(dir, name)
		if e := os.MkdirAll(filepath.Dir(path), 0755); e != nil {
			t.Fatal(e)
		}
		if e := os.WriteFile(path, []byte(contents), 0644); e != nil {
			t.Fatal(e)
		}
	}
	return dir
}

func TestInitMonorepoDockerfiles(t *testing.T) {
	dir := initFixture(t, map[string]string{
		"package.json":                              `{"private":true,"scripts":{"build":"turbo run build"}}`,
		"docker/api.Dockerfile":                     "FROM node:22 AS build\nEXPOSE 9000\nFROM node:22 AS runtime\nEXPOSE 3000\n",
		"docker/web.Dockerfile":                     "FROM node:22\nEXPOSE 4000/tcp\n",
		"docker/admin.Dockerfile":                   "FROM nginx:alpine\nEXPOSE 80\n",
		"workspace/other/docker/ignored.Dockerfile": "FROM nginx\nEXPOSE 9999\n",
	})
	if _, e := InitProject(dir, ""); e != nil {
		t.Fatal(e)
	}
	m, _, e := LoadManifest(dir)
	if e != nil {
		t.Fatal(e)
	}
	if len(m.Services) != 3 {
		t.Fatalf("expected three applications, got %#v", m.Services)
	}
	for name, port := range map[string]int{"api": 3000, "web": 4000, "admin": 80} {
		s := m.Services[name]
		if s.Build != "." || s.Dockerfile != "docker/"+name+".Dockerfile" || s.Port != port || !s.HTTP {
			t.Errorf("incorrect %s service: %#v", name, s)
		}
	}
	if _, e := os.Stat(filepath.Join(dir, "Dockerfile.contremaitre")); !os.IsNotExist(e) {
		t.Fatal("init generated a Node Dockerfile despite existing service Dockerfiles")
	}
}

func TestInitDockerfileDiscoveryErrorsLeaveNoManifest(t *testing.T) {
	for name, files := range map[string]map[string]string{
		"name collision": {"docker/my_api.Dockerfile": "FROM node\nEXPOSE 3000\n", "docker/my-api.Dockerfile": "FROM node\nEXPOSE 3000\n"},
		"multiple ports": {"docker/api.Dockerfile": "FROM node\nEXPOSE 3000 3001\n"},
		"variable port":  {"docker/api.Dockerfile": "FROM node\nEXPOSE $PORT\n"},
	} {
		t.Run(name, func(t *testing.T) {
			dir := initFixture(t, files)
			if _, e := InitProject(dir, ""); e == nil {
				t.Fatal("ambiguous Dockerfiles accepted")
			}
			if _, e := os.Stat(filepath.Join(dir, ".contremaitre.yaml")); !os.IsNotExist(e) {
				t.Fatal("failed discovery left a manifest")
			}
		})
	}
}

func TestInitPreservesEitherManifestExtension(t *testing.T) {
	for _, name := range []string{".contremaitre.yaml", ".contremaitre.yml"} {
		t.Run(name, func(t *testing.T) {
			dir := initFixture(t, map[string]string{name: "existing configuration\n", "Dockerfile": "FROM nginx\n"})
			if _, e := InitProject(dir, ""); e == nil || !strings.Contains(e.Error(), "already exists") {
				t.Fatalf("expected existing manifest error, got %v", e)
			}
			b, e := os.ReadFile(filepath.Join(dir, name))
			if e != nil || string(b) != "existing configuration\n" {
				t.Fatal("existing manifest changed")
			}
			if name == ".contremaitre.yml" {
				if _, e := os.Stat(filepath.Join(dir, ".contremaitre.yaml")); !os.IsNotExist(e) {
					t.Fatal("init shadowed the existing yml manifest")
				}
			}
		})
	}
}

func TestInitDockerfileSymlinkCannotEscapeProject(t *testing.T) {
	dir := initFixture(t, map[string]string{"docker/README.md": "Dockerfiles live here.\n"})
	outside := initFixture(t, map[string]string{"api.Dockerfile": "FROM node\nEXPOSE 3000\n"})
	if e := os.Symlink(filepath.Join(outside, "api.Dockerfile"), filepath.Join(dir, "docker/api.Dockerfile")); e != nil {
		t.Fatal(e)
	}
	if _, e := InitProject(dir, ""); e == nil || !strings.Contains(e.Error(), "escapes project") {
		t.Fatalf("expected a path escape error, got %v", e)
	}
}

func TestInitExistingConventions(t *testing.T) {
	for name, files := range map[string]map[string]string{
		"root Dockerfile takes precedence": {
			"Dockerfile":            "FROM node\nEXPOSE 3000\n",
			"docker/api.Dockerfile": "FROM node\nEXPOSE 4000\n",
		},
		"pnpm": {
			"package.json":   `{"scripts":{"start":"node index.js","build":"tsc"}}`,
			"pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
		},
	} {
		t.Run(name, func(t *testing.T) {
			dir := initFixture(t, files)
			if _, e := InitProject(dir, ""); e != nil {
				t.Fatal(e)
			}
			m, _, e := LoadManifest(dir)
			if e != nil || len(m.Services) != 1 || m.Services["web"].Port != 3000 {
				t.Fatalf("existing convention changed: %#v, %v", m, e)
			}
			if name == "pnpm" {
				b, e := os.ReadFile(filepath.Join(dir, "Dockerfile.contremaitre"))
				if e != nil || !strings.Contains(string(b), "pnpm install --frozen-lockfile") {
					t.Fatalf("pnpm Dockerfile missing: %v", e)
				}
			}
		})
	}
}

func TestDockerfilePort(t *testing.T) {
	for _, tc := range []struct {
		name, contents string
		port           int
		wantError      bool
	}{
		{"final stage", "FROM node AS build\nEXPOSE 9999\nFROM nginx\nEXPOSE 80\n", 80, false},
		{"inherited stage", "FROM node AS base\nEXPOSE 3000\nFROM base AS runtime\n", 3000, false},
		{"build stage only", "FROM node AS build\nEXPOSE 3000\nFROM nginx\n", 0, false},
		{"no declared port", "FROM node\nCMD [\"node\", \"worker.js\"]\n", 0, false},
		{"duplicate port", "FROM node\nEXPOSE 3000\nEXPOSE 3000/tcp\n", 3000, false},
		{"udp only", "FROM alpine\nEXPOSE 53/udp\n", 0, false},
		{"mixed protocols", "FROM alpine\nEXPOSE 53/udp 8080/tcp\n", 8080, false},
		{"case and continuation", "from --platform=linux/arm64 node\nexpose \\\n# comment\n 3000/tcp\n", 3000, false},
		{"continued command", "FROM node\nRUN echo \\\n EXPOSE 9999\nEXPOSE 3000\n", 3000, false},
		{"variable", "FROM node\nEXPOSE ${PORT}\n", 0, true},
		{"range", "FROM node\nEXPOSE 3000-3010\n", 0, true},
		{"multiple ports", "FROM node\nEXPOSE 3000 4000\n", 0, true},
		{"invalid port", "FROM node\nEXPOSE 65536\n", 0, true},
		{"heredoc", "FROM node\nRUN <<EOF\nEXPOSE 9000\nEOF\nEXPOSE 3000\n", 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			port, e := dockerfilePort(tc.contents)
			if (e != nil) != tc.wantError || port != tc.port {
				t.Fatalf("got port %d, error %v; want port %d, error %t", port, e, tc.port, tc.wantError)
			}
		})
	}
}
