# Go compatibility reference

`go/` preserves the last Go implementation at `280b6cd3`. It is excluded from the
TypeScript runtime and standalone executable. Keep it during the rollback window
as a state/protocol reference and a way to reproduce the previous executable.

```sh
make compat-check
cd compat/go
go build -o ../../bin/contremaitre-go ./cmd/contremaitre
```

The normal build and install targets use Bun. No command in the new executable
calls this Go code. Remove this reference after the migration's rollback window,
once the compatibility fixtures cover the supported version 1 formats.
