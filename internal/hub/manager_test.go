package hub

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeRuntime struct {
	containers          map[string]Container
	volumes             map[string]bool
	events              []string
	failBuild, failDump bool
}

func fake() *fakeRuntime {
	return &fakeRuntime{containers: map[string]Container{}, volumes: map[string]bool{}}
}
func (f *fakeRuntime) StartSystem(context.Context) error { return nil }
func (f *fakeRuntime) Build(_ context.Context, _, _, tag string) error {
	f.events = append(f.events, "build:"+tag)
	if f.failBuild {
		return errors.New("build failed")
	}
	return nil
}
func (f *fakeRuntime) Network(context.Context, string) error       { return nil }
func (f *fakeRuntime) RemoveNetwork(context.Context, string) error { return nil }
func (f *fakeRuntime) Volume(_ context.Context, name string) error {
	f.volumes[name] = true
	return nil
}
func (f *fakeRuntime) RemoveVolume(_ context.Context, name string) error {
	delete(f.volumes, name)
	return nil
}
func (f *fakeRuntime) RemoveImage(context.Context, string) error { return nil }
func (f *fakeRuntime) Run(_ context.Context, s RunSpec) error {
	f.events = append(f.events, "run:"+s.Name)
	if !s.Task {
		f.containers[s.Name] = Container{IP: "192.168.64.2", Running: true}
	}
	return nil
}
func (f *fakeRuntime) Inspect(_ context.Context, name string) (Container, error) {
	v, ok := f.containers[name]
	if !ok {
		return v, ErrNotFound
	}
	return v, nil
}
func (f *fakeRuntime) Stop(_ context.Context, name string) error {
	f.events = append(f.events, "stop:"+name)
	if c, ok := f.containers[name]; ok {
		c.Running = false
		f.containers[name] = c
	}
	return nil
}
func (f *fakeRuntime) Start(_ context.Context, name string) error {
	f.events = append(f.events, "start:"+name)
	c := f.containers[name]
	c.Running = true
	c.IP = "192.168.64.99"
	f.containers[name] = c
	return nil
}
func (f *fakeRuntime) Remove(_ context.Context, name string) error {
	delete(f.containers, name)
	return nil
}
func (f *fakeRuntime) Exec(_ context.Context, name string, args []string, in io.Reader, out, stderr io.Writer) error {
	f.events = append(f.events, "exec:"+name+":"+args[0])
	if args[0] == "pg_dump" {
		if f.failDump {
			return errors.New("dump failed")
		}
		_, _ = io.WriteString(out, "database contents")
	}
	if args[0] == "pg_restore" {
		_, _ = io.Copy(io.Discard, in)
	}
	return nil
}

const testManifest = `version: 1
project: shop
services:
  postgres:
    kind: postgres
  redis:
    kind: redis
  web:
    image: web:1
    port: 3000
    http: true
    ready: ["true"]
    depends_on: [postgres, redis]
    environment:
      DATABASE_URL: '{{postgres.url}}'
    volumes:
      uploads: /uploads
`

func fixture(t *testing.T) (*Manager, *fakeRuntime, string) {
	t.Helper()
	dir := t.TempDir()
	if e := os.WriteFile(filepath.Join(dir, ".contremaitre.yaml"), []byte(testManifest), 0600); e != nil {
		t.Fatal(e)
	}
	f := fake()
	m, e := NewManager(Store{t.TempDir()}, f)
	if e != nil {
		t.Fatal(e)
	}
	return m, f, dir
}
func TestDeployForkRetainAndDelete(t *testing.T) {
	m, f, dir := fixture(t)
	ctx := context.Background()
	main, e := m.Deploy(ctx, DeployRequest{Root: dir, Branch: "main", Main: true})
	if e != nil {
		t.Fatal(e)
	}
	file := filepath.Join(m.Store.Home, "data", main.Identity.ID, "uploads", "hello.txt")
	if e = os.WriteFile(file, []byte("hello"), 0600); e != nil {
		t.Fatal(e)
	}
	branch, e := m.Deploy(ctx, DeployRequest{Root: dir, Branch: "feat", Main: false})
	if e != nil {
		t.Fatal(e)
	}
	if branch.Identity.ID == main.Identity.ID {
		t.Fatal("branch collision")
	}
	b, e := os.ReadFile(filepath.Join(m.Store.Home, "data", branch.Identity.ID, "uploads", "hello.txt"))
	if e != nil || string(b) != "hello" {
		t.Fatalf("uploads were not forked: %q %v", b, e)
	}
	if !f.containers[main.Services["web"].Container].Running {
		t.Fatal("main writer was not resumed")
	}
	events := strings.Join(f.events, "\n")
	if !strings.Contains(events, ":pg_dump") || !strings.Contains(events, ":pg_restore") {
		t.Fatal("database not cloned")
	}
	count := len(f.volumes)
	if e = m.Down(ctx, branch.Identity.ID, false); e != nil {
		t.Fatal(e)
	}
	if len(f.volumes) != count {
		t.Fatal("down deleted database")
	}
	if _, e = m.Deploy(ctx, DeployRequest{Root: dir, Branch: "feat", Main: false}); e != nil {
		t.Fatal(e)
	}
	if strings.Count(strings.Join(f.events, "\n"), ":pg_dump") != 1 {
		t.Fatal("redeploy copied main over existing data")
	}
	if e = m.Down(ctx, branch.Identity.ID, true); e != nil {
		t.Fatal(e)
	}
	if len(f.volumes) != count-1 {
		t.Fatal("explicit deletion did not delete database")
	}
	if m.State.Environments[main.Identity.ID] == nil {
		t.Fatal("deleted another environment")
	}
}
func TestFailedCloneAlwaysResumesMain(t *testing.T) {
	m, f, dir := fixture(t)
	ctx := context.Background()
	main, e := m.Deploy(ctx, DeployRequest{Root: dir, Branch: "main", Main: true})
	if e != nil {
		t.Fatal(e)
	}
	f.failDump = true
	if _, e = m.Deploy(ctx, DeployRequest{Root: dir, Branch: "feat", Main: false}); e == nil {
		t.Fatal("expected clone error")
	}
	if !f.containers[main.Services["web"].Container].Running {
		t.Fatal("main stayed paused after clone failure")
	}
}
func TestFailedBuildLeavesCurrentApplicationRunning(t *testing.T) {
	m, f, dir := fixture(t)
	ctx := context.Background()
	env, e := m.Deploy(ctx, DeployRequest{Root: dir, Branch: "main", Main: true})
	if e != nil {
		t.Fatal(e)
	}
	b := strings.Replace(testManifest, "image: web:1", "build: .", 1)
	if e = os.WriteFile(filepath.Join(dir, ".contremaitre.yaml"), []byte(b), 0600); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM scratch\n"), 0600); e != nil {
		t.Fatal(e)
	}
	f.failBuild = true
	if _, e = m.Deploy(ctx, DeployRequest{Root: dir, Branch: "main", Main: false}); e == nil {
		t.Fatal("expected build error")
	}
	if !f.containers[env.Services["web"].Container].Running || m.State.Environments[env.Identity.ID].Status != "running" {
		t.Fatal("build failure stopped running environment")
	}
}
func TestCloneStoppedMain(t *testing.T) {
	m, _, dir := fixture(t)
	ctx := context.Background()
	main, e := m.Deploy(ctx, DeployRequest{Root: dir, Branch: "main", Main: true})
	if e != nil {
		t.Fatal(e)
	}
	if e = m.Down(ctx, main.Identity.ID, false); e != nil {
		t.Fatal(e)
	}
	if _, e = m.Deploy(ctx, DeployRequest{Root: dir, Branch: "feature", Main: false}); e != nil {
		t.Fatal(e)
	}
	if m.State.Environments[main.Identity.ID].Status != "stopped" {
		t.Fatal("clone changed source lifecycle")
	}
}
func TestPruneRequiresExplicitDataDeletion(t *testing.T) {
	m, _, dir := fixture(t)
	ctx := context.Background()
	env, e := m.Deploy(ctx, DeployRequest{Root: dir, Branch: "main", Main: true})
	if e != nil {
		t.Fatal(e)
	}
	if e = m.Down(ctx, env.Identity.ID, false); e != nil {
		t.Fatal(e)
	}
	if _, e = m.Prune(ctx, false); e != nil {
		t.Fatal(e)
	}
	if m.State.Environments[env.Identity.ID] == nil {
		t.Fatal("prune silently deleted data")
	}
	if _, e = m.Prune(ctx, true); e != nil {
		t.Fatal(e)
	}
	if len(m.State.Environments) != 0 {
		t.Fatal("explicit prune left stopped environment")
	}
}
func TestPublicStateOmitsCredentials(t *testing.T) {
	m, _, dir := fixture(t)
	env, e := m.Deploy(context.Background(), DeployRequest{Root: dir, Branch: "main", Main: false})
	if e != nil {
		t.Fatal(e)
	}
	if len(env.Credentials) > 0 || len(env.Services["web"].Spec.Environment) > 0 {
		t.Fatal("public output leaked environment secrets")
	}
	info, e := os.Stat(filepath.Join(m.Store.Home, "state.json"))
	if e != nil || info.Mode().Perm() != 0600 {
		t.Fatal("state must be private")
	}
}

func TestPostgresDataDirectoryIsBelowVolumeRoot(t *testing.T) {
	m, _, dir := fixture(t)
	env, e := m.Deploy(context.Background(), DeployRequest{Root: dir, Branch: "main", Main: false})
	if e != nil {
		t.Fatal(e)
	}
	actual := m.State.Environments[env.Identity.ID]
	values, e := m.serviceEnv(actual, actual.Services["postgres"])
	if e != nil {
		t.Fatal(e)
	}
	if values["PGDATA"] != "/var/lib/postgresql/data/pgdata" {
		t.Fatal("Postgres initdb rejects the ext4 volume's lost+found directory")
	}
}

func TestCloneDoesNotReseedExistingMainData(t *testing.T) {
	m, _, dir := fixture(t)
	ctx := context.Background()
	if _, e := m.Deploy(ctx, DeployRequest{Root: dir, Branch: "main", Main: true}); e != nil {
		t.Fatal(e)
	}
	env, e := m.Deploy(ctx, DeployRequest{Root: dir, Branch: "feat", Main: false})
	if e != nil {
		t.Fatal(e)
	}
	if !env.Services["web"].Initialized {
		t.Fatal("fork lost initialization state")
	}
}

func TestCloneRefreshesMainUpstreamAfterRestart(t *testing.T) {
	m, f, dir := fixture(t)
	ctx := context.Background()
	main, e := m.Deploy(ctx, DeployRequest{Root: dir, Branch: "main", Main: true})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = m.Deploy(ctx, DeployRequest{Root: dir, Branch: "feat", Main: false}); e != nil {
		t.Fatal(e)
	}
	s := m.State.Environments[main.Identity.ID].Services["web"]
	if s.IP != f.containers[s.Container].IP {
		t.Fatal("main route retains IP from before clone")
	}
}

func TestInvalidEnvironmentReferenceDoesNotStopRunningApp(t *testing.T) {
	m, f, dir := fixture(t)
	ctx := context.Background()
	env, e := m.Deploy(ctx, DeployRequest{Root: dir, Branch: "main", Main: true})
	if e != nil {
		t.Fatal(e)
	}
	bad := strings.ReplaceAll(testManifest, "{{postgres.url}}", "{{unknown.url}}")
	if e = os.WriteFile(filepath.Join(dir, ".contremaitre.yaml"), []byte(bad), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = m.Deploy(ctx, DeployRequest{Root: dir, Branch: "main", Main: false}); e == nil {
		t.Fatal("unknown service reference accepted")
	}
	if !f.containers[env.Services["web"].Container].Running {
		t.Fatal("invalid configuration stopped application")
	}
}
func TestFrameworkURLUsesReservedTunnel(t *testing.T) {
	m, _, dir := fixture(t)
	ctx := context.Background()
	env, e := m.Deploy(ctx, DeployRequest{Root: dir, Branch: "main", Main: true})
	if e != nil {
		t.Fatal(e)
	}
	actual := m.State.Environments[env.Identity.ID]
	s := actual.Services["web"]
	s.Spec.Environment["ORIGIN"] = "{{contremaitre.url}}"
	actual.Tunnels["web"] = &TunnelReservation{URL: "https://preview.example.com"}
	values, e := m.serviceEnv(actual, s)
	if e != nil || values["ORIGIN"] != "https://preview.example.com" {
		t.Fatal("framework origin mapping failed", e)
	}
}

func TestStopRetainsIncompleteDeletionState(t *testing.T) {
	m, _, dir := fixture(t)
	env, e := m.Deploy(context.Background(), DeployRequest{Root: dir, Branch: "main", Main: false})
	if e != nil {
		t.Fatal(e)
	}
	m.State.Environments[env.Identity.ID].Status = "deleting"
	if e = m.StopAll(context.Background()); e != nil {
		t.Fatal(e)
	}
	if m.State.Environments[env.Identity.ID].Status != "deleting" {
		t.Fatal("stop made partially deleted data deployable")
	}
}

func TestLocalURLReferencesDoNotRequireDependencyCycles(t *testing.T) {
	root := t.TempDir()
	manifest := []byte("version: 1\nproject: urls\nservices:\n  api:\n    image: example\n    http: true\n    port: 3000\n    ready: [echo]\n    environment:\n      ALLOWED_ORIGIN: '{{web.local_url}}'\n  web:\n    image: example\n    http: true\n    port: 3000\n    ready: [echo]\n    depends_on: [api]\n")
	if err := os.WriteFile(filepath.Join(root, ".contremaitre.yaml"), manifest, 0600); err != nil {
		t.Fatal(err)
	}
	m, err := NewManager(Store{t.TempDir()}, fake())
	if err != nil {
		t.Fatal(err)
	}
	env, err := m.Deploy(context.Background(), DeployRequest{Root: root, Branch: "main"})
	if err != nil {
		t.Fatal(err)
	}
	internal := m.State.Environments[env.Identity.ID]
	values, err := m.serviceEnv(internal, internal.Services["api"])
	if err != nil {
		t.Fatal(err)
	}
	if values["ALLOWED_ORIGIN"] != m.LocalURL(internal, "web") {
		t.Fatal(values["ALLOWED_ORIGIN"])
	}
}

// Persisted build records must survive a hub restart, and --rebuild must bypass
// them without losing ownership of the images for prune/down.
type cachedFakeRuntime struct {
	*fakeRuntime
	previous []BuildRecord
}

func (f *cachedFakeRuntime) BuildCached(_ context.Context, _, _, tag string, previous BuildRecord) (BuildRecord, error) {
	f.previous = append(f.previous, previous)
	if previous.Image != "" {
		return previous, nil
	}
	return BuildRecord{Digest: "source", Image: tag}, nil
}
func TestDeployPersistsBuildCacheAndHonorsRebuild(t *testing.T) {
	m, f, root := fixture(t)
	runtime := &cachedFakeRuntime{fakeRuntime: f}
	m.Runtime = runtime
	manifest := strings.Replace(testManifest, "image: web:1", "build: .", 1)
	if err := os.WriteFile(filepath.Join(root, ".contremaitre.yaml"), []byte(manifest), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "Dockerfile"), []byte("FROM scratch"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	first, err := m.Deploy(ctx, DeployRequest{Root: root, Branch: "main"})
	if err != nil {
		t.Fatal(err)
	}
	firstImage := first.Services["web"].Image
	m, err = NewManager(m.Store, runtime)
	if err != nil {
		t.Fatal(err)
	}
	second, err := m.Deploy(ctx, DeployRequest{Root: root, Branch: "main"})
	if err != nil {
		t.Fatal(err)
	}
	if second.Services["web"].Image != firstImage || len(second.Images) != 1 || runtime.previous[1].Image != firstImage {
		t.Fatal("lost persisted cache or recorded a nonexistent image")
	}
	third, err := m.Deploy(ctx, DeployRequest{Root: root, Branch: "main", Rebuild: true})
	if err != nil {
		t.Fatal(err)
	}
	if third.Services["web"].Image == firstImage || runtime.previous[2].Image != "" || len(third.Images) != 2 {
		t.Fatal("rebuild did not produce a tracked replacement image")
	}
}
