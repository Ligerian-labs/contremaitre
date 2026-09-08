package hub

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"go.yaml.in/yaml/v3"
)

func InitProject(dir, compose string) (string, error) {
	target := filepath.Join(dir, ".contremaitre.yaml")
	if _, e := os.Stat(target); e == nil {
		return "", fmt.Errorf("manifest already exists")
	}
	m := Manifest{Version: 1, Project: Slug(filepath.Base(dir)), Services: map[string]Service{}}
	if compose != "" {
		b, e := os.ReadFile(filepath.Join(dir, compose))
		if e != nil {
			return "", e
		}
		m, e = ImportCompose(b, m.Project)
		if e != nil {
			return "", e
		}
	} else if _, e := os.Stat(filepath.Join(dir, "Dockerfile")); e == nil {
		m.Services["web"] = Service{Build: ".", Port: 3000, HTTP: true}
	} else if b, e := os.ReadFile(filepath.Join(dir, "package.json")); e == nil {
		var pkg struct {
			Scripts map[string]string `json:"scripts"`
		}
		if e = json.Unmarshal(b, &pkg); e != nil {
			return "", e
		}
		if pkg.Scripts["start"] == "" {
			return "", fmt.Errorf("package.json needs a start script, or provide a Dockerfile")
		}
		install := "npm ci"
		runner := "npm"
		if _, e = os.Stat(filepath.Join(dir, "pnpm-lock.yaml")); e == nil {
			install = "corepack enable && pnpm install --frozen-lockfile"
			runner = "pnpm"
		} else if _, e = os.Stat(filepath.Join(dir, "package-lock.json")); e != nil {
			return "", fmt.Errorf("commit a package-lock.json or pnpm-lock.yaml, or supply a Dockerfile")
		}
		build := ""
		if pkg.Scripts["build"] != "" {
			build = "RUN " + runner + " run build\n"
		}
		dockerfile := "FROM node:22-bookworm-slim\nWORKDIR /app\nCOPY . .\nRUN " + install + "\n" + build + "ENV HOST=0.0.0.0 PORT=3000\nEXPOSE 3000\nCMD [\"" + runner + "\", \"run\", \"start\"]\n"
		if e = writeNew(filepath.Join(dir, "Dockerfile.contremaitre"), []byte(dockerfile)); e != nil {
			return "", e
		}
		ignore := []byte(".git\n.jj\nnode_modules\n.env\n.env.*\n*.pem\n*.key\n")
		if e = writeNew(filepath.Join(dir, "Dockerfile.contremaitre.dockerignore"), ignore); e != nil {
			return "", e
		}
		m.Services["web"] = Service{Build: ".", Dockerfile: "Dockerfile.contremaitre", Port: 3000, HTTP: true}
	} else {
		return "", fmt.Errorf("no convention detected; add a Dockerfile or use the example manifest")
	}
	b, e := yaml.Marshal(m)
	if e != nil {
		return "", e
	}
	if _, e = ParseManifest(b); e != nil {
		return "", e
	}
	if e = writeNew(target, b); e != nil {
		return "", e
	}
	return target, nil
}
func writeNew(path string, b []byte) error {
	f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if e != nil {
		return e
	}
	_, e = f.Write(b)
	ce := f.Close()
	if e != nil {
		return e
	}
	return ce
}

// Import an explicit subset. Reject unsupported semantics instead of silently dropping them.
func ImportCompose(b []byte, project string) (Manifest, error) {
	var doc map[string]yaml.Node
	if e := yaml.Unmarshal(b, &doc); e != nil {
		return Manifest{}, e
	}
	for k := range doc {
		if k != "name" && k != "services" && k != "volumes" && k != "version" {
			return Manifest{}, fmt.Errorf("compose %s is unsupported; write an explicit manifest", k)
		}
	}
	if n, ok := doc["name"]; ok {
		project = Slug(n.Value)
	}
	var services map[string]map[string]yaml.Node
	n, ok := doc["services"]
	if !ok {
		return Manifest{}, fmt.Errorf("compose services missing")
	}
	if e := n.Decode(&services); e != nil {
		return Manifest{}, e
	}
	m := Manifest{Version: 1, Project: project, Services: map[string]Service{}}
	for name, fields := range services {
		s := Service{Environment: map[string]string{}, Volumes: map[string]string{}}
		for key, node := range fields {
			switch key {
			case "image":
				if e := node.Decode(&s.Image); e != nil {
					return m, e
				}
			case "build":
				if node.Kind == yaml.ScalarNode {
					s.Build = node.Value
				} else {
					var build map[string]string
					if e := node.Decode(&build); e != nil {
						return m, e
					}
					for k := range build {
						if k != "context" && k != "dockerfile" {
							return m, fmt.Errorf("compose build.%s unsupported", k)
						}
					}
					s.Build = build["context"]
					if s.Build == "" {
						s.Build = "."
					}
					if build["dockerfile"] != "" {
						s.Dockerfile = filepath.Join(s.Build, build["dockerfile"])
					}
				}
			case "command":
				if e := node.Decode(&s.Command); e != nil {
					return m, fmt.Errorf("compose %s.command must be an argument list", name)
				}
			case "environment":
				if e := node.Decode(&s.Environment); e != nil {
					return m, fmt.Errorf("compose environment must be a string map")
				}
				for _, v := range s.Environment {
					if strings.Contains(v, "${") {
						return m, fmt.Errorf("compose interpolation needs explicit manifest configuration")
					}
				}
			case "depends_on":
				if e := node.Decode(&s.DependsOn); e != nil {
					return m, fmt.Errorf("compose depends_on conditions need explicit ready commands")
				}
			case "ports":
				var ports []string
				if e := node.Decode(&ports); e != nil {
					return m, e
				}
				if len(ports) > 1 {
					return m, fmt.Errorf("compose multiple published ports need explicit manifest configuration")
				}
				if len(ports) == 1 {
					parts := strings.Split(ports[0], ":")
					if _, e := fmt.Sscanf(parts[len(parts)-1], "%d", &s.Port); e != nil {
						return m, e
					}
					s.HTTP = true
				}
			case "volumes":
				var mounts []string
				if e := node.Decode(&mounts); e != nil {
					return m, e
				}
				for _, mount := range mounts {
					parts := strings.Split(mount, ":")
					if len(parts) != 2 || !validName.MatchString(parts[0]) {
						return m, fmt.Errorf("compose supports named persistent volumes only")
					}
					s.Volumes[parts[0]] = parts[1]
				}
			default:
				return m, fmt.Errorf("compose %s.%s is unsupported; write an explicit manifest", name, key)
			}
		}
		if strings.HasPrefix(s.Image, "postgres:") || strings.HasPrefix(s.Image, "redis:") {
			return m, fmt.Errorf("convert %s to a managed postgres/redis service explicitly; database credentials and volume semantics cannot be imported safely", name)
		}
		m.Services[name] = s
	}
	return m, nil
}
