package hub

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"go.yaml.in/yaml/v3"
)

type Manifest struct {
	Version  int                `yaml:"version" json:"version"`
	Project  string             `yaml:"project" json:"project"`
	Services map[string]Service `yaml:"services" json:"services"`
}
type Service struct {
	Kind        string            `yaml:"kind,omitempty" json:"kind,omitempty"`
	Image       string            `yaml:"image,omitempty" json:"image,omitempty"`
	Build       string            `yaml:"build,omitempty" json:"build,omitempty"`
	Dockerfile  string            `yaml:"dockerfile,omitempty" json:"dockerfile,omitempty"`
	Command     []string          `yaml:"command,omitempty" json:"command,omitempty"`
	Port        int               `yaml:"port,omitempty" json:"port,omitempty"`
	HTTP        bool              `yaml:"http,omitempty" json:"http,omitempty"`
	DependsOn   []string          `yaml:"depends_on,omitempty" json:"depends_on,omitempty"`
	Environment map[string]string `yaml:"environment,omitempty" json:"environment,omitempty"`
	EnvFile     string            `yaml:"env_file,omitempty" json:"env_file,omitempty"`
	Volumes     map[string]string `yaml:"volumes,omitempty" json:"volumes,omitempty"`
	Init        []string          `yaml:"init,omitempty" json:"init,omitempty"`
	Migrate     []string          `yaml:"migrate,omitempty" json:"migrate,omitempty"`
	Ready       []string          `yaml:"ready,omitempty" json:"ready,omitempty"`
	CPUs        int               `yaml:"cpus,omitempty" json:"cpus,omitempty"`
	Memory      string            `yaml:"memory,omitempty" json:"memory,omitempty"`
}

var validName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,39}$`)
var memoryPattern = regexp.MustCompile(`^[1-9][0-9]*[MG]$`)

func LoadManifest(dir string) (Manifest, string, error) {
	for _, name := range []string{".contremaitre.yaml", ".contremaitre.yml"} {
		p := filepath.Join(dir, name)
		b, e := os.ReadFile(p)
		if os.IsNotExist(e) {
			continue
		}
		if e != nil {
			return Manifest{}, "", e
		}
		m, e := ParseManifest(b)
		return m, p, e
	}
	return Manifest{}, "", fmt.Errorf("no .contremaitre.yaml in %s; run contremaitre init", dir)
}
func ParseManifest(b []byte) (Manifest, error) {
	var m Manifest
	d := yaml.NewDecoder(bytes.NewReader(b))
	d.KnownFields(true)
	if e := d.Decode(&m); e != nil {
		return m, e
	}
	var extra any
	if e := d.Decode(&extra); e != io.EOF {
		return m, fmt.Errorf("manifest must contain one YAML document")
	}
	if m.Version != 1 {
		return m, fmt.Errorf("manifest version must be 1")
	}
	if !validName.MatchString(m.Project) {
		return m, fmt.Errorf("project must be a lowercase DNS label, at most 40 characters")
	}
	if len(m.Services) == 0 {
		return m, fmt.Errorf("at least one service is required")
	}

	for name, s := range m.Services {
		if !validName.MatchString(name) {
			return m, fmt.Errorf("invalid service name %q", name)
		}
		switch s.Kind {
		case "", "app":
			s.Kind = "app"
		case "postgres":
			if s.Image == "" {
				s.Image = "postgres:17"
			}
			if s.Port == 0 {
				s.Port = 5432
			}
		case "redis":
			if s.Image == "" {
				s.Image = "redis:7-alpine"
			}
			if s.Port == 0 {
				s.Port = 6379
			}
		default:
			return m, fmt.Errorf("%s: unknown kind %q", name, s.Kind)
		}
		if (s.Image == "") == (s.Build == "") {
			return m, fmt.Errorf("%s: specify exactly one of image or build", name)
		}
		if s.Kind != "app" && (s.Build != "" || len(s.Volumes) > 0 || len(s.Init) > 0 || len(s.Migrate) > 0 || s.EnvFile != "" || len(s.Environment) > 0 || len(s.Command) > 0) {
			return m, fmt.Errorf("%s: managed databases cannot override storage, credentials, command or initialization", name)
		}
		if s.Port < 0 || s.Port > 65535 {
			return m, fmt.Errorf("%s: invalid port", name)
		}
		if s.HTTP {

			if s.Kind != "app" || s.Port == 0 {
				return m, fmt.Errorf("%s: http requires an app port", name)
			}
		}
		if s.CPUs == 0 {
			s.CPUs = 1
		}
		if s.CPUs < 1 || s.CPUs > 64 {
			return m, fmt.Errorf("%s: cpus must be 1..64", name)
		}
		if s.Memory == "" {
			s.Memory = "512M"
		}
		if !memoryPattern.MatchString(s.Memory) {
			return m, fmt.Errorf("%s: memory must be a positive integer with M or G suffix", name)
		}
		for volume, target := range s.Volumes {
			if !validName.MatchString(volume) || !strings.HasPrefix(target, "/") || strings.ContainsAny(target, ",:\n") || filepath.Clean(target) == "/" {
				return m, fmt.Errorf("%s: invalid persistent volume %q", name, volume)
			}
		}
		for key, value := range s.Environment {
			if !regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`).MatchString(key) || strings.ContainsAny(value, "\n\r") {
				return m, fmt.Errorf("%s: invalid environment entry", name)
			}
		}
		for _, p := range []string{s.Build, s.Dockerfile, s.EnvFile} {
			if p != "" && (filepath.IsAbs(p) || p == ".." || strings.HasPrefix(filepath.Clean(p), "../")) {
				return m, fmt.Errorf("%s: paths must stay within the project", name)
			}
		}
		m.Services[name] = s
	}

	_, e := m.Order()
	return m, e
}
func (m Manifest) Order() ([]string, error) {
	var out []string
	seen := map[string]int{}
	var visit func(string) error
	visit = func(n string) error {
		if seen[n] == 2 {
			return nil
		}
		if seen[n] == 1 {
			return fmt.Errorf("dependency cycle involving %s", n)
		}
		s, ok := m.Services[n]
		if !ok {
			return fmt.Errorf("unknown dependency %s", n)
		}
		seen[n] = 1
		for _, dep := range s.DependsOn {
			if e := visit(dep); e != nil {
				return e
			}
		}
		seen[n] = 2
		out = append(out, n)
		return nil
	}
	names := make([]string, 0, len(m.Services))
	for n := range m.Services {
		names = append(names, n)
	}
	sort.Slice(names, func(i, j int) bool {
		a, b := m.Services[names[i]].Kind != "app", m.Services[names[j]].Kind != "app"
		if a != b {
			return a
		}
		return names[i] < names[j]
	})
	for _, n := range names {
		if e := visit(n); e != nil {
			return nil, e
		}
	}
	return out, nil
}
func SafePath(root, rel string) (string, error) {
	if rel == "" {
		rel = "."
	}
	p, e := filepath.EvalSymlinks(filepath.Join(root, rel))
	if e != nil {
		return "", e
	}
	base, e := filepath.EvalSymlinks(root)
	if e != nil {
		return "", e
	}
	r, e := filepath.Rel(base, p)
	if e != nil || r == ".." || strings.HasPrefix(r, "../") {
		return "", fmt.Errorf("path escapes project: %s", rel)
	}
	return p, nil
}

// Freeze env-file values and validate references before changing any running environment.
func prepareManifest(root string, m Manifest) (Manifest, error) {
	for name, s := range m.Services {
		values := map[string]string{}
		if s.EnvFile != "" {
			p, e := SafePath(root, s.EnvFile)
			if e != nil {
				return m, e
			}
			b, e := os.ReadFile(p)
			if e != nil {
				return m, e
			}
			for _, line := range strings.Split(string(b), "\n") {
				line = strings.TrimSpace(line)
				if line == "" || strings.HasPrefix(line, "#") {
					continue
				}
				k, v, ok := strings.Cut(line, "=")
				if !ok {
					return m, fmt.Errorf("%s: invalid env_file line", name)
				}
				values[strings.TrimSpace(k)] = strings.Trim(v, "\"'")
			}
		}
		for k, v := range s.Environment {
			values[k] = v
		}
		for k, v := range values {
			if !envKeyPattern.MatchString(k) || strings.ContainsAny(v, "\r\n") {
				return m, fmt.Errorf("%s: invalid environment entry", name)
			}
		}
		s.Environment = values
		s.EnvFile = ""
		m.Services[name] = s
	}
	token := regexp.MustCompile(`\{\{([^{}]+)\}\}`)
	for name, s := range m.Services {
		for _, v := range s.Environment {
			for _, match := range token.FindAllStringSubmatch(v, -1) {
				if match[1] == "contremaitre.url" || match[1] == "contremaitre.local_url" {
					continue
				}
				parts := strings.Split(match[1], ".")
				if len(parts) != 2 || (parts[1] != "host" && parts[1] != "port" && parts[1] != "url") {
					return m, fmt.Errorf("%s: unsupported environment reference", name)
				}
				if _, ok := m.Services[parts[0]]; !ok {
					return m, fmt.Errorf("%s: unknown service reference %s", name, parts[0])
				}
				seen := map[string]bool{}
				var depends func(string) bool
				depends = func(n string) bool {
					if seen[n] {
						return false
					}
					seen[n] = true
					for _, d := range m.Services[n].DependsOn {
						if d == parts[0] || depends(d) {
							return true
						}
					}
					return false
				}
				if !depends(name) {
					return m, fmt.Errorf("%s: declare depends_on for %s", name, parts[0])
				}
			}
			if strings.Contains(token.ReplaceAllString(v, ""), "{{") {
				return m, fmt.Errorf("%s: malformed environment reference", name)
			}
		}
	}
	return m, nil
}
