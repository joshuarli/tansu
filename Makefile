NAME       := tansu
TARGET     := $(shell rustc -vV | awk '/^host:/ {print $$2}')

dev: lint-ts
	oxfmt web/ts/
	tsgo --noEmit --pretty false
	pnpm run bundle-dev
	cargo run --bin tansu -- $(NOTES_DIR) --port 3000

build: check build-ts build-rs

build-rs:
	cargo build

release-rs:
	cargo clean -p $(NAME) --release --target $(TARGET)
	RUSTFLAGS="-Zlocation-detail=none -Zunstable-options -Cpanic=immediate-abort" \
	cargo build --release \
	  -Z build-std=std \
	  -Z build-std-features= \
	  --target $(TARGET)

publish-pkg:
	cd packages/md-wysiwyg && pnpm run build && pnpm publish --access public

check:
	tsgo
	tsgo -p packages/md-wysiwyg/tsconfig.json --noEmit
	cargo check

test: test-pkg test-ts test-rs

lint-ts:
	oxlint --quiet web/ts/

test-pkg:
	cd packages/md-wysiwyg && vitest run

test-ts:
	vitest run

test-e2e:
	pnpm run test-e2e

ts: lint-ts
	oxfmt web/ts/
	tsgo --noEmit --pretty false
	pnpm run bundle

NOTES_DIR ?= '/Users/josh/Library/Mobile Documents/iCloud~md~obsidian/Documents/Notes'

test-rs:
	cargo test -q

bench:
	cargo bench --bench index

bench-quick:
	cargo run --bin bench -- $(NOTES_DIR)

release-linux-amd64:
	pnpm run bundle
	cargo zigbuild --release --features embed --target x86_64-unknown-linux-gnu
	TARGET=x86_64-unknown-linux-gnu ARCH=amd64 bash scripts/make-deb.sh

setup-cross:
	brew install zig dpkg
	cargo install cargo-zigbuild
	rustup target add x86_64-unknown-linux-gnu

setup:
	npm install -g $(shell node -p "require('./package.json').packageManager")
	pnpm install
	prek install --prepare-hooks -f

pc:
	prek run --all-files

clean:
	rm -rf $(NOTES_DIR)/.tansu/index
