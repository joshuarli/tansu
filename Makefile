build: build-ts build-rs

build-ts:
	bun build web/ts/main.ts --outfile web/static/app.js --minify

build-rs:
	cargo build

check:
	bun tsc
	cargo check

dev:
	bun build web/ts/main.ts --outfile web/static/app.js --watch &
	cargo run -- ~/notes --port 3000
