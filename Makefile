NAME       := tansu
TARGET     := $(shell rustc -vV | awk '/^host:/ {print $$2}')

dev:
	pnpm run bundle-dev
	cargo run --bin tansu -- --port 3000

build: ts build-rs

release: release-rs release-ts

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

ts: ts-lint ts-check
	pnpm run bundle-dev

ts-lint:
	oxfmt --config oxfmt.config.mjs web/ts/ packages/
	oxlint --quiet --config oxlint.config.mjs web/ts/ packages/

ts-check:
	tsgo --noEmit --pretty false
	pnpm run bundle-dev

release-ts: ts-lint ts-check
	pnpm run bundle

test: test-pkg test-ts test-rs

test-pkg:
	cd packages/md-wysiwyg && vitest run

test-ts:
	vitest run

test-e2e:
	vitest run --config vitest.e2e.config.ts

test-rs:
	cargo test -q

bench:
	cargo bench --bench index

bench-quick:
	cargo run --bin bench

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

