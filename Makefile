.PHONY: build test check install
build:
	bun run build
test:
	bun test
check:
	bun run check
install: build
	install -d $(HOME)/.local/bin
	install bin/contremaitre $(HOME)/.local/bin/contremaitre
