.PHONY: build test check install
build:
	bun run build
test:
	bun test
check:
	bun run check
install: build
	bun scripts/install.ts
