build: check build-ts build-rs

build-ts:
	bun run oxfmt --check web/ts/
	bun build web/ts/main.ts --outfile web/static/app.js --minify

build-rs:
	cargo build

check:
	bunx tsc
	cargo check

lint-ts:
	bun run oxlint web/ts/

ts: lint-ts
	bun run oxfmt web/ts/
	bunx tsc --noEmit --pretty false
	bun build web/ts/main.ts --outfile web/static/app.js --target browser --format esm

dev: ts
	cargo run --bin tansu -- $(NOTES_DIR) --port 3000

NOTES_DIR ?= ~/notes

bench:
	cargo bench --bench index

bench-quick:
	cargo run --bin bench -- $(NOTES_DIR)

setup:
	prek install --install-hooks

pc:
	prek run --all-files

clean:
	rm -rf $(NOTES_DIR)/.tansu/index
