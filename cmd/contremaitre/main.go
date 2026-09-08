package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"contremaitre/internal/hub"
)

const usage = `contremaitre: isolated local application environments

  init [--compose compose.yaml]       Generate a project manifest
  start [--http-port 8080]               Start the local hub
  deploy [--branch NAME] [--main]      Deploy current working files
  list | status                       Show environments
  main --env PROJECT/ENV              Designate the clone source
  exec SERVICE -- COMMAND [ARGS...]   Execute inside a service
  logs SERVICE                        Show container logs
  proxy SERVICE [LOCAL:]REMOTE        Forward a loopback TCP port (0 = free port)
  down [ENV] [--delete-data]          Remove services; retain data by default
  prune [--delete-data]               Remove old builds; optionally stopped data
  tunnel SERVICE                      Print a stable shareable URL
  tunnel status | stop | release [SERVICE]
  stop                                Stop all Contremaitre environments
  forward-http                        Forward loopback port 80 to 8080 (administrator)

Options: --home PATH, --env ENV, --branch NAME, --json
Exec commands should follow --. Proxy runs until interrupted.
`

type options struct {
	publicPort                      int
	home, selector, branch, compose string
	port                            int
	json, deleteData, main          bool
	args, command                   []string
}

func parse(args []string) (options, error) {
	home, e := os.UserHomeDir()
	if e != nil {
		return options{}, e
	}
	o := options{home: filepath.Join(home, ".local", "share", "contremaitre"), port: 8080}
	if h := os.Getenv("CONTREMAITRE_HOME"); h != "" {
		o.home = h
	}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			o.command = args[i+1:]
			break
		}
		switch a {
		case "--home", "--env", "--branch", "--http-port", "--public-port", "--compose":
			if i+1 == len(args) {
				return o, fmt.Errorf("%s requires a value", a)
			}
			i++
			switch a {
			case "--home":
				o.home = args[i]
			case "--env":
				o.selector = args[i]
			case "--branch":
				o.branch = args[i]
			case "--compose":
				o.compose = args[i]
			case "--public-port":
				o.publicPort, e = strconv.Atoi(args[i])
				if e != nil || o.publicPort < 1 || o.publicPort > 65535 {
					return o, fmt.Errorf("invalid public port")
				}
			case "--http-port":
				o.port, e = strconv.Atoi(args[i])
				if e != nil || o.port < 1 || o.port > 65535 {
					return o, fmt.Errorf("invalid HTTP port")
				}
			}
		case "--json":
			o.json = true
		case "--delete-data":
			o.deleteData = true
		case "--main":
			o.main = true
		case "--help", "-h":
			o.args = []string{"help"}
			return o, nil
		default:
			if strings.HasPrefix(a, "-") {
				return o, fmt.Errorf("unknown option %s", a)
			}
			o.args = append(o.args, a)
		}
	}
	o.home, e = filepath.Abs(o.home)
	return o, e
}
func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	o, e := parse(os.Args[1:])
	if e == nil {
		e = run(ctx, o)
	}
	if e != nil {
		if o.json {
			_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"version": 1, "error": e.Error()})
		} else {
			fmt.Fprintln(os.Stderr, e)
		}
		var exit *exec.ExitError
		if errors.As(e, &exit) {
			os.Exit(exit.ExitCode())
		}
		os.Exit(1)
	}
}
func output(o options, data any) error {
	if o.json {
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"version": 1, "data": data})
	}
	switch v := data.(type) {
	case string:
		fmt.Println(v)
	default:
		b, e := json.MarshalIndent(data, "", "  ")
		if e != nil {
			return e
		}
		fmt.Println(string(b))
	}
	return nil
}
func call(ctx context.Context, o options, action string, req hub.Request, out any) error {
	b, _ := json.Marshal(req)
	r, e := http.NewRequestWithContext(ctx, "POST", "http://hub/v1/"+action, bytes.NewReader(b))
	if e != nil {
		return e
	}
	client := hub.Client(o.home)
	if action == "deploy" {
		r.Header.Set("Accept", hub.DeployStreamType)
		if manifest, _, err := hub.LoadManifest(req.Root); err == nil && manifest.Driver != nil {
			client.Timeout = time.Duration(3*manifest.Driver.TimeoutSeconds+120) * time.Second
		}
	}
	res, e := client.Do(r)
	if e != nil {
		return fmt.Errorf("hub unavailable; run contremaitre start: %w", e)
	}
	defer res.Body.Close()
	if action == "deploy" && res.Header.Get("Content-Type") == hub.DeployStreamType {
		return readDeployStream(res.Body, os.Stderr, out)
	}
	if action == "deploy" {
		fmt.Fprintln(os.Stderr, "[contremaitre] This running hub does not support live logs; restart it after deployment to enable them.")
	}
	var reply struct {
		Version int
		Data    json.RawMessage
		Error   string
	}
	if e = json.NewDecoder(res.Body).Decode(&reply); e != nil {
		return e
	}
	if reply.Error != "" {
		return errors.New(reply.Error)
	}
	if out != nil && len(reply.Data) > 0 && string(reply.Data) != "null" {
		return json.Unmarshal(reply.Data, out)
	}
	return nil
}
func health(ctx context.Context, o options) bool {
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	r, _ := http.NewRequestWithContext(ctx, "GET", "http://hub/v1/health", nil)
	res, e := hub.Client(o.home).Do(r)
	if e != nil {
		return false
	}
	res.Body.Close()
	return res.StatusCode == 200
}
func launch(ctx context.Context, o options) error {
	if health(ctx, o) {
		return nil
	}
	if e := os.MkdirAll(o.home, 0700); e != nil {
		return e
	}
	bin, e := os.Executable()
	if e != nil {
		return e
	}
	path := filepath.Join(o.home, "daemon.log")
	if info, e := os.Stat(path); e == nil && info.Size() > 10*1024*1024 {
		_ = os.Rename(path, path+".1")
	}
	log, e := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	defer log.Close()
	launchArgs := []string{"serve", "--home", o.home, "--http-port", strconv.Itoa(o.port)}
	if o.publicPort > 0 {
		launchArgs = append(launchArgs, "--public-port", strconv.Itoa(o.publicPort))
	}
	cmd := exec.Command(bin, launchArgs...)
	cmd.Stdout = log
	cmd.Stderr = log
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if e = cmd.Start(); e != nil {
		return e
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	timeout := time.NewTimer(3 * time.Minute)
	defer timeout.Stop()
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case e := <-done:
			return fmt.Errorf("hub failed to start (%v); see %s", e, path)
		case <-ctx.Done():
			_ = cmd.Process.Signal(syscall.SIGTERM)
			return ctx.Err()
		case <-timeout.C:
			return fmt.Errorf("hub startup timed out; see %s", path)
		case <-tick.C:
			if health(ctx, o) {
				return nil
			}
		}
	}
}
func projectRoot() string {
	dir, _ := os.Getwd()
	for p := dir; ; p = filepath.Dir(p) {
		for _, name := range []string{".contremaitre.yaml", ".contremaitre.yml"} {
			if _, e := os.Stat(filepath.Join(p, name)); e == nil {
				return p
			}
		}
		if filepath.Dir(p) == p {
			return dir
		}
	}
}
func run(ctx context.Context, o options) error {
	if len(o.args) == 0 || o.args[0] == "help" {
		fmt.Print(usage)
		return nil
	}
	action := o.args[0]
	args := o.args[1:]
	req := hub.Request{Root: projectRoot(), Branch: o.branch, Selector: o.selector, DeleteData: o.deleteData, Main: o.main}
	switch action {
	case "serve":
		return hub.Serve(ctx, o.home, o.port, o.publicPort)
	case "forward-http":
		return hub.ForwardHTTP(ctx)
	case "version":
		return output(o, "contremaitre 0.1.0")
	case "init":
		dir, _ := os.Getwd()
		p, e := hub.InitProject(dir, o.compose)
		if e != nil {
			return e
		}
		return output(o, p)
	case "start":
		if e := launch(ctx, o); e != nil {
			return e
		}
		return output(o, "Contremaitre is running")
	case "deploy":
		if e := launch(ctx, o); e != nil {
			return e
		}
		var env hub.Environment
		if e := call(ctx, o, "deploy", req, &env); e != nil {
			return e
		}
		if o.json {
			return output(o, env)
		}
		fmt.Printf("%s [%s]\n", env.Identity.Name, env.Identity.ID)
		for _, name := range keys(env.Services) {
			s := env.Services[name]
			if s.HTTP && s.URL != "" {
				fmt.Printf("%s: %s\n", name, s.URL)
				continue
			}
			if s.HTTP {
				host := env.Identity.Host
				first := ""
				for _, n := range keys(env.Services) {
					if env.Services[n].HTTP {
						first = n
						break
					}
				}
				if first != name {
					host = name + "." + host
				}
				port := hubPort(ctx, o)
				if port != 80 {
					host = net.JoinHostPort(host, strconv.Itoa(port))
				}
				fmt.Printf("%s: http://%s\n", name, host)
			}
		}
		return nil
	case "list", "status":
		var envs []hub.Environment
		if e := call(ctx, o, "list", req, &envs); e != nil {
			return e
		}
		if o.json {
			return output(o, envs)
		}
		for _, env := range envs {
			fmt.Printf("%s\t%s\t%s\n", env.Identity.ID, env.Status, env.Identity.Name)
		}
		return nil
	case "down", "main", "prune", "stop":
		if len(args) > 0 {
			req.Selector = args[0]
		}
		var data any
		if e := call(ctx, o, action, req, &data); e != nil {
			return e
		}
		if data == nil {
			data = action + " complete"
		}
		return output(o, data)
	case "exec", "logs", "proxy":
		if len(args) == 0 {
			return fmt.Errorf("%s requires a service", action)
		}
		var env hub.Environment
		if e := call(ctx, o, "resolve", req, &env); e != nil {
			return e
		}
		s := env.Services[args[0]]
		if s == nil {
			return fmt.Errorf("service %q not found", args[0])
		}
		if env.Driver != nil {
			command := args[1:]
			if len(o.command) > 0 {
				command = o.command
			}
			if action == "exec" && len(command) == 0 {
				return fmt.Errorf("exec requires a command after --")
			}
			return hub.DriverInteractive(ctx, &env, action, args[0], command, os.Stdin, os.Stdout, os.Stderr)
		}
		if action == "exec" {
			command := o.command
			if len(command) == 0 {
				command = args[1:]
			}
			if len(command) == 0 {
				return fmt.Errorf("exec requires a command after --")
			}
			return (hub.Apple{}).Exec(ctx, s.Container, command, os.Stdin, os.Stdout, os.Stderr)
		}
		if action == "logs" {
			c := exec.CommandContext(ctx, "container", "logs", s.Container)
			c.Stdout = os.Stdout
			c.Stderr = os.Stderr
			return c.Run()
		}
		if len(args) != 2 {
			return fmt.Errorf("proxy requires [LOCAL:]REMOTE")
		}
		return proxy(ctx, o, s.Container, args[1])
	case "tunnel":
		if len(args) == 0 {
			return fmt.Errorf("tunnel requires a service, status, stop or release")
		}
		if args[0] == "status" {
			var env hub.Environment
			if e := call(ctx, o, "resolve", req, &env); e != nil {
				return e
			}
			return output(o, env.Tunnels)
		}
		operation := "tunnel"
		if args[0] == "release" && len(args) != 2 {
			return fmt.Errorf("tunnel release requires a service")
		}
		if args[0] == "stop" || args[0] == "release" {
			operation += "-" + args[0]
			if len(args) > 1 {
				req.Service = args[1]
			}
		} else {
			req.Service = args[0]
		}
		var data json.RawMessage
		if e := call(ctx, o, operation, req, &data); e != nil {
			return e
		}
		if operation == "tunnel" && !o.json {
			var t hub.TunnelReservation
			if e := json.Unmarshal(data, &t); e != nil {
				return e
			}
			return output(o, t.URL)
		}
		return output(o, data)
	default:
		return fmt.Errorf("unknown command %q", action)
	}
}
func hubPort(ctx context.Context, o options) int {
	r, _ := http.NewRequestWithContext(ctx, "GET", "http://hub/v1/health", nil)
	res, e := hub.Client(o.home).Do(r)
	if e != nil {
		return o.port
	}
	defer res.Body.Close()
	var reply struct {
		Data struct {
			Port int `json:"public_port"`
		}
	}
	if json.NewDecoder(res.Body).Decode(&reply) != nil {
		return o.port
	}
	return reply.Data.Port
}
func proxy(ctx context.Context, o options, container, mapping string) error {
	parts := strings.Split(mapping, ":")
	local, remote := 0, 0
	var e error
	if len(parts) == 1 {
		remote, e = strconv.Atoi(parts[0])
	} else if len(parts) == 2 {
		local, e = strconv.Atoi(parts[0])
		if e == nil {
			remote, e = strconv.Atoi(parts[1])
		}
	} else {
		return fmt.Errorf("invalid port mapping")
	}
	if e != nil || local < 0 || local > 65535 || remote < 1 || remote > 65535 {
		return fmt.Errorf("invalid port mapping")
	}
	listener, e := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(local)))
	if e != nil {
		return e
	}
	defer listener.Close()
	if e = output(o, map[string]any{"address": listener.Addr().String(), "remote_port": remote}); e != nil {
		return e
	}
	go func() { <-ctx.Done(); listener.Close() }()
	sem := make(chan struct{}, 128)
	var wg sync.WaitGroup
	defer wg.Wait()
	for {
		conn, e := listener.Accept()
		if e != nil {
			if ctx.Err() != nil {
				return nil
			}
			return e
		}
		select {
		case sem <- struct{}{}:
		default:
			conn.Close()
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			defer conn.Close()
			v, e := (hub.Apple{}).Inspect(ctx, container)
			if e != nil || !v.Running {
				return
			}
			up, e := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(v.IP, strconv.Itoa(remote)))
			if e != nil {
				return
			}
			defer up.Close()
			stop := context.AfterFunc(ctx, func() { conn.Close(); up.Close() })
			defer stop()
			done := make(chan struct{})
			go func() {
				_, _ = io.Copy(up, conn)
				if tcp, ok := up.(*net.TCPConn); ok {
					_ = tcp.CloseWrite()
				}
				close(done)
			}()
			_, _ = io.Copy(conn, up)
			conn.Close()
			up.Close()
			<-done
		}()
	}
}
func keys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

func readDeployStream(in io.Reader, logs io.Writer, out any) error {
	decoder := json.NewDecoder(in)
	for {
		var event struct {
			Version              int
			Type, Message, Error string
			Output               []byte
			Data                 json.RawMessage
		}
		if err := decoder.Decode(&event); err != nil {
			if errors.Is(err, io.EOF) {
				return fmt.Errorf("deployment stream ended without a result; check contremaitre list and deployment logs")
			}
			return fmt.Errorf("read deployment progress: %w", err)
		}
		if event.Version != 1 {
			return fmt.Errorf("unsupported deployment stream version")
		}
		switch event.Type {
		case "log":
			chunk := event.Output
			if chunk == nil {
				chunk = []byte(event.Message)
			}
			if _, err := logs.Write(chunk); err != nil {
				return err
			}
		case "result":
			if event.Error != "" {
				return errors.New(event.Error)
			}
			if out != nil && len(event.Data) > 0 && string(event.Data) != "null" {
				return json.Unmarshal(event.Data, out)
			}
			return nil
		default:
			return fmt.Errorf("unknown deployment stream event %q", event.Type)
		}
	}
}
