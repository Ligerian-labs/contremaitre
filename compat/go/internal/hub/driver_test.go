package hub

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProjectDriverManifest(t *testing.T) {
	_, err := ParseManifest([]byte("version: 1\nproject: orchestrator\ndriver:\n  executable: bin/local-stack.py\n"))
	if err != nil {
		t.Fatalf("a project with its own deployment lifecycle cannot be configured: %v", err)
	}
}

func TestDriverLifecycleForksAndRetainsData(t *testing.T) {
	root := t.TempDir()
	script := `#!/usr/bin/env python3
import json,os,pathlib,shutil,sys
r=json.loads(pathlib.Path(os.environ['CONTREMAITRE_REQUEST']).read_text())
s=pathlib.Path(r['environment']['state_directory'])
a=r['operation']
if a=='clone':
 shutil.copyfile(pathlib.Path(r['source']['state_directory'])/'data',s/'data')
if a=='deploy' and not (s/'data').exists(): (s/'data').write_text('fresh')
if a=='exec': sys.stdout.write((s/'data').read_text()); sys.exit(int(r['arguments'][0]))
if a=='delete': (s/'deleted').write_text('yes')
print(json.dumps({'version':1,'status':'running' if a in ['deploy','status'] else 'stopped','services':{'web':{'host':'127.0.0.1','port':9000,'http':True}}}))
`
	if err := os.WriteFile(filepath.Join(root, "driver.py"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".contremaitre.yaml"), []byte("version: 1\nproject: testdriver\ndriver:\n  executable: driver.py\n"), 0600); err != nil {
		t.Fatal(err)
	}
	runtime := fake()
	manager, err := NewManager(Store{t.TempDir()}, runtime)
	if err != nil {
		t.Fatal(err)
	}
	main, err := manager.Deploy(context.Background(), DeployRequest{Root: root, Branch: "main", Main: true})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(main.DriverDirectory, "data"), []byte("main data"), 0600); err != nil {
		t.Fatal(err)
	}
	feature, err := manager.Deploy(context.Background(), DeployRequest{Root: root, Branch: "feature"})
	if err != nil {
		t.Fatal(err)
	}
	if feature.DriverDirectory == main.DriverDirectory {
		t.Fatal("environments share state")
	}
	b, err := os.ReadFile(filepath.Join(feature.DriverDirectory, "data"))
	if err != nil || string(b) != "main data" {
		t.Fatalf("clone failed: %q %v", b, err)
	}
	if err = os.WriteFile(filepath.Join(feature.DriverDirectory, "data"), []byte("feature data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = manager.Down(context.Background(), feature.Identity.ID, false); err != nil {
		t.Fatal(err)
	}
	feature, err = manager.Deploy(context.Background(), DeployRequest{Root: root, Branch: "feature"})
	if err != nil {
		t.Fatal(err)
	}
	b, err = os.ReadFile(filepath.Join(feature.DriverDirectory, "data"))
	if err != nil || string(b) != "feature data" {
		t.Fatalf("redeploy replaced retained data: %q %v", b, err)
	}
	// A deleted checkout must not prevent exec or cleanup of deployed resources.
	if err = os.RemoveAll(root); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	err = DriverInteractive(context.Background(), feature, "exec", "web", []string{"7"}, nil, &out, io.Discard)
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 7 || out.String() != "feature data" {
		t.Fatalf("exec stream/exit lost: %q %v", out.String(), err)
	}
	if err = manager.Down(context.Background(), feature.Identity.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(feature.DriverDirectory); !os.IsNotExist(err) {
		t.Fatal("explicit deletion retained driver state")
	}
	b, err = os.ReadFile(filepath.Join(main.DriverDirectory, "data"))
	if err != nil || string(b) != "main data" {
		t.Fatal("feature deletion affected main")
	}
	if len(runtime.events) != 0 {
		t.Fatalf("driver lifecycle touched native runtime: %v", runtime.events)
	}
}

func TestDriverRejectsUnsafeConfigurationAndReplies(t *testing.T) {
	for _, fragment := range []string{"executable: ../driver", "executable: /tmp/driver", "executable: driver\n  timeout_seconds: -1", "executable: driver\nservices:\n  web:\n    image: nginx"} {
		if _, err := ParseManifest([]byte("version: 1\nproject: test\ndriver:\n  " + fragment + "\n")); err == nil {
			t.Fatalf("accepted %s", fragment)
		}
	}
	env := &Environment{Identity: Identity{Host: "feature.project.localhost"}, Services: map[string]*ServiceState{}}
	for _, s := range []DriverService{{Host: "8.8.8.8", Port: 80, HTTP: true}, {Host: "127.0.0.1", Port: 0, HTTP: true}, {URL: "https://another.localhost"}, {URL: "file:///etc/passwd"}} {
		if err := applyDriverReply(env, DriverReply{Status: "running", Services: map[string]DriverService{"web": s}}); err == nil {
			t.Fatalf("accepted %#v", s)
		}
	}
	if err := applyDriverReply(env, DriverReply{Status: "running", Services: map[string]DriverService{"web": {Host: "127.0.0.1", Port: 9010, HTTP: true, URL: "https://feature.project.localhost:9443"}}}); err != nil {
		t.Fatal(err)
	}
	manager := &Manager{}
	if got := manager.LocalURL(env, "web"); got != "https://feature.project.localhost:9443" {
		t.Fatal(got)
	}
}

func TestFailedDriverCloneRecoversSourceWithoutLeakingDiagnostics(t *testing.T) {
	root := t.TempDir()
	script := `#!/usr/bin/env python3
import json,os,pathlib,sys
r=json.loads(pathlib.Path(os.environ['CONTREMAITRE_REQUEST']).read_text())
s=pathlib.Path(r['environment']['state_directory'])
if r['operation']=='clone':
 print('private-example-value',file=sys.stderr)
 sys.exit(2)
if r['operation']=='recover': (s/'recovered').write_text('yes')
print(json.dumps({'version':1,'status':'running' if r['operation'] in ['deploy','status'] else 'stopped','services':{'web':{'host':'127.0.0.1','port':9000,'http':True}}}))
`
	if e := os.WriteFile(filepath.Join(root, "driver.py"), []byte(script), 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(root, ".contremaitre.yaml"), []byte("version: 1\nproject: testdriver\ndriver:\n  executable: driver.py\n"), 0600); e != nil {
		t.Fatal(e)
	}
	m, e := NewManager(Store{t.TempDir()}, fake())
	if e != nil {
		t.Fatal(e)
	}
	source, e := m.Deploy(context.Background(), DeployRequest{Root: root, Branch: "main"})
	if e != nil {
		t.Fatal(e)
	}
	_, e = m.Deploy(context.Background(), DeployRequest{Root: root, Branch: "feature"})
	if e == nil || strings.Contains(e.Error(), "private-example-value") {
		t.Fatalf("unexpected public error: %v", e)
	}
	if _, e = os.Stat(filepath.Join(source.DriverDirectory, "recovered")); e != nil {
		t.Fatal("source recovery was not invoked")
	}
	for _, env := range m.State.Environments {
		if env.Identity.ID != source.Identity.ID && (env.Status != "failed" || env.CloneComplete) {
			t.Fatal("failed clone was recorded as complete")
		}
		info, e := os.Stat(filepath.Join(env.DriverDirectory, "driver.log"))
		if e != nil || info.Mode().Perm() != 0600 {
			t.Fatal("driver diagnostics are not private")
		}
	}
}

func TestDriverDeadlineStopsChildProcesses(t *testing.T) {
	directory := t.TempDir()
	executable := filepath.Join(directory, "driver")
	if e := os.WriteFile(executable, []byte("#!/bin/sh\nsleep 20\n"), 0700); e != nil {
		t.Fatal(e)
	}
	env := &Environment{Driver: &ProjectDriver{Executable: executable, TimeoutSeconds: 1}, DriverDirectory: directory}
	start := time.Now()
	if _, e := invokeDriver(context.Background(), env, "deploy", nil); e == nil {
		t.Fatal("driver exceeded its deadline without failing")
	}
	if time.Since(start) > 8*time.Second {
		t.Fatal("driver descendants outlived cancellation")
	}
	files, e := filepath.Glob(filepath.Join(directory, "request-*.json"))
	if e != nil || len(files) != 0 {
		t.Fatal("private request files were not removed")
	}
}
