package hub

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"time"
)

const DeployStreamType = "application/x-ndjson"

type DeployEvent struct {
	Version int    `json:"version"`
	Type    string `json:"type"`
	Message string `json:"message,omitempty"`
	Output  []byte `json:"output,omitempty"`
	Data    any    `json:"data,omitempty"`
	Error   string `json:"error,omitempty"`
}
type progressKey struct{}

func progressOutput(ctx context.Context) io.Writer {
	if w, ok := ctx.Value(progressKey{}).(io.Writer); ok {
		return w
	}
	return io.Discard
}
func deploymentOutput(ctx context.Context) io.Writer {
	return io.MultiWriter(os.Stderr, progressOutput(ctx))
}
func progress(ctx context.Context, format string, args ...any) {
	_, _ = fmt.Fprintf(deploymentOutput(ctx), "[contremaitre] "+format+"\n", args...)
}

// Only the private control socket exposes this stream. Writes are bounded and
// serialized with heartbeats; a disconnected client cancels its deployment.
type deployStream struct {
	mu     sync.Mutex
	w      http.ResponseWriter
	cancel context.CancelFunc
	err    error
}

func (s *deployStream) send(event DeployEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return
	}
	controller := http.NewResponseController(s.w)
	_ = controller.SetWriteDeadline(time.Now().Add(10 * time.Second))
	s.err = json.NewEncoder(s.w).Encode(event)
	if s.err == nil {
		s.err = controller.Flush()
	}
	if s.err != nil {
		s.cancel()
	}
}
func (s *deployStream) Write(p []byte) (int, error) {
	n := len(p)
	for len(p) > 0 {
		size := min(len(p), 16*1024)
		s.send(DeployEvent{Version: 1, Type: "log", Output: p[:size]})
		p = p[size:]
	}
	// Log delivery must not prevent recovery from writing its private diagnostics.
	return n, nil
}
func serveDeploy(w http.ResponseWriter, r *http.Request, deploy func(context.Context) (*Environment, error)) {
	if r.Header.Get("Accept") != DeployStreamType {
		data, err := deploy(r.Context())
		writeResult(w, data, err)
		return
	}
	w.Header().Set("Content-Type", DeployStreamType)
	w.Header().Set("Cache-Control", "no-store")
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	stream := &deployStream{w: w, cancel: cancel}
	ctx = context.WithValue(ctx, progressKey{}, io.Writer(stream))
	progress(ctx, "Deployment requested; waiting for the hub")
	started := time.Now()
	done, stopped := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				stream.send(DeployEvent{Version: 1, Type: "log", Message: fmt.Sprintf("[contremaitre] Deployment still running (%s elapsed)\n", time.Since(started).Round(time.Second))})
			}
		}
	}()
	data, err := deploy(ctx)
	close(done)
	<-stopped
	event := DeployEvent{Version: 1, Type: "result", Data: data}
	if err != nil {
		event.Data = nil
		event.Error = err.Error()
		progress(ctx, "Deployment failed after %s", time.Since(started).Round(time.Second))
	} else {
		progress(ctx, "Deployment ready after %s", time.Since(started).Round(time.Second))
	}
	stream.send(event)
}
