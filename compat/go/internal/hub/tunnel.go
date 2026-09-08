package hub

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Providers are installed local programs. JSON goes through stdin/stdout, never a shell.
type ProviderConfig struct {
	Executable string          `json:"executable"`
	Config     json.RawMessage `json:"config,omitempty"`
}
type TunnelReservation struct {
	Provider  string
	ID        string
	URL       string
	Desired   bool
	Connected bool
}
type ProviderRequest struct {
	Version       int             `json:"version"`
	Config        json.RawMessage `json:"config,omitempty"`
	EnvironmentID string          `json:"environment_id,omitempty"`
	ServiceID     string          `json:"service_id,omitempty"`
	DisplayName   string          `json:"display_name,omitempty"`
	ReservationID string          `json:"reservation_id,omitempty"`
	Upstream      string          `json:"upstream,omitempty"`
}
type ProviderResponse struct {
	Version      int             `json:"version"`
	ID           string          `json:"reservation_id"`
	URL          string          `json:"url"`
	Ready        bool            `json:"ready"`
	Capabilities map[string]bool `json:"capabilities"`
}
type providerProcess struct {
	cmd  *exec.Cmd
	done chan struct{}
	log  *os.File
}
type TunnelManager struct {
	mu     sync.Mutex
	Home   string
	active map[string]*providerProcess
}

func NewTunnelManager(home string) *TunnelManager {
	return &TunnelManager{Home: home, active: map[string]*providerProcess{}}
}
func (t *TunnelManager) config(provider string) (ProviderConfig, error) {
	var all struct {
		Default   string                    `json:"default"`
		Providers map[string]ProviderConfig `json:"providers"`
	}
	b, e := os.ReadFile(filepath.Join(t.Home, "tunnels.json"))
	if e != nil {
		return ProviderConfig{}, fmt.Errorf("configure a tunnel provider in %s: %w", filepath.Join(t.Home, "tunnels.json"), e)
	}
	if e = json.Unmarshal(b, &all); e != nil {
		return ProviderConfig{}, e
	}
	if provider == "" {
		provider = all.Default
	}
	p, ok := all.Providers[provider]
	if !ok || p.Executable == "" {
		return p, fmt.Errorf("tunnel provider %q is not configured", provider)
	}
	if !filepath.IsAbs(p.Executable) {
		return p, fmt.Errorf("provider executable must be an absolute path")
	}
	return p, nil
}
func (t *TunnelManager) defaultName() (string, error) {
	var cfg struct {
		Default string `json:"default"`
	}
	b, e := os.ReadFile(filepath.Join(t.Home, "tunnels.json"))
	if e != nil {
		return "", e
	}
	e = json.Unmarshal(b, &cfg)
	return cfg.Default, e
}
func providerCall(ctx context.Context, cfg ProviderConfig, operation string, req ProviderRequest) (ProviderResponse, error) {
	req.Version = 1
	req.Config = cfg.Config
	b, e := json.Marshal(req)
	if e != nil {
		return ProviderResponse{}, e
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, cfg.Executable, operation)
	cmd.Stdin = bytes.NewReader(b)
	stderr := cappedBuffer{Limit: 64 * 1024}
	cmd.Stderr = &stderr
	stdout, e := cmd.StdoutPipe()
	if e != nil {
		return ProviderResponse{}, e
	}
	if e = cmd.Start(); e != nil {
		return ProviderResponse{}, e
	}
	out, e := io.ReadAll(io.LimitReader(stdout, 1024*1024+1))
	if e != nil || len(out) > 1024*1024 {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return ProviderResponse{}, fmt.Errorf("provider response exceeded limit or failed")
	}
	if e = cmd.Wait(); e != nil {
		return ProviderResponse{}, fmt.Errorf("provider %s failed: %w", operation, e)
	}
	var result ProviderResponse
	e = json.Unmarshal(out, &result)
	if e == nil && result.Version != 1 {
		e = fmt.Errorf("unsupported provider protocol")
	}
	return result, e
}
func (t *TunnelManager) Start(ctx context.Context, env *Environment, service, upstream string, save func() error) (*TunnelReservation, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	key := env.Identity.ID + "/" + service
	if p := t.active[key]; p != nil {
		select {
		case <-p.done:
			delete(t.active, key)
		default:
			return env.Tunnels[service], nil
		}
	}
	if !validUpstream(upstream) {
		return nil, fmt.Errorf("tunnel upstream must be loopback HTTP")
	}
	r := env.Tunnels[service]
	provider := ""
	var e error
	if r != nil {
		provider = r.Provider
	} else {
		provider, e = t.defaultName()
		if e != nil {
			return nil, e
		}
	}
	cfg, e := t.config(provider)
	if e != nil {
		return nil, e
	}
	req := ProviderRequest{Version: 1, EnvironmentID: env.Identity.ID, ServiceID: service, DisplayName: env.Identity.Name}
	caps, e := providerCall(ctx, cfg, "capabilities", req)
	if e != nil {
		return nil, e
	}
	if !caps.Capabilities["stable_urls"] || !caps.Capabilities["https"] {
		return nil, fmt.Errorf("provider must support stable_urls and https")
	}
	if r == nil {
		res, e := providerCall(ctx, cfg, "reserve", req)
		if e != nil {
			return nil, e
		}
		u, e := url.Parse(res.URL)
		if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || res.ID == "" {
			return nil, fmt.Errorf("provider returned invalid reservation")
		}
		r = &TunnelReservation{Provider: provider, ID: res.ID, URL: res.URL}
		if env.Tunnels == nil {
			env.Tunnels = map[string]*TunnelReservation{}
		}
		env.Tunnels[service] = r
		if e = save(); e != nil {
			return nil, e
		}
	}
	req.ReservationID = r.ID
	req.Upstream = upstream
	req.Config = cfg.Config
	b, _ := json.Marshal(req)
	cmd := exec.Command(cfg.Executable, "start")
	cmd.Stdin = bytes.NewReader(b)
	pipe, e := cmd.StdoutPipe()
	if e != nil {
		return nil, e
	}
	logPath := filepath.Join(t.Home, "tunnel-"+env.Identity.ID+"-"+service+".log")
	log, e := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if e != nil {
		return nil, e
	}
	cmd.Stderr = &limitedLog{Writer: log, Remaining: 10 * 1024 * 1024}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if e = cmd.Start(); e != nil {
		log.Close()
		return nil, e
	}
	ready := make(chan error, 1)
	go func() {
		reader := bufio.NewReaderSize(pipe, 64*1024)
		line, e := reader.ReadSlice('\n')
		if e == nil {
			var event ProviderResponse
			e = json.Unmarshal(line, &event)
			if e == nil && (!event.Ready || event.Version != 1) {
				e = fmt.Errorf("provider did not report ready")
			}
		}
		ready <- e
		_, _ = io.Copy(io.Discard, reader)
	}()
	select {
	case e = <-ready:
	case <-ctx.Done():
		e = ctx.Err()
	case <-time.After(30 * time.Second):
		e = fmt.Errorf("provider readiness timed out")
	}
	if e != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Wait()
		log.Close()
		return nil, e
	}
	p := &providerProcess{cmd: cmd, done: make(chan struct{}), log: log}
	t.active[key] = p
	go func() { _ = cmd.Wait(); log.Close(); close(p.done) }()
	r.Desired = true
	return r, save()
}
func (t *TunnelManager) Stop(ctx context.Context, env *Environment, service string, release bool) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	r := env.Tunnels[service]
	if r == nil {
		return nil
	}
	r.Desired = false
	key := env.Identity.ID + "/" + service
	if p := t.active[key]; p != nil {
		_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGTERM)
		select {
		case <-p.done:
		case <-time.After(5 * time.Second):
			_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL)
			<-p.done
		}
		delete(t.active, key)
	}
	cfg, e := t.config(r.Provider)
	if e != nil {
		return e
	}
	operation := "stop"
	if release {
		operation = "release"
	}
	_, e = providerCall(ctx, cfg, operation, ProviderRequest{ReservationID: r.ID, EnvironmentID: env.Identity.ID, ServiceID: service})
	if e != nil {
		return e
	}
	r.Desired = false
	if release {
		delete(env.Tunnels, service)
	}
	return nil
}
func (t *TunnelManager) Running(envID, service string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	p := t.active[envID+"/"+service]
	if p == nil {
		return false
	}
	select {
	case <-p.done:
		return false
	default:
		return true
	}
}
func (t *TunnelManager) Close() {
	t.mu.Lock()
	defer t.mu.Unlock()
	for key, p := range t.active {
		_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGTERM)
		select {
		case <-p.done:
		case <-time.After(5 * time.Second):
			_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL)
		}
		delete(t.active, key)
	}
}
func validUpstream(s string) bool {
	u, e := url.Parse(s)
	return e == nil && u.Scheme == "http" && strings.HasPrefix(u.Host, "127.0.0.1:")
}

type limitedLog struct {
	Writer    io.Writer
	Remaining int
}

func (l *limitedLog) Write(p []byte) (int, error) {
	n := len(p)
	if l.Remaining <= 0 {
		return n, nil
	}
	if len(p) > l.Remaining {
		p = p[:l.Remaining]
	}
	written, e := l.Writer.Write(p)
	l.Remaining -= written
	if e != nil {
		return written, e
	}
	return n, nil
}
