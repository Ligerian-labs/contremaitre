package hub

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// ProjectDriver is a trusted, self-contained host executable owned by a project.
// Contremaitre freezes the executable at deploy time so down still works after
// the source checkout is removed or changed.
type ProjectDriver struct {
	Executable     string `yaml:"executable" json:"executable"`
	TimeoutSeconds int    `yaml:"timeout_seconds,omitempty" json:"timeout_seconds"`
}
type DriverContext struct {
	ID             string `json:"id"`
	Project        string `json:"project"`
	Root           string `json:"root"`
	StateDirectory string `json:"state_directory"`
	ResourcePrefix string `json:"resource_prefix"`
	Host           string `json:"host"`
}
type DriverRequest struct {
	Version     int            `json:"version"`
	Operation   string         `json:"operation"`
	Environment DriverContext  `json:"environment"`
	Source      *DriverContext `json:"source,omitempty"`
	Service     string         `json:"service,omitempty"`
	Arguments   []string       `json:"arguments,omitempty"`
}
type DriverService struct {
	Host string `json:"host,omitempty"`
	Port int    `json:"port,omitempty"`
	HTTP bool   `json:"http,omitempty"`
	URL  string `json:"url,omitempty"`
}
type DriverReply struct {
	Version  int                      `json:"version"`
	Status   string                   `json:"status"`
	Services map[string]DriverService `json:"services,omitempty"`
}

func driverContext(env *Environment) DriverContext {
	return DriverContext{env.Identity.ID, env.Identity.Project, env.Root, env.DriverDirectory, env.Network, env.Identity.Host}
}
func driverRequest(env *Environment, operation string, source *Environment) DriverRequest {
	r := DriverRequest{Version: 1, Operation: operation, Environment: driverContext(env)}
	if source != nil {
		s := driverContext(source)
		r.Source = &s
	}
	return r
}

// Cancellation terminates the complete process group, including kubectl/Helm
// children. The driver must checkpoint recovery state before stopping writers.
func driverCommand(ctx context.Context, env *Environment, request DriverRequest) (*exec.Cmd, func(), error) {
	if env.Driver == nil || env.DriverDirectory == "" {
		return nil, nil, fmt.Errorf("project driver is not configured")
	}
	b, e := json.Marshal(request)
	if e != nil {
		return nil, nil, e
	}
	f, e := os.CreateTemp(env.DriverDirectory, "request-*.json")
	if e != nil {
		return nil, nil, e
	}
	cleanup := func() { _ = os.Remove(f.Name()) }
	if _, e = f.Write(b); e != nil {
		f.Close()
		cleanup()
		return nil, nil, e
	}
	if e = f.Close(); e != nil {
		cleanup()
		return nil, nil, e
	}
	c := exec.CommandContext(ctx, env.Driver.Executable)
	c.Dir = env.DriverDirectory
	c.Env = append(os.Environ(), "CONTREMAITRE_REQUEST="+f.Name())
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var force *time.Timer
	c.Cancel = func() error {
		force = time.AfterFunc(4*time.Second, func() { _ = syscall.Kill(-c.Process.Pid, syscall.SIGKILL) })
		return syscall.Kill(-c.Process.Pid, syscall.SIGTERM)
	}
	c.WaitDelay = 5 * time.Second
	return c, func() {
		if force != nil {
			force.Stop()
		}
		cleanup()
	}, nil
}

type boundedBuffer struct{ bytes.Buffer }

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 1024*1024 {
		return 0, fmt.Errorf("driver response exceeds 1 MiB")
	}
	return b.Buffer.Write(p)
}
func invokeDriver(ctx context.Context, env *Environment, operation string, source *Environment) (DriverReply, error) {
	progress(ctx, "Driver %s: %s", env.Identity.Name, operation)
	ctx, cancel := context.WithTimeout(ctx, time.Duration(env.Driver.TimeoutSeconds)*time.Second)
	defer cancel()
	c, cleanup, e := driverCommand(ctx, env, driverRequest(env, operation, source))
	if e != nil {
		return DriverReply{}, e
	}
	defer cleanup()
	logPath := filepath.Join(env.DriverDirectory, "driver.log")
	if info, e := os.Stat(logPath); e == nil && info.Size() > 10*1024*1024 {
		_ = os.Rename(logPath, logPath+".1")
	}
	log, e := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if e != nil {
		return DriverReply{}, e
	}
	defer log.Close()
	progress(ctx, "Driver log: %s", logPath)
	var out boundedBuffer
	c.Stdout, c.Stderr = &out, io.MultiWriter(log, progressOutput(ctx))
	if e = c.Run(); e != nil {
		return DriverReply{}, fmt.Errorf("project driver %s failed (%w); see %s", operation, e, logPath)
	}
	var reply DriverReply
	d := json.NewDecoder(&out)
	d.DisallowUnknownFields()
	if e = d.Decode(&reply); e != nil {
		return reply, fmt.Errorf("invalid project driver response; expected the version 1 JSON schema")
	}
	var extra any
	if e = d.Decode(&extra); e != io.EOF {
		return reply, fmt.Errorf("project driver must return one JSON response")
	}
	if reply.Version != 1 {
		return reply, fmt.Errorf("unsupported project driver protocol")
	}
	return reply, nil
}
func DriverInteractive(ctx context.Context, env *Environment, operation, service string, args []string, in io.Reader, out, stderr io.Writer) error {
	if operation != "exec" && operation != "logs" && operation != "proxy" {
		return fmt.Errorf("unsupported interactive driver operation")
	}
	r := driverRequest(env, operation, nil)
	r.Service = service
	r.Arguments = args
	c, cleanup, e := driverCommand(ctx, env, r)
	if e != nil {
		return e
	}
	defer cleanup()
	c.Stdin, c.Stdout, c.Stderr = in, out, stderr
	return c.Run()
}
func applyDriverReply(env *Environment, reply DriverReply) error {
	if reply.Status != "running" && reply.Status != "stopped" {
		return fmt.Errorf("driver status must be running or stopped")
	}
	if reply.Status == "running" && len(reply.Services) == 0 {
		return fmt.Errorf("running project driver returned no services")
	}
	services := map[string]*ServiceState{}
	for name, s := range reply.Services {
		if !validName.MatchString(name) || s.Port < 0 || s.Port > 65535 {
			return fmt.Errorf("project driver returned an invalid service name or port")
		}
		if s.Host != "" {
			ip := net.ParseIP(s.Host)
			if ip == nil || !ip.IsLoopback() {
				return fmt.Errorf("driver service %s must use a loopback upstream", name)
			}
		}
		if s.HTTP && (s.Host == "" || s.Port == 0) {
			return fmt.Errorf("HTTP driver service %s needs an upstream", name)
		}
		if s.URL != "" {
			u, e := url.Parse(s.URL)
			if e != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || (u.Hostname() != env.Identity.Host && !strings.HasSuffix(u.Hostname(), "."+env.Identity.Host)) {
				return fmt.Errorf("driver service %s URL must use its environment hostname", name)
			}
		}
		services[name] = &ServiceState{Name: name, IP: s.Host, Port: s.Port, HTTP: s.HTTP, URL: s.URL, Spec: Service{Kind: "app"}}
	}
	if reply.Status == "running" {
		env.Services = services
	} else {
		for _, s := range env.Services {
			s.IP = ""
		}
	}
	env.Status = reply.Status
	return nil
}
func (m *Manager) deployDriver(ctx context.Context, req DeployRequest, root string, manifest Manifest) (_ *Environment, err error) {
	identity, e := DetectIdentity(ctx, root, manifest.Project, req.Branch)
	if e != nil {
		return nil, e
	}
	env := m.State.Environments[identity.ID]
	if env != nil && (env.Driver == nil || env.Status == "deleting") {
		return nil, fmt.Errorf("existing environment must be explicitly deleted before changing runtime")
	}
	if req.Main && m.State.Main[manifest.Project] != "" && m.State.Main[manifest.Project] != identity.ID {
		return nil, fmt.Errorf("main already designated; use main --env to change it explicitly")
	}
	executable, e := SafePath(root, manifest.Driver.Executable)
	if e != nil {
		return nil, e
	}
	info, e := os.Stat(executable)
	if e != nil {
		return nil, e
	}
	if !info.Mode().IsRegular() || info.Mode()&0111 == 0 {
		return nil, fmt.Errorf("project driver must be an executable regular file")
	}
	b, e := os.ReadFile(executable)
	if e != nil {
		return nil, e
	}
	stateDir := filepath.Join(m.Store.Home, "drivers", identity.ID)
	hash := sha256.Sum256(b)
	snapshot := filepath.Join(stateDir, fmt.Sprintf("driver-%x", hash[:8]))
	if e = atomicWrite(snapshot, b, 0700); e != nil {
		return nil, e
	}
	driver := *manifest.Driver
	driver.Executable = snapshot
	candidate := &Environment{Identity: identity, Root: root, Network: m.Store.Namespace() + "-" + identity.ID, Driver: &driver, DriverDirectory: stateDir, Status: "pending", Services: map[string]*ServiceState{}, Tunnels: map[string]*TunnelReservation{}, CreatedAt: time.Now().UTC()}
	// Preflight is read-only: reject missing tools/configuration before replacing
	// a running environment or establishing a new main source.
	if _, e = invokeDriver(ctx, candidate, "preflight", nil); e != nil {
		return nil, e
	}
	if env == nil {
		env = candidate
		m.State.Environments[identity.ID] = env
	} else {
		env.Driver = &driver
		env.Root = root
	}
	previousStatus := env.Status
	env.Status = "deploying"
	env.Error = ""
	if e = m.save(); e != nil {
		return nil, e
	}
	defer func() {
		if err != nil {
			env.Status = "failed"
			if previousStatus == "running" {
				inspect, cancel := context.WithTimeout(context.Background(), 15*time.Second)
				if reply, inspectErr := invokeDriver(inspect, env, "status", nil); inspectErr == nil && reply.Status == "running" {
					_ = applyDriverReply(env, reply)
				}
				cancel()
			}
			env.Error = err.Error()
			err = errors.Join(err, m.save())
		}
	}()
	if !env.CloneComplete {
		source := m.State.Environments[m.State.Main[identity.Project]]
		if source != nil && source != env {
			if source.Driver == nil {
				return nil, fmt.Errorf("cannot clone between native and project-driver environments")
			}
			if _, e = invokeDriver(ctx, env, "clone", source); e != nil {
				recovery, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
				_, resumeErr := invokeDriver(recovery, source, "recover", nil)
				cancel()
				return nil, errors.Join(e, resumeErr)
			}
		}
		env.CloneComplete = true
		if e = m.save(); e != nil {
			return nil, e
		}
	}
	reply, e := invokeDriver(ctx, env, "deploy", nil)
	if e != nil {
		return nil, e
	}
	if e = applyDriverReply(env, reply); e != nil {
		return nil, e
	}
	if env.Status != "running" {
		return nil, fmt.Errorf("deploy finished without a running environment")
	}
	if req.Main || (identity.Branch == "main" && m.State.Main[identity.Project] == "") {
		m.State.Main[identity.Project] = identity.ID
	}
	env.UpdatedAt = time.Now().UTC()
	if e = m.save(); e != nil {
		return nil, e
	}
	return m.view(env), nil
}
func (m *Manager) downDriver(ctx context.Context, env *Environment, deleteData bool) error {
	if m.Tunnel != nil {
		for _, name := range sortedKeys(env.Tunnels) {
			if e := m.Tunnel.Stop(ctx, env, name, deleteData); e != nil {
				return e
			}
		}
	}
	operation := "stop"
	env.Status = "stopping"
	if deleteData {
		operation = "delete"
		env.Status = "deleting"
	}
	if e := m.save(); e != nil {
		return e
	}
	if reply, e := invokeDriver(ctx, env, operation, nil); e != nil || reply.Status != "stopped" {
		if e == nil {
			e = fmt.Errorf("driver %s did not confirm stopped resources", operation)
		}
		env.Error = e.Error()
		_ = m.save()
		return e
	}
	env.Status = "stopped"
	env.Error = ""
	env.UpdatedAt = time.Now().UTC()
	for _, s := range env.Services {
		s.IP = ""
	}
	if deleteData {
		// Forget only after the external resources have been removed successfully.
		if e := os.RemoveAll(env.DriverDirectory); e != nil {
			return e
		}
		delete(m.State.Environments, env.Identity.ID)
		if m.State.Main[env.Identity.Project] == env.Identity.ID {
			delete(m.State.Main, env.Identity.Project)
		}
	}
	return m.save()
}
