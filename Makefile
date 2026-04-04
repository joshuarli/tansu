build: check build-ts build-rs

build-ts:
	bun build web/ts/main.ts --outfile web/static/app.js --minify

build-rs:
	cargo build

check:
	bunx tsc
	cargo check

dev:
	bun build web/ts/main.ts --outfile web/static/app.js --watch &
	cargo run -- $(NOTES_DIR) --port 3000

NOTES_DIR ?= ~/notes

clean:
	rm -rf $(NOTES_DIR)/.tansu/index
