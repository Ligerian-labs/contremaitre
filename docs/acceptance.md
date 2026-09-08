# Local runtime acceptance

Implement the CLI and local daemon in Go, using Apple container on macOS 26 / Apple silicon.

- Strict YAML manifests describe images/builds, commands, dependencies, environment references, persistent files, and initialization.
- Git worktrees and Jujutsu workspaces get separate environments. Branch changes select separate environments; unbookmarked Jujutsu work remains tied to its workspace.
- Deploy builds working files before replacing running services, retains existing data, and records recoverable failures.
- New environments clone the explicitly designated main environment's Postgres databases and declared uploaded files. Pause source application writers and always attempt to resume them. Redis starts empty.
- A local daemon routes environment .localhost domains, holds an exclusive state lock, and supervises optional tunnel provider processes.
- Exec forwards arguments and standard streams. Proxy binds loopback and supports an automatically assigned free port.
- Down and stop retain data. Data deletion requires an explicit flag. Prune only removes recorded Contremaitre resources.
- Tunnel providers reserve stable URLs separately from connections and can be replaced without changing local deployment code.
- Focused lifecycle tests, race tests, vet, build, and an Apple container smoke test verify behavior.

The repository initially had no commits or remote. An empty main baseline was created solely to base the dedicated implementation workspace. No implementation files belong in the default workspace.

The sibling tunnel repository currently has no contract or implementation. The local executable provider protocol will be documented and tested; production SaaS compatibility requires the actual connector.
