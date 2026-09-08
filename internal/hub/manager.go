package hub

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type Manager struct {
	mu       sync.RWMutex
	Store    Store
	State    *State
	Runtime  Runtime
	Tunnel   *TunnelManager
	HTTPPort int
	Routes   *Routes
}
type DeployRequest struct {
	Root, Branch string
	Main         bool
	Rebuild      bool
}

func NewManager(store Store, r Runtime) (*Manager, error) {
	s, e := store.Load()
	if e != nil {
		return nil, e
	}
	return &Manager{Store: store, State: s, Runtime: r, HTTPPort: 80}, nil
}
func (m *Manager) save() error {
	e := m.Store.Save(m.State)
	if e == nil {
		m.publishRoutes()
	}
	return e
}
func (m *Manager) Resolve(selector string) (*Environment, error) {
	if e := m.State.Environments[selector]; e != nil {
		return e, nil
	}
	var match *Environment
	for _, e := range m.State.Environments {
		if selector == e.Identity.Name || selector == e.Identity.Host || selector == e.Identity.Project {
			if match != nil {
				return nil, fmt.Errorf("ambiguous environment %q; use an ID or full name", selector)
			}
			match = e
		}
	}
	if match != nil {
		return match, nil
	}
	if strings.HasSuffix(selector, "/main") {
		id := m.State.Main[strings.TrimSuffix(selector, "/main")]
		if e := m.State.Environments[id]; e != nil {
			return e, nil
		}
	}
	return nil, fmt.Errorf("environment %q not found", selector)
}
func (m *Manager) List() []*Environment {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := []*Environment{}
	for _, id := range sortedKeys(m.State.Environments) {
		out = append(out, m.view(m.State.Environments[id]))
	}
	return out
}
func (m *Manager) Current(ctx context.Context, root, branch string) (Identity, error) {
	manifest, _, e := LoadManifest(root)
	if e != nil {
		return Identity{}, e
	}
	return DetectIdentity(ctx, root, manifest.Project, branch)
}
func (m *Manager) Deploy(ctx context.Context, req DeployRequest) (result *Environment, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	progress(ctx, "Reading project configuration")
	root, e := filepath.Abs(req.Root)
	if e != nil {
		return nil, e
	}
	manifest, _, e := LoadManifest(root)
	if e != nil {
		return nil, e
	}
	if manifest.Driver != nil {
		return m.deployDriver(ctx, req, root, manifest)
	}
	manifest, e = prepareManifest(root, manifest)
	if e != nil {
		return nil, e
	}
	identity, e := DetectIdentity(ctx, root, manifest.Project, req.Branch)
	if e != nil {
		return nil, e
	}
	env := m.State.Environments[identity.ID]
	if env != nil && env.Driver != nil {
		return nil, fmt.Errorf("environment uses a project driver; explicitly delete its data before changing runtime")
	}
	if env != nil && env.Status == "deleting" {
		return nil, fmt.Errorf("finish down --delete-data before redeploying this environment")
	}
	fresh := env == nil
	if fresh {
		env = &Environment{Identity: identity, Root: root, Status: "pending", Network: m.Store.Namespace() + "-" + identity.ID, Services: map[string]*ServiceState{}, Credentials: map[string]string{}, Tunnels: map[string]*TunnelReservation{}, CreatedAt: time.Now().UTC()}
		m.State.Environments[identity.ID] = env
	}
	if req.Main {
		if old := m.State.Main[manifest.Project]; old != "" && old != identity.ID {
			return nil, fmt.Errorf("main already designated; use main --env to change it explicitly")
		}
		m.State.Main[manifest.Project] = identity.ID
	}
	if identity.Branch == "main" && m.State.Main[manifest.Project] == "" {
		m.State.Main[manifest.Project] = identity.ID
	}
	if e = m.save(); e != nil {
		return nil, e
	}
	previousStatus := env.Status
	mutated := false
	defer func() {
		if err != nil {
			env.Error = err.Error()
			if mutated {
				env.Status = "failed"
			} else {
				env.Status = previousStatus
			}
			env.UpdatedAt = time.Now().UTC()
			if se := m.save(); se != nil {
				err = errors.Join(err, se)
			}
		}
	}()
	order, _ := manifest.Order()
	images := map[string]string{}
	// All builds finish before existing services are stopped.
	for _, name := range order {
		s := manifest.Services[name]
		if s.Build == "" {
			images[name] = s.Image
			continue
		}
		buildRoot, e := SafePath(root, s.Build)
		if e != nil {
			return nil, e
		}
		df := s.Dockerfile
		if df == "" {
			df = filepath.Join(s.Build, "Dockerfile")
		}
		dockerfile, e := SafePath(root, df)
		if e != nil {
			return nil, e
		}
		tag := "cm-" + identity.ID + "-" + name + ":" + fmt.Sprint(time.Now().UnixNano())
		env.Images = append(env.Images, tag)
		if e = m.save(); e != nil {
			return nil, e
		}
		progress(ctx, "Building %s", name)
		if builder, ok := m.Runtime.(interface {
			BuildCached(context.Context, string, string, string, BuildRecord) (BuildRecord, error)
		}); ok {
			previous := env.Builds[name]
			if req.Rebuild {
				previous = BuildRecord{}
			}
			built, buildErr := builder.BuildCached(ctx, buildRoot, dockerfile, tag, previous)
			if buildErr != nil {
				return nil, fmt.Errorf("build %s: %w", name, buildErr)
			}
			if env.Builds == nil {
				env.Builds = map[string]BuildRecord{}
			}
			env.Builds[name] = built
			images[name] = built.Image
			if built.Image != tag {
				env.Images = env.Images[:len(env.Images)-1]
			}
			if e = m.save(); e != nil {
				return nil, e
			}
		} else {
			if e = m.Runtime.Build(ctx, buildRoot, dockerfile, tag); e != nil {
				return nil, fmt.Errorf("build %s: %w", name, e)
			}
			images[name] = tag
		}
	}
	progress(ctx, "Preparing network for %s", identity.Name)
	if e = m.Runtime.Network(ctx, env.Network); e != nil {
		return nil, e
	}
	// Do not silently migrate database versions or discard storage when a service changes kind.
	for name, old := range env.Services {
		if next, ok := manifest.Services[name]; ok && old.Spec.Kind != "app" && (old.Spec.Kind != next.Kind || old.Image != images[name]) {
			return nil, fmt.Errorf("%s: database kind/image changed; use an explicit data migration or delete this environment", name)
		}
	}
	mutated = true
	env.Status = "deploying"
	env.Error = ""
	if e = m.save(); e != nil {
		return nil, e
	}
	for _, name := range sortedKeys(env.Services) {
		if e = m.Runtime.Stop(ctx, env.Services[name].Container); e != nil {
			return nil, e
		}
		if e = m.Runtime.Remove(ctx, env.Services[name].Container); e != nil {
			return nil, e
		}
	}
	// Recreate an emptied vmnet network: retained inactive networks can lose their host bridge.
	if len(env.Services) > 0 {
		if e = m.Runtime.RemoveNetwork(ctx, env.Network); e != nil {
			return nil, e
		}
		if e = m.Runtime.Network(ctx, env.Network); e != nil {
			return nil, e
		}
	}
	next := map[string]*ServiceState{}
	for _, name := range order {
		s := manifest.Services[name]
		ss := &ServiceState{Name: name, Container: resourceName(env.Network, name), Image: images[name], Port: s.Port, HTTP: s.HTTP, Spec: s}
		if old := env.Services[name]; old != nil {
			ss.Initialized = old.Initialized
			ss.Volume = old.Volume
		}
		next[name] = ss
	}
	env.Services = next
	env.Root = root
	if e = m.save(); e != nil {
		return nil, e
	}
	for _, name := range order {
		ss := env.Services[name]
		if ss.Spec.Kind == "app" {
			continue
		}
		if e = m.startService(ctx, env, ss, false); e != nil {
			return nil, e
		}
	}
	if !env.CloneComplete {
		source := m.State.Environments[m.State.Main[identity.Project]]
		if source != nil && source != env {
			progress(ctx, "Forking data from %s", source.Identity.Name)
			if e = m.clone(ctx, source, env); e != nil {
				return nil, e
			}
		}
		env.CloneComplete = true
		if e = m.save(); e != nil {
			return nil, e
		}
	}
	for _, name := range order {
		ss := env.Services[name]
		if ss.Spec.Kind != "app" {
			continue
		}
		if e = m.startService(ctx, env, ss, true); e != nil {
			return nil, e
		}
	}
	env.Status = "running"
	env.Error = ""
	env.UpdatedAt = time.Now().UTC()
	if e = m.save(); e != nil {
		return nil, e
	}
	return m.view(env), nil
}
func (m *Manager) serviceEnv(env *Environment, s *ServiceState) (map[string]string, error) {
	values := map[string]string{}
	for k, v := range s.RawEnvironment {
		values[k] = v
	}
	if s.RawEnvironment == nil && s.Spec.EnvFile != "" {
		p, e := SafePath(env.Root, s.Spec.EnvFile)
		if e != nil {
			return nil, e
		}
		f, e := os.Open(p)
		if e != nil {
			return nil, e
		}
		defer f.Close()
		scan := bufio.NewScanner(f)
		for scan.Scan() {
			line := strings.TrimSpace(scan.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			k, v, ok := strings.Cut(line, "=")
			if !ok {
				return nil, fmt.Errorf("invalid env_file line")
			}
			values[strings.TrimSpace(k)] = strings.Trim(v, "\"'")
		}
		if e = scan.Err(); e != nil {
			return nil, e
		}
	}
	for k, v := range s.Spec.Environment {
		values[k] = v
	}
	if s.RawEnvironment == nil {
		s.RawEnvironment = map[string]string{}
		for k, v := range values {
			s.RawEnvironment[k] = v
		}
		if e := m.save(); e != nil {
			return nil, e
		}
	}
	if s.Spec.Kind == "postgres" {
		password := env.Credentials[s.Name]
		if password == "" {
			b := make([]byte, 24)
			if _, e := rand.Read(b); e != nil {
				return nil, e
			}
			password = hex.EncodeToString(b)
			env.Credentials[s.Name] = password
			if e := m.save(); e != nil {
				return nil, e
			}
		}
		values["POSTGRES_USER"] = "app"
		values["POSTGRES_DB"] = "app"
		values["PGDATA"] = "/var/lib/postgresql/data/pgdata"
		values["POSTGRES_PASSWORD"] = password
	}
	ref := regexp.MustCompile(`\{\{([a-z][a-z0-9-]*)\.(host|port|url|local_url)\}\}`)
	for k, v := range values {
		baseURL := m.LocalURL(env, s.Name)
		if t := env.Tunnels[s.Name]; t != nil {
			baseURL = t.URL
		}
		v = strings.ReplaceAll(v, "{{contremaitre.url}}", baseURL)
		v = strings.ReplaceAll(v, "{{contremaitre.local_url}}", m.LocalURL(env, s.Name))
		var resolveErr error
		values[k] = ref.ReplaceAllStringFunc(v, func(token string) string {
			parts := ref.FindStringSubmatch(token)
			dep := env.Services[parts[1]]
			if dep != nil && parts[2] == "local_url" {
				return m.LocalURL(env, dep.Name)
			}
			if dep == nil || dep.IP == "" {
				resolveErr = fmt.Errorf("%s: %s is not ready; declare depends_on", s.Name, parts[1])
				return token
			}
			switch parts[2] {
			case "host":
				return dep.IP
			case "port":
				return fmt.Sprint(dep.Port)
			case "url":
				if dep.Spec.Kind == "postgres" {
					u := url.URL{Scheme: "postgresql", User: url.UserPassword("app", env.Credentials[dep.Name]), Host: net.JoinHostPort(dep.IP, fmt.Sprint(dep.Port)), Path: "/app", RawQuery: "sslmode=disable"}
					return u.String()
				}
				if dep.Spec.Kind == "redis" {
					return "redis://" + net.JoinHostPort(dep.IP, fmt.Sprint(dep.Port)) + "/0"
				}
				return "http://" + net.JoinHostPort(dep.IP, fmt.Sprint(dep.Port))
			}
			return token
		})
		if resolveErr != nil {
			return nil, resolveErr
		}
		if strings.Contains(values[k], "{{") {
			return nil, fmt.Errorf("%s: unsupported environment reference", k)
		}
	}
	values["CONTREMAITRE_ENVIRONMENT"] = env.Identity.ID
	values["CONTREMAITRE_LOCAL_URL"] = m.LocalURL(env, s.Name)
	if t := env.Tunnels[s.Name]; t != nil {
		values["CONTREMAITRE_PUBLIC_URL"] = t.URL
	}
	return values, nil
}
func (m *Manager) volumes(ctx context.Context, env *Environment, s *ServiceState) (map[string]string, error) {
	out := map[string]string{}
	if s.Spec.Kind == "postgres" {
		if s.Volume == "" {
			s.Volume = resourceName(env.Network, s.Name) + "-data"
			env.Volumes = append(env.Volumes, s.Volume)
			if e := m.save(); e != nil {
				return nil, e
			}
		}
		if e := m.Runtime.Volume(ctx, s.Volume); e != nil {
			return nil, e
		}
		out[s.Volume] = "/var/lib/postgresql/data"
	}
	for name, target := range s.Spec.Volumes {
		p := filepath.Join(m.Store.Home, "data", env.Identity.ID, name)
		if e := os.MkdirAll(p, 0755); e != nil {
			return nil, e
		}
		out[p] = target
	}
	return out, nil
}
func (m *Manager) startService(ctx context.Context, env *Environment, s *ServiceState, initialize bool) error {
	values, e := m.serviceEnv(env, s)
	if e != nil {
		return e
	}
	file, e := envFile(filepath.Join(m.Store.Home, "tmp"), values)
	if e != nil {
		return e
	}
	defer os.Remove(file)
	volumes, e := m.volumes(ctx, env, s)
	if e != nil {
		return e
	}
	spec := RunSpec{Name: s.Container, Image: s.Image, Network: env.Network, EnvFile: file, Service: s.Spec, Volumes: volumes}
	if initialize {
		commands := [][]string{}
		if !s.Initialized && len(s.Spec.Init) > 0 {
			commands = append(commands, s.Spec.Init)
		}
		if len(s.Spec.Migrate) > 0 {
			commands = append(commands, s.Spec.Migrate)
		}
		for _, command := range commands {
			task := spec
			task.Name += "-task"
			task.Service.Command = command
			task.Task = true
			if e = m.Runtime.Remove(ctx, task.Name); e != nil {
				return e
			}
			progress(ctx, "%s: running initialization/migration", s.Name)
			if e = m.Runtime.Run(ctx, task); e != nil {
				return fmt.Errorf("%s initialization/migration: %w", s.Name, e)
			}
		}
	}
	progress(ctx, "Starting %s", s.Name)
	if e = m.Runtime.Run(ctx, spec); e != nil {
		return fmt.Errorf("start %s: %w", s.Name, e)
	}
	if e = m.waitReady(ctx, s); e != nil {
		return e
	}
	progress(ctx, "%s: ready", s.Name)
	s.Initialized = true
	return m.save()
}
func (m *Manager) waitReady(ctx context.Context, s *ServiceState) error {
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	progress(ctx, "%s: waiting for readiness", s.Name)
	if logger, ok := m.Runtime.(interface {
		Logs(context.Context, string, io.Writer) error
	}); ok {
		done := make(chan struct{})
		go func() { defer close(done); _ = logger.Logs(ctx, s.Container, deploymentOutput(ctx)) }()
		defer func() { cancel(); <-done }()
	}
	var last error
	for {
		v, e := m.Runtime.Inspect(ctx, s.Container)
		if e == nil && !v.Running {
			return fmt.Errorf("%s exited before becoming ready; run contremaitre logs %s", s.Name, s.Name)
		}
		if e == nil && v.Running && v.IP != "" {
			s.IP = v.IP
			ready := s.Spec.Ready
			if s.Spec.Kind == "postgres" {
				ready = []string{"pg_isready", "-U", "app", "-d", "app"}
			}
			if s.Spec.Kind == "redis" {
				ready = []string{"redis-cli", "ping"}
			}
			if len(ready) > 0 {
				e = m.Runtime.Exec(ctx, s.Container, ready, nil, io.Discard, io.Discard)
			} else if s.Port > 0 {
				var conn net.Conn
				conn, e = net.DialTimeout("tcp", net.JoinHostPort(s.IP, fmt.Sprint(s.Port)), time.Second)
				if e == nil {
					conn.Close()
				}
			}
			if e == nil {
				return nil
			}
		}
		last = e
		select {
		case <-ctx.Done():
			return fmt.Errorf("%s did not become ready: %w (%v)", s.Name, ctx.Err(), last)
		case <-time.After(250 * time.Millisecond):
		}
	}
}
func (m *Manager) LocalURL(e *Environment, service string) string {
	if s := e.Services[service]; s != nil && s.URL != "" {
		return s.URL
	}
	host := e.Identity.Host
	first := ""
	for _, n := range sortedKeys(e.Services) {
		if e.Services[n].HTTP {
			first = n
			break
		}
	}
	if first != service {
		host = service + "." + host
	}
	if m.HTTPPort != 80 {
		host = net.JoinHostPort(host, fmt.Sprint(m.HTTPPort))
	}
	return "http://" + host
}
func (m *Manager) SetMain(selector string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, err := m.Resolve(selector)
	if err != nil {
		return err
	}
	m.State.Main[e.Identity.Project] = e.Identity.ID
	return m.save()
}
func (m *Manager) Down(ctx context.Context, selector string, deleteData bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	env, e := m.Resolve(selector)
	if e != nil {
		return e
	}
	return m.down(ctx, env, deleteData)
}
func (m *Manager) down(ctx context.Context, env *Environment, deleteData bool) error {
	if env.Driver != nil {
		return m.downDriver(ctx, env, deleteData)
	}
	wasDeleting := env.Status == "deleting"
	var tunnelErr error
	if m.Tunnel != nil {
		for _, name := range sortedKeys(env.Tunnels) {
			if e := m.Tunnel.Stop(ctx, env, name, deleteData); e != nil {
				tunnelErr = errors.Join(tunnelErr, e)
			}
		}
	}
	env.Status = "stopping"
	if e := m.save(); e != nil {
		return e
	}
	for _, name := range sortedKeys(env.Services) {
		s := env.Services[name]
		if e := m.Runtime.Stop(ctx, s.Container); e != nil {
			return e
		}
		if e := m.Runtime.Remove(ctx, s.Container); e != nil {
			return e
		}
		if e := m.Runtime.Remove(ctx, s.Container+"-task"); e != nil {
			return e
		}
		s.IP = ""
	}
	env.Status = "stopped"
	if wasDeleting {
		env.Status = "deleting"
	}
	env.UpdatedAt = time.Now().UTC()
	if e := m.save(); e != nil {
		return e
	}
	if deleteData && tunnelErr != nil {
		return tunnelErr
	}
	if deleteData {
		env.Status = "deleting"
		if e := m.save(); e != nil {
			return e
		}
		for len(env.Volumes) > 0 {
			v := env.Volumes[0]
			if e := m.Runtime.RemoveVolume(ctx, v); e != nil {
				return e
			}
			env.Volumes = env.Volumes[1:]
			if e := m.save(); e != nil {
				return e
			}
		}
		if e := os.RemoveAll(filepath.Join(m.Store.Home, "data", env.Identity.ID)); e != nil {
			return e
		}
		if e := m.Runtime.RemoveNetwork(ctx, env.Network); e != nil {
			return e
		}
		for _, image := range env.Images {
			if e := m.Runtime.RemoveImage(ctx, image); e != nil {
				return e
			}
		}
		delete(m.State.Environments, env.Identity.ID)
		if m.State.Main[env.Identity.Project] == env.Identity.ID {
			delete(m.State.Main, env.Identity.Project)
		}
	}
	return errors.Join(tunnelErr, m.save())
}
func (m *Manager) StopAll(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	var errs []error
	for _, id := range sortedKeys(m.State.Environments) {
		if e := m.down(ctx, m.State.Environments[id], false); e != nil {
			errs = append(errs, e)
		}
	}
	return errors.Join(errs...)
}
func (m *Manager) Prune(ctx context.Context, deleteData bool) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	removed := []string{}
	for _, id := range sortedKeys(m.State.Environments) {
		env := m.State.Environments[id]
		if deleteData && env.Status == "stopped" {
			if len(env.Tunnels) > 0 {
				continue
			}
			if e := m.down(ctx, env, true); e != nil {
				return removed, e
			}
			removed = append(removed, env.Identity.Name)
			continue
		}
		keep := []string{}
		for _, image := range env.Images {
			used := false
			for _, s := range env.Services {
				if s.Image == image {
					used = true
				}
			}
			if used {
				keep = append(keep, image)
			} else {
				if e := m.Runtime.RemoveImage(ctx, image); e != nil {
					return removed, e
				}
				removed = append(removed, image)
			}
		}
		env.Images = keep
	}
	return removed, m.save()
}

func (m *Manager) view(env *Environment) *Environment {
	out := publicEnvironment(env)
	if m.Tunnel != nil {
		for name, t := range out.Tunnels {
			t.Connected = m.Tunnel.Running(env.Identity.ID, name)
		}
	}
	return out
}
