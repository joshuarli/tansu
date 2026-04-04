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

fmt-ts:
	bun run oxfmt web/ts/

dev:
	bun build web/ts/main.ts --outfile web/static/app.js --watch &
	cargo run --bin tansu -- $(NOTES_DIR) --port 3000

NOTES_DIR ?= ~/notes

bench:
	cargo bench --bench index

bench-quick:
	cargo run --bin bench -- $(NOTES_DIR)

clean:
	rm -rf $(NOTES_DIR)/.tansu/index
