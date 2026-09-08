package hub

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRoutesIsolateHostsAndPreserveRequests(t *testing.T) {
	a := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Forwarded-Host") != "one.shop.localhost" {
			t.Error("forwarded host missing")
		}
		b, _ := io.ReadAll(r.Body)
		w.Header().Add("Set-Cookie", "a=1")
		w.Header().Add("Set-Cookie", "b=2")
		_, _ = w.Write(b)
	}))
	defer a.Close()
	routes := &Routes{}
	routes.Set(map[string]Route{"one.shop.localhost": {Upstream: a.URL}, "two.shop.localhost": {}})
	handler := RouteHandler(routes, "")
	req := httptest.NewRequest("POST", "http://one.shop.localhost/hook?x=1", strings.NewReader("signed webhook"))
	req.Header.Set("X-Forwarded-Host", "attacker.example")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 200 || w.Body.String() != "signed webhook" || len(w.Header().Values("Set-Cookie")) != 2 {
		t.Fatal("proxy changed response")
	}
	for host, status := range map[string]int{"two.shop.localhost": 503, "unknown.shop.localhost": 404} {
		r := httptest.NewRequest("GET", "http://"+host, nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("%s: got %d", host, w.Code)
		}
	}
}
func TestStateLockExcludesSecondDaemon(t *testing.T) {
	home := t.TempDir()
	first, e := Lock(home)
	if e != nil {
		t.Fatal(e)
	}
	defer first.Close()
	if second, e := Lock(home); e == nil {
		second.Close()
		t.Fatal("two daemons acquired state lock")
	}
}

func TestTunnelForwardingPreservesPublicHTTPSOrigin(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != "preview.example.com" || r.Header.Get("X-Forwarded-Proto") != "https" {
			t.Error("lost tunnel public origin")
		}
		w.WriteHeader(204)
	}))
	defer up.Close()
	routes := &Routes{}
	routes.Set(map[string]Route{"env/web": {Upstream: up.URL, PublicHost: "preview.example.com"}})
	w := httptest.NewRecorder()
	RouteHandler(routes, "env/web").ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:1234/callback", nil))
	if w.Code != 204 {
		t.Fatal(w.Code)
	}
}

func TestReverseProxyStreamsBeforeUpstreamCompletes(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: ready\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer up.Close()
	routes := &Routes{}
	routes.Set(map[string]Route{"fixed": {Upstream: up.URL}})
	proxy := httptest.NewServer(RouteHandler(routes, "fixed"))
	defer proxy.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", proxy.URL, nil)
	res, e := http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	line, e := bufio.NewReader(res.Body).ReadString('\n')
	if e != nil || line != "data: ready\n" {
		t.Fatalf("SSE buffered: %q %v", line, e)
	}
}
func TestReverseProxyForwardsUpgradedConnections(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, rw, e := w.(http.Hijacker).Hijack()
		if e != nil {
			return
		}
		defer c.Close()
		_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
		_ = rw.Flush()
		_, _ = io.Copy(c, rw)
	}))
	defer up.Close()
	routes := &Routes{}
	routes.Set(map[string]Route{"fixed": {Upstream: up.URL}})
	proxy := httptest.NewServer(RouteHandler(routes, "fixed"))
	defer proxy.Close()
	c, e := net.DialTimeout("tcp", strings.TrimPrefix(proxy.URL, "http://"), time.Second)
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	_, _ = io.WriteString(c, "GET / HTTP/1.1\r\nHost: preview.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
	reader := bufio.NewReader(c)
	res, e := http.ReadResponse(reader, nil)
	if e != nil || res.StatusCode != 101 {
		t.Fatal("upgrade failed", e)
	}
	_, _ = io.WriteString(c, "ping")
	b := make([]byte, 4)
	if _, e = io.ReadFull(reader, b); e != nil || string(b) != "ping" {
		t.Fatal("upgraded bytes not forwarded", e)
	}
}
