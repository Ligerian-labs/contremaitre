package hub

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestExecutableProviderReservesAndRetainsURL(t *testing.T) {
	home := t.TempDir()
	script := filepath.Join(home, "provider")
	source := `#!/bin/sh
case "$1" in
 capabilities) cat >/dev/null; echo '{"version":1,"capabilities":{"stable_urls":true,"https":true}}';;
 reserve) cat >/dev/null; echo '{"version":1,"reservation_id":"reservation-1","url":"https://preview.example.com"}';;
 start) cat >/dev/null; echo '{"version":1,"ready":true}'; trap 'exit 0' TERM; while :; do sleep 1; done;;
 stop|release) cat >/dev/null; echo '{"version":1}';;
 *) exit 1;;
esac
`
	if e := os.WriteFile(script, []byte(source), 0700); e != nil {
		t.Fatal(e)
	}
	cfg := map[string]any{"default": "example", "providers": map[string]ProviderConfig{"example": {Executable: script}}}
	b, _ := json.Marshal(cfg)
	if e := os.WriteFile(filepath.Join(home, "tunnels.json"), b, 0600); e != nil {
		t.Fatal(e)
	}
	manager := NewTunnelManager(home)
	defer manager.Close()
	env := &Environment{Identity: NewIdentity("shop", "/one", "main"), Tunnels: map[string]*TunnelReservation{}}
	save := func() error { return nil }
	ctx := context.Background()
	r, e := manager.Start(ctx, env, "web", "http://127.0.0.1:1234", save)
	if e != nil {
		t.Fatal(e)
	}
	if r.URL != "https://preview.example.com" || !manager.Running(env.Identity.ID, "web") {
		t.Fatal("provider did not connect")
	}
	if e = manager.Stop(ctx, env, "web", false); e != nil {
		t.Fatal(e)
	}
	if env.Tunnels["web"].ID != r.ID || env.Tunnels["web"].Desired {
		t.Fatal("stop lost reservation or retained exposure")
	}
	again, e := manager.Start(ctx, env, "web", "http://127.0.0.1:1235", save)
	if e != nil || again.URL != r.URL {
		t.Fatal("restart changed URL", e)
	}
	if e = manager.Stop(ctx, env, "web", true); e != nil {
		t.Fatal(e)
	}
	if len(env.Tunnels) != 0 {
		t.Fatal("release retained reservation")
	}
}
