# bun quiet output
AGENT = 1
export AGENT

dev: ts
	cargo run --bin tansu -- $(NOTES_DIR) --port 3000

build: check build-ts build-rs

build-rs:
	cargo build

publish-pkg:
	cd packages/md-wysiwyg && bun run build && bunx npm publish --access public

check:
	bunx tsgo
	bunx tsgo -p packages/md-wysiwyg/tsconfig.json --noEmit
	cargo check

test: test-pkg test-ts test-rs

lint-ts:
	bun run oxlint web/ts/

test-pkg:
	bun test packages/md-wysiwyg/tests/*.test.ts

test-ts:
	bun test web/ts/*.test.ts

test-e2e:
	bun test web/ts/e2e/

ts: lint-ts
	bun run oxfmt web/ts/
	bunx tsgo --noEmit --pretty false
	bun build web/ts/main.ts --outfile web/static/app.js --minify

NOTES_DIR ?= '/Users/josh/Library/Mobile Documents/iCloud~md~obsidian/Documents/Notes'

test-rs:
	cargo test -- --test-threads=4

bench:
	cargo bench --bench index

bench-quick:
	cargo run --bin bench -- $(NOTES_DIR)

release-linux-amd64:
	bun build web/ts/main.ts --outfile web/static/app.js --minify
	cargo zigbuild --release --features embed --target x86_64-unknown-linux-gnu
	TARGET=x86_64-unknown-linux-gnu ARCH=amd64 bash scripts/make-deb.sh

setup-cross:
	brew install zig dpkg
	cargo install cargo-zigbuild
	rustup target add x86_64-unknown-linux-gnu

setup:
	prek install --prepare-hooks -f

pc:
	prek run --all-files

clean:
	rm -rf $(NOTES_DIR)/.tansu/index
