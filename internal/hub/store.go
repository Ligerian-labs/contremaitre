package hub

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"syscall"
	"time"
)

type ServiceState struct {
	URL                                string            `json:"url,omitempty"`
	RawEnvironment                     map[string]string `json:"raw_environment,omitempty"`
	Name, Container, Image, IP, Volume string
	Port                               int
	HTTP                               bool
	Spec                               Service
	Initialized                        bool
}
type Environment struct {
	Driver                       *ProjectDriver `json:"driver,omitempty"`
	DriverDirectory              string         `json:"driver_directory,omitempty"`
	Identity                     Identity
	Root, Status, Error, Network string
	Services                     map[string]*ServiceState
	Credentials                  map[string]string `json:"credentials,omitempty"`
	Volumes                      []string
	Images                       []string
	CloneComplete                bool
	CreatedAt                    time.Time
	UpdatedAt                    time.Time
	Tunnels                      map[string]*TunnelReservation `json:"tunnels,omitempty"`
}
type State struct {
	Version      int
	Environments map[string]*Environment
	Main         map[string]string
}

func NewState() *State {
	return &State{Version: 1, Environments: map[string]*Environment{}, Main: map[string]string{}}
}

type Store struct{ Home string }

func (s Store) Load() (*State, error) {
	b, e := os.ReadFile(filepath.Join(s.Home, "state.json"))
	if os.IsNotExist(e) {
		return NewState(), nil
	}
	if e != nil {
		return nil, e
	}
	var state State
	if e = json.Unmarshal(b, &state); e != nil {
		return nil, e
	}
	if state.Version != 1 || state.Environments == nil || state.Main == nil {
		return nil, fmt.Errorf("unsupported or invalid state file")
	}
	return &state, nil
}
func (s Store) Save(state *State) error {
	b, e := json.MarshalIndent(state, "", "  ")
	if e != nil {
		return e
	}
	return atomicWrite(filepath.Join(s.Home, "state.json"), b, 0600)
}
func atomicWrite(path string, b []byte, mode os.FileMode) error {
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".write-")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if e = f.Chmod(mode); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e != nil {
		return e
	}
	if ce != nil {
		return ce
	}
	return os.Rename(f.Name(), path)
}
func Lock(home string) (*os.File, error) {
	if e := os.MkdirAll(home, 0700); e != nil {
		return nil, e
	}
	f, e := os.OpenFile(filepath.Join(home, "daemon.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		f.Close()
		return nil, fmt.Errorf("hub already running or state is locked: %w", e)
	}
	return f, nil
}
func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
func publicEnvironment(e *Environment) *Environment {
	b, _ := json.Marshal(e)
	var out Environment
	_ = json.Unmarshal(b, &out)
	out.Credentials = nil
	for _, s := range out.Services {
		s.RawEnvironment = nil
		s.Spec.Environment = nil
		s.Spec.EnvFile = ""
	}
	return &out
}

func (s Store) Namespace() string {
	home, e := filepath.EvalSymlinks(s.Home)
	if e != nil {
		home = s.Home
	}
	sum := sha256.Sum256([]byte(home))
	return fmt.Sprintf("cm-%x", sum[:3])
}
func resourceName(prefix, name string) string {
	if len(name) > 30 {
		hash := sha256.Sum256([]byte(name))
		name = name[:23] + fmt.Sprintf("-%x", hash[:3])
	}
	return prefix + "-" + name
}
