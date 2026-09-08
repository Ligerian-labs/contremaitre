package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
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

func TestDeployStreamDoesNotMistakeProgressForSuccess(t *testing.T) {
	home, e := os.MkdirTemp("/tmp", "cm-stream-")
	if e != nil {
		t.Fatal(e)
	}
	defer os.RemoveAll(home)
	listener, e := net.Listen("unix", filepath.Join(home, "hub.sock"))
	if e != nil {
		t.Fatal(e)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		_, _ = w.Write([]byte("{\"version\":1,\"type\":\"log\",\"message\":\"Building api\\n\"}\n{\"version\":1,\"type\":\"result\",\"error\":\"migration failed\"}\n"))
	})}
	go func() { _ = server.Serve(listener) }()
	defer server.Close()
	if err := call(context.Background(), options{home: home}, "deploy", hub.Request{}, nil); err == nil || err.Error() != "migration failed" {
		t.Fatalf("deployment progress hid the final failure: %v", err)
	}
}

func TestDeployStreamResultAndTruncation(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(fmt.Sprint(failed), func(t *testing.T) {
			message := strings.Repeat("x", 128*1024) + "\n"
			log, _ := json.Marshal(map[string]any{"version": 1, "type": "log", "message": message})
			stream := string(log) + "\n"
			if !failed {
				stream += "{\"version\":1,\"type\":\"result\",\"data\":{\"answer\":42}}\n"
			}
			var logs bytes.Buffer
			var result struct{ Answer int }
			err := readDeployStream(strings.NewReader(stream), &logs, &result)
			if failed && err == nil {
				t.Fatal("truncated stream reported success")
			}
			if !failed && (err != nil || result.Answer != 42) {
				t.Fatalf("lost final JSON result: %v %#v", err, result)
			}
			if logs.String() != message {
				t.Fatal("large log line was truncated or mixed with result")
			}
		})
	}
}

func TestDeployStreamPreservesSplitUTF8(t *testing.T) {
	original := []byte("Déploiement 🚀\n")
	var input bytes.Buffer
	for _, b := range original {
		_ = json.NewEncoder(&input).Encode(hub.DeployEvent{Version: 1, Type: "log", Output: []byte{b}})
	}
	_ = json.NewEncoder(&input).Encode(hub.DeployEvent{Version: 1, Type: "result"})
	var output bytes.Buffer
	if err := readDeployStream(&input, &output, nil); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(output.Bytes(), original) {
		t.Fatalf("log bytes changed: %q", output.String())
	}
}
