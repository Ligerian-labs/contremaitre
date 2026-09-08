package hub

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDeploymentLogsArriveBeforeCompletion(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serveDeploy(w, r, func(ctx context.Context) (*Environment, error) {
			progress(ctx, "Building api")
			select {
			case <-release:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			return nil, errors.New("migration failed")
		})
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "POST", server.URL, nil)
	req.Header.Set("Accept", DeployStreamType)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	decoder := json.NewDecoder(response.Body)
	for {
		var event DeployEvent
		if err = decoder.Decode(&event); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(event.Message+string(event.Output), "Building api") {
			break
		}
		if event.Type == "result" {
			t.Fatal("deployment completed before its logs arrived")
		}
	}
	close(release)
	for {
		var event DeployEvent
		if err = decoder.Decode(&event); err != nil {
			t.Fatal(err)
		}
		if event.Type == "result" {
			if event.Error != "migration failed" {
				t.Fatal(event)
			}
			break
		}
	}
}
func TestDeploymentDisconnectCancelsWork(t *testing.T) {
	finished := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serveDeploy(w, r, func(ctx context.Context) (*Environment, error) {
			<-ctx.Done()
			close(finished)
			return nil, ctx.Err()
		})
	}))
	defer server.Close()
	req, _ := http.NewRequest("POST", server.URL, nil)
	req.Header.Set("Accept", DeployStreamType)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	select {
	case <-finished:
	case <-time.After(3 * time.Second):
		t.Fatal("disconnected deployment still running")
	}
}
func TestRuntimeStreamsBuildAndMigrationOutput(t *testing.T) {
	root := t.TempDir()
	executable := filepath.Join(root, "container")
	if err := os.WriteFile(executable, []byte("#!/bin/sh\necho stdout-progress\necho stderr-progress >&2\n"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, operation := range []string{"build", "migration"} {
		t.Run(operation, func(t *testing.T) {
			var output strings.Builder
			ctx := context.WithValue(context.Background(), progressKey{}, io.Writer(&output))
			runtime := Apple{Binary: executable}
			var err error
			if operation == "build" {
				err = runtime.Build(ctx, root, "Dockerfile", "test")
			} else {
				err = runtime.Run(ctx, RunSpec{Task: true, Image: "test"})
			}
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(output.String(), "stdout-progress") || !strings.Contains(output.String(), "stderr-progress") {
				t.Fatal(output.String())
			}
		})
	}
}
func TestDriverStreamsDiagnosticsWithoutProtocolOrCrossRequestLeak(t *testing.T) {
	directory := t.TempDir()
	executable := filepath.Join(directory, "driver")
	script := "#!/bin/sh\necho 'Applying release' >&2\necho '{\"version\":1,\"status\":\"stopped\"}'\n"
	if err := os.WriteFile(executable, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	env := &Environment{Driver: &ProjectDriver{Executable: executable, TimeoutSeconds: 5}, DriverDirectory: directory}
	var output strings.Builder
	ctx := context.WithValue(context.Background(), progressKey{}, io.Writer(&output))
	if _, err := invokeDriver(ctx, env, "deploy", nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "Applying release") || strings.Contains(output.String(), `"status"`) {
		t.Fatal(output.String())
	}
	before := output.String()
	if _, err := invokeDriver(context.Background(), env, "status", nil); err != nil {
		t.Fatal(err)
	}
	if output.String() != before {
		t.Fatal("logs leaked across requests")
	}
	saved, err := os.ReadFile(filepath.Join(directory, "driver.log"))
	if err != nil || !strings.Contains(string(saved), "Applying release") {
		t.Fatal("lost private diagnostic log")
	}
}
