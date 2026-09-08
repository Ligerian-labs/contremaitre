package hub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Route struct {
	Upstream   string
	PublicHost string
}
type Routes struct{ value atomic.Value }

func (r *Routes) Set(m map[string]Route) { r.value.Store(m) }
func (r *Routes) Get(host string) (Route, bool) {
	v := r.value.Load()
	if v == nil {
		return Route{}, false
	}
	route, ok := v.(map[string]Route)[host]
	return route, ok
}
func (m *Manager) publishRoutes() {
	if m.Routes == nil {
		return
	}
	routes := map[string]Route{}
	for _, env := range m.State.Environments {
		for _, name := range sortedKeys(env.Services) {
			s := env.Services[name]
			if !s.HTTP {
				continue
			}
			upstream := ""
			if env.Status == "running" && s.IP != "" {
				upstream = "http://" + net.JoinHostPort(s.IP, strconv.Itoa(s.Port))
			}
			u, _ := url.Parse(m.LocalURL(env, name))
			routes[u.Hostname()] = Route{Upstream: upstream}
			fixed := Route{Upstream: upstream}
			if t := env.Tunnels[name]; t != nil {
				if public, e := url.Parse(t.URL); e == nil {
					fixed.PublicHost = public.Host
				}
			}
			routes[env.Identity.ID+"/"+name] = fixed
			if m.State.Main[env.Identity.Project] == env.Identity.ID && u.Hostname() == env.Identity.Host {
				routes["main."+env.Identity.Project+".localhost"] = Route{Upstream: upstream}
			}
		}
	}
	m.Routes.Set(routes)
}
func RouteHandler(routes *Routes, fixed string) http.Handler {
	proxy := &httputil.ReverseProxy{Rewrite: func(pr *httputil.ProxyRequest) {
		route := pr.In.Context().Value(routeKey{}).(Route)
		target, _ := url.Parse(route.Upstream)
		pr.SetURL(target)
		pr.Out.Host = pr.In.Host
		pr.SetXForwarded()
		if fixed != "" && route.PublicHost != "" {
			pr.Out.Host = route.PublicHost
			pr.Out.Header.Set("X-Forwarded-Host", route.PublicHost)
			pr.Out.Header.Set("X-Forwarded-Proto", "https")
		}
	}, FlushInterval: -1, ErrorHandler: func(w http.ResponseWriter, r *http.Request, e error) {
		http.Error(w, "Application unavailable", http.StatusBadGateway)
	}, ErrorLog: log.New(io.Discard, "", 0), Transport: &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext, ResponseHeaderTimeout: 60 * time.Second, MaxIdleConns: 100, IdleConnTimeout: 90 * time.Second}}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := fixed
		if key == "" {
			key = strings.ToLower(r.Host)
			if h, _, e := net.SplitHostPort(key); e == nil {
				key = h
			}
			key = strings.TrimSuffix(key, ".")
		}
		route, ok := routes.Get(key)
		if !ok {
			http.NotFound(w, r)
			return
		}
		if route.Upstream == "" {
			http.Error(w, "Environment offline", http.StatusServiceUnavailable)
			return
		}
		proxy.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), routeKey{}, route)))
	})
}

type routeKey struct{}
type Request struct {
	Root       string `json:"root,omitempty"`
	Branch     string `json:"branch,omitempty"`
	Selector   string `json:"env,omitempty"`
	Service    string `json:"service,omitempty"`
	DeleteData bool   `json:"delete_data,omitempty"`
	Main       bool   `json:"main,omitempty"`
}
type Response struct {
	Version int    `json:"version"`
	Data    any    `json:"data,omitempty"`
	Error   string `json:"error,omitempty"`
}

func writeResult(w http.ResponseWriter, data any, err error) {
	w.Header().Set("Content-Type", "application/json")
	r := Response{Version: 1, Data: data}
	if err != nil {
		r.Data = nil
		r.Error = err.Error()
		w.WriteHeader(400)
	}
	_ = json.NewEncoder(w).Encode(r)
}
func Serve(ctx context.Context, home string, httpPort, publicPort int) error {
	lock, e := Lock(home)
	if e != nil {
		return e
	}
	defer lock.Close()
	m, e := NewManager(Store{home}, Apple{})
	if e != nil {
		return e
	}
	if e = m.Runtime.StartSystem(ctx); e != nil {
		return e
	}
	if publicPort == 0 {
		publicPort = httpPort
	}
	m.HTTPPort = publicPort
	m.Routes = &Routes{}
	m.Tunnel = NewTunnelManager(home)
	defer m.Tunnel.Close()
	for _, env := range m.State.Environments {
		if env.Driver != nil {
			if env.Status == "running" {
				statusCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
				reply, err := invokeDriver(statusCtx, env, "status", nil)
				cancel()
				if err != nil {
					env.Status, env.Error = "failed", err.Error()
				} else if err = applyDriverReply(env, reply); err != nil {
					env.Status, env.Error = "failed", err.Error()
				}
			}
			continue
		}
		all := len(env.Services) > 0
		for _, s := range env.Services {
			v, e := m.Runtime.Inspect(ctx, s.Container)
			s.IP = ""
			if e != nil || !v.Running {
				all = false
			} else {
				s.IP = v.IP
			}
		}
		if !all && env.Status == "running" {
			env.Status = "stopped"
		}

	}
	if e = m.save(); e != nil {
		return e
	}
	m.publishRoutes()
	public, e := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(httpPort)))
	if e != nil {
		return fmt.Errorf("bind local routing port: %w (choose --http-port)", e)
	}
	defer public.Close()
	socket := filepath.Join(home, "hub.sock")
	if e = os.Remove(socket); e != nil && !os.IsNotExist(e) {
		return e
	}
	control, e := net.Listen("unix", socket)
	if e != nil {
		return e
	}
	defer os.Remove(socket)
	defer control.Close()
	if e = os.Chmod(socket, 0600); e != nil {
		return e
	}
	shutdown := make(chan struct{})
	var once sync.Once
	var tunnelMu sync.Mutex
	tunnelListeners := map[string]net.Listener{}
	defer func() {
		for _, l := range tunnelListeners {
			l.Close()
		}
	}()
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/health", func(w http.ResponseWriter, r *http.Request) {
		writeResult(w, map[string]any{"http_port": httpPort, "public_port": publicPort, "home": home}, nil)
	})
	mux.HandleFunc("/v1/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			w.WriteHeader(405)
			return
		}
		var req Request
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024*1024))
		d.DisallowUnknownFields()
		if e := d.Decode(&req); e != nil {
			writeResult(w, nil, e)
			return
		}
		var data any
		var err error
		action := strings.TrimPrefix(r.URL.Path, "/v1/")
		if req.Selector == "" && action != "list" && action != "deploy" && action != "stop" && action != "prune" {
			var identity Identity
			identity, err = m.Current(r.Context(), req.Root, req.Branch)
			if err == nil {
				req.Selector = identity.ID
			}
		}
		if err == nil {
			switch action {
			case "deploy":
				data, err = m.Deploy(r.Context(), DeployRequest{req.Root, req.Branch, req.Main})
			case "list":
				data = m.List()
			case "down":
				err = m.Down(r.Context(), req.Selector, req.DeleteData)
			case "main":
				err = m.SetMain(req.Selector)
			case "prune":
				data, err = m.Prune(r.Context(), req.DeleteData)
			case "stop":
				err = m.StopAll(r.Context())
				if err == nil {
					once.Do(func() { close(shutdown) })
				}
			case "resolve":
				m.mu.RLock()
				var env *Environment
				env, err = m.Resolve(req.Selector)
				if err == nil {
					data = m.view(env)
				}
				m.mu.RUnlock()
			case "tunnel", "tunnel-stop", "tunnel-release":
				m.mu.Lock()
				var env *Environment
				env, err = m.Resolve(req.Selector)
				if err == nil {
					if action == "tunnel" {
						s := env.Services[req.Service]
						if s == nil || !s.HTTP {
							err = fmt.Errorf("select an HTTP service")
						} else if env.Status != "running" {
							err = fmt.Errorf("deploy the environment before sharing it")
						} else {
							key := env.Identity.ID + "/" + req.Service
							tunnelMu.Lock()
							l := tunnelListeners[key]
							if l == nil {
								l, err = net.Listen("tcp", "127.0.0.1:0")
								if err == nil {
									tunnelListeners[key] = l
									server := &http.Server{Handler: RouteHandler(m.Routes, key), ReadHeaderTimeout: 10 * time.Second, MaxHeaderBytes: 64 * 1024}
									go func() { _ = server.Serve(l) }()
								}
							}
							tunnelMu.Unlock()
							if err == nil {
								data, err = m.Tunnel.Start(r.Context(), env, req.Service, "http://"+l.Addr().String(), m.save)
							}
						}
					} else {
						names := []string{req.Service}
						if req.Service == "" {
							names = sortedKeys(env.Tunnels)
						}
						for _, name := range names {
							err = errors.Join(err, m.Tunnel.Stop(r.Context(), env, name, action == "tunnel-release"))
						}
						err = errors.Join(err, m.save())
					}
				}
				m.mu.Unlock()
			default:
				err = fmt.Errorf("unknown operation")
			}
		}
		writeResult(w, data, err)
	})
	httpServer := &http.Server{Handler: RouteHandler(m.Routes, ""), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 64 * 1024}
	controlServer := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}

	monitorCtx, stopMonitor := context.WithCancel(ctx)
	monitorDone := make(chan struct{})
	defer func() { stopMonitor(); <-monitorDone }()
	go func() {
		defer close(monitorDone)
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		retryAt := map[string]time.Time{}
		delay := map[string]time.Duration{}
		for {
			select {
			case <-monitorCtx.Done():
				return
			case <-ticker.C:
				if !m.mu.TryLock() {
					continue
				}
				for _, env := range m.State.Environments {
					if env.Status != "running" {
						continue
					}
					for name, reservation := range env.Tunnels {
						key := env.Identity.ID + "/" + name
						if !reservation.Desired || m.Tunnel.Running(env.Identity.ID, name) || time.Now().Before(retryAt[key]) {
							continue
						}
						tunnelMu.Lock()
						l := tunnelListeners[key]
						if l == nil {
							var err error
							l, err = net.Listen("tcp", "127.0.0.1:0")
							if err == nil {
								tunnelListeners[key] = l
								server := &http.Server{Handler: RouteHandler(m.Routes, key), ReadHeaderTimeout: 10 * time.Second}
								go func() { _ = server.Serve(l) }()
							}
						}
						tunnelMu.Unlock()
						if l != nil {
							_, err := m.Tunnel.Start(monitorCtx, env, name, "http://"+l.Addr().String(), m.save)
							if err == nil {
								delay[key] = 0
								continue
							}
						}
						if delay[key] == 0 {
							delay[key] = 5 * time.Second
						} else {
							delay[key] *= 2
						}
						if delay[key] > time.Minute {
							delay[key] = time.Minute
						}
						retryAt[key] = time.Now().Add(delay[key])
					}
				}
				m.mu.Unlock()
			}
		}
	}()
	failures := make(chan error, 2)
	go func() { failures <- httpServer.Serve(public) }()
	go func() { failures <- controlServer.Serve(control) }()
	select {
	case <-ctx.Done():
	case <-shutdown:
	case e = <-failures:
		if !errors.Is(e, http.ErrServerClosed) {
			return e
		}
	}
	cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = controlServer.Shutdown(cleanup)
	_ = httpServer.Close()
	return nil
}
func Client(home string) *http.Client {
	return &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(home, "hub.sock"))
	}}, Timeout: 30 * time.Minute}
}
