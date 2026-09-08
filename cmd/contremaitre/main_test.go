package main

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"contremaitre/internal/hub"
)

func TestExecSeparatorPreservesApplicationFlags(t *testing.T) {
	o, e := parse([]string{"exec", "api", "--env", "shop/main", "--", "tool", "--env", "application", "--json"})
	if e != nil {
		t.Fatal(e)
	}
	if o.selector != "shop/main" || o.json || len(o.command) != 4 || o.command[1] != "--env" {
		t.Fatalf("application arguments were consumed: %#v", o)
	}
}
func TestEmptySuccessResponse(t *testing.T) {
	home, e := os.MkdirTemp("/tmp", "cm-client-")
	if e != nil {
		t.Fatal(e)
	}
	defer os.RemoveAll(home)
	listener, e := net.Listen("unix", filepath.Join(home, "hub.sock"))
	if e != nil {
		t.Fatal(e)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{"version":1}`)) })}
	go func() { _ = server.Serve(listener) }()
	defer server.Close()
	var result any
	if e = call(context.Background(), options{home: home}, "stop", hub.Request{}, &result); e != nil {
		t.Fatalf("empty successful response failed: %v", e)
	}
}
