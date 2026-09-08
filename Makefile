.PHONY: build test check install compat-check
build:
	bun run build
test:
	bun test
check:
	bun run check
compat-check:
	cd compat/go && go vet ./... && go test -race ./...
install: build
	install -d $(HOME)/.local/bin
	install bin/contremaitre $(HOME)/.local/bin/contremaitre
