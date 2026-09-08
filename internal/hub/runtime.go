package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var ErrNotFound = errors.New("container not found")

type Container struct {
	IP      string
	Running bool
}
type RunSpec struct {
	Task                          bool
	Name, Image, Network, EnvFile string
	Service                       Service
	Volumes                       map[string]string
}
type Runtime interface {
	StartSystem(context.Context) error
	Build(context.Context, string, string, string) error
	Network(context.Context, string) error
	RemoveNetwork(context.Context, string) error
	Volume(context.Context, string) error
	RemoveVolume(context.Context, string) error
	RemoveImage(context.Context, string) error
	Run(context.Context, RunSpec) error
	Inspect(context.Context, string) (Container, error)
	Stop(context.Context, string) error
	Start(context.Context, string) error
	Remove(context.Context, string) error
	Exec(context.Context, string, []string, io.Reader, io.Writer, io.Writer) error
}
type Apple struct{ Binary string }

func (a Apple) command(ctx context.Context, args ...string) *exec.Cmd {
	bin := a.Binary
	if bin == "" {
		bin = "container"
	}
	return exec.CommandContext(ctx, bin, args...)
}
func (a Apple) output(ctx context.Context, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	c := a.command(ctx, args...)
	stderr := cappedBuffer{Limit: 64 * 1024}
	stdout := cappedBuffer{Limit: 4 * 1024 * 1024}
	c.Stderr = &stderr
	c.Stdout = &stdout
	e := c.Run()
	b := stdout.Bytes()
	if e != nil {
		return nil, fmt.Errorf("container %s: %w: %s", args[0], e, strings.TrimSpace(stderr.String()))
	}
	return b, nil
}
func (a Apple) call(ctx context.Context, args ...string) error {
	_, e := a.output(ctx, args...)
	return e
}
func (a Apple) StartSystem(ctx context.Context) error {
	return a.call(ctx, "system", "start", "--enable-kernel-install")
}
func (a Apple) Build(ctx context.Context, root, dockerfile, tag string) error {
	args := []string{"build", "--tag", tag, "--file", dockerfile, "--progress", "plain", root}
	c := a.command(ctx, args...)
	c.Stdout = os.Stderr
	c.Stderr = os.Stderr
	return c.Run()
}
func (a Apple) Network(ctx context.Context, name string) error {
	if _, e := a.output(ctx, "network", "inspect", name); e == nil {
		return nil
	}
	return a.call(ctx, "network", "create", name)
}
func (a Apple) RemoveNetwork(ctx context.Context, name string) error {
	if _, e := a.output(ctx, "network", "inspect", name); missing(e) {
		return nil
	}
	return a.call(ctx, "network", "delete", name)
}
func (a Apple) Volume(ctx context.Context, name string) error {
	if _, e := a.output(ctx, "volume", "inspect", name); e == nil {
		return nil
	}
	return a.call(ctx, "volume", "create", "--label", "dev.contremaitre.managed=true", name)
}
func (a Apple) RemoveVolume(ctx context.Context, name string) error {
	if _, e := a.output(ctx, "volume", "inspect", name); missing(e) {
		return nil
	}
	return a.call(ctx, "volume", "delete", name)
}
func (a Apple) RemoveImage(ctx context.Context, name string) error {
	if _, e := a.output(ctx, "image", "inspect", name); missing(e) {
		return nil
	}
	return a.call(ctx, "image", "delete", name)
}
func (a Apple) Run(ctx context.Context, s RunSpec) error {
	args := []string{"run", "--name", s.Name, "--network", s.Network, "--label", "dev.contremaitre.managed=true", "--cpus", fmt.Sprint(s.Service.CPUs), "--memory", s.Service.Memory}
	if s.Task {
		args = append(args, "--rm")
	} else {
		args = append(args, "--detach")
	}
	if s.EnvFile != "" {
		args = append(args, "--env-file", s.EnvFile)
	}
	for _, source := range sortedKeys(s.Volumes) {
		args = append(args, "--volume", source+":"+s.Volumes[source])
	}
	args = append(args, s.Image)
	args = append(args, s.Service.Command...)
	return a.call(ctx, args...)
}
func (a Apple) Inspect(ctx context.Context, name string) (Container, error) {
	b, e := a.output(ctx, "inspect", name)
	if e != nil {
		if strings.Contains(e.Error(), "notFound") || strings.Contains(e.Error(), "not found") || strings.Contains(e.Error(), "does not exist") {
			return Container{}, ErrNotFound
		}
		return Container{}, e
	}
	return DecodeContainer(b)
}
func DecodeContainer(b []byte) (Container, error) {
	type network struct {
		IPv4Address string `json:"ipv4Address"`
	}
	var values []struct {
		Status   json.RawMessage `json:"status"`
		Networks []network       `json:"networks"`
	}
	if e := json.Unmarshal(b, &values); e != nil {
		return Container{}, e
	}
	if len(values) != 1 {
		return Container{}, fmt.Errorf("expected one container inspection")
	}
	v := values[0]
	var status struct {
		State    string    `json:"state"`
		Networks []network `json:"networks"`
	}
	if e := json.Unmarshal(v.Status, &status); e != nil {
		if e = json.Unmarshal(v.Status, &status.State); e != nil {
			return Container{}, e
		}
		status.Networks = v.Networks
	}
	ip := ""
	if len(status.Networks) > 0 {
		ip = strings.Split(status.Networks[0].IPv4Address, "/")[0]
	}
	return Container{IP: ip, Running: status.State == "running"}, nil
}
func (a Apple) Stop(ctx context.Context, name string) error {
	v, e := a.Inspect(ctx, name)
	if errors.Is(e, ErrNotFound) {
		return nil
	}
	if e != nil {
		return e
	}
	if !v.Running {
		return nil
	}
	return a.call(ctx, "stop", name)
}
func (a Apple) Start(ctx context.Context, name string) error { return a.call(ctx, "start", name) }
func (a Apple) Remove(ctx context.Context, name string) error {
	_, e := a.Inspect(ctx, name)
	if errors.Is(e, ErrNotFound) {
		return nil
	}
	if e != nil {
		return e
	}
	return a.call(ctx, "delete", "--force", name)
}
func (a Apple) Exec(ctx context.Context, name string, args []string, in io.Reader, out, stderr io.Writer) error {
	argv := []string{"exec"}
	if in != nil {
		argv = append(argv, "--interactive")
	}
	argv = append(argv, name)
	argv = append(argv, args...)
	c := a.command(ctx, argv...)
	c.Stdin = in
	c.Stdout = out
	c.Stderr = stderr
	return c.Run()
}
func envFile(dir string, env map[string]string) (string, error) {
	if e := os.MkdirAll(dir, 0700); e != nil {
		return "", e
	}
	f, e := os.CreateTemp(dir, "env-")
	if e != nil {
		return "", e
	}
	defer f.Close()
	for _, k := range sortedKeys(env) {
		if !envKeyPattern.MatchString(k) {
			os.Remove(f.Name())
			return "", fmt.Errorf("invalid environment key %q", k)
		}
		if strings.ContainsAny(env[k], "\r\n") {
			os.Remove(f.Name())
			return "", fmt.Errorf("multiline environment values are unsupported")
		}
		if _, e = fmt.Fprintf(f, "%s=%s\n", k, env[k]); e != nil {
			os.Remove(f.Name())
			return "", e
		}
	}
	return filepath.Abs(f.Name())
}

func missing(e error) bool {
	return e != nil && (strings.Contains(e.Error(), "notFound") || strings.Contains(e.Error(), "not found") || strings.Contains(e.Error(), "does not exist"))
}

// Continue draining subprocess pipes after the diagnostic limit, without growing memory.
type cappedBuffer struct {
	bytes.Buffer
	Limit int
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	remaining := b.Limit - b.Len()
	if remaining > 0 {
		if len(p) > remaining {
			p = p[:remaining]
		}
		_, _ = b.Buffer.Write(p)
	}
	return n, nil
}

var envKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
