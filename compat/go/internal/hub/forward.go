package hub

import (
	"context"
	"fmt"
	"io"
	"net"
	"sync"
	"time"
)

// This optional privileged process only forwards loopback TCP. It never opens hub state or starts VMs.
func ForwardHTTP(ctx context.Context) error {
	listener, e := net.Listen("tcp", "127.0.0.1:80")
	if e != nil {
		return fmt.Errorf("port-80 forwarding requires administrator access and a free port: %w", e)
	}
	defer listener.Close()
	stop := context.AfterFunc(ctx, func() { listener.Close() })
	defer stop()
	slots := make(chan struct{}, 256)
	var wg sync.WaitGroup
	defer wg.Wait()
	for {
		client, e := listener.Accept()
		if e != nil {
			if ctx.Err() != nil {
				return nil
			}
			return e
		}
		select {
		case slots <- struct{}{}:
		default:
			client.Close()
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-slots }()
			defer client.Close()
			up, e := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", "127.0.0.1:8080")
			if e != nil {
				return
			}
			defer up.Close()
			cancel := context.AfterFunc(ctx, func() { client.Close(); up.Close() })
			defer cancel()
			done := make(chan struct{})
			go func() {
				_, _ = io.Copy(up, client)
				if c, ok := up.(*net.TCPConn); ok {
					_ = c.CloseWrite()
				}
				close(done)
			}()
			_, _ = io.Copy(client, up)
			client.Close()
			up.Close()
			<-done
		}()
	}
}
