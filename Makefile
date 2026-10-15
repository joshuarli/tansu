NAME := tansu2
DEV_DIR := $(CURDIR)/.dev
DEV_CONFIG_HOME := $(DEV_DIR)/config
DEV_DATA_HOME := $(DEV_DIR)/data

dev:
	deno task build:dev
	$(MAKE) types dev-config
	TANSU2_LOGS=pretty XDG_CONFIG_HOME="$(DEV_CONFIG_HOME)" XDG_DATA_HOME="$(DEV_DATA_HOME)" cargo run --bin $(NAME) -- --port 3000

dev-config:
	deno run --allow-read --allow-write --allow-env scripts/test-fixture.mjs "$(DEV_DIR)"

check: types-check
	deno task typecheck
	cargo check -q

lint: lint-ts lint-rs

lint-ts: types-check
	deno task lint

lint-rs:
	cargo clippy --workspace --all-targets --message-format=short -- \
		-D warnings \
		-A clippy::too_many_arguments \
		-A clippy::redundant_closure \
		-A clippy::collapsible_if \
		-A clippy::question_mark \
		-A clippy::type_complexity \
		-A clippy::needless_borrow

coverage-rs:
	cargo llvm-cov --workspace --all-targets --ignore-filename-regex 'src/(main\.rs|bin/gen-api-types\.rs)$$' --fail-under-lines 87 --fail-under-functions 80 --no-clean

coverage-ts: types-check
	deno task coverage

coverage: coverage-rs coverage-ts

coverage-html: types-check
	cargo llvm-cov --workspace --all-targets --ignore-filename-regex 'src/(main\.rs|bin/gen-api-types\.rs)$$' --html --no-clean
	deno task coverage:html

audit:
	pnpm audit --prod --audit-level=high
	# cargo deny check

ci: lint coverage test-e2e-chromium test-e2e-firefox test-e2e-webkit audit

types:
	cargo run --quiet --bin gen-api-types

types-check:
	cargo run --quiet --bin gen-api-types -- --check

ts: types
	deno task build:dev
	deno task typecheck

test: types-check test-ts test-rs

test-ts:
	deno task test

test-e2e-chromium:
	TANSU2_E2E_BROWSER=chromium deno task test:browser

test-e2e-firefox:
	TANSU2_E2E_BROWSER=firefox deno task test:browser

test-e2e-webkit:
	TANSU2_E2E_BROWSER=webkit deno task test:browser

test-rs:
	cargo test -q --workspace

build-linux-musl-docker:
	mkdir -p "$(CURDIR)/.work/tmp" "$(CURDIR)/.work/dist/$${TARGET:-x86_64-unknown-linux-musl}"
	TMPDIR="$(CURDIR)/.work/tmp" deno task build
	TMPDIR="$(CURDIR)/.work/tmp" docker build --platform $${PLATFORM:-linux/amd64} -f docker/linux-musl.Dockerfile --build-arg TARGET=$${TARGET:-x86_64-unknown-linux-musl} --build-arg CARGO_PROFILE=$${CARGO_PROFILE:-release} --output type=local,dest="$(CURDIR)/.work/dist/$${TARGET:-x86_64-unknown-linux-musl}" .

build-linux-musl-x86_64:
	$(MAKE) build-linux-musl-docker TARGET=x86_64-unknown-linux-musl PLATFORM=linux/amd64

build-linux-musl-aarch64:
	$(MAKE) build-linux-musl-docker TARGET=aarch64-unknown-linux-musl PLATFORM=linux/amd64

build-linux-musl-both:
	$(MAKE) build-linux-musl-x86_64
	$(MAKE) build-linux-musl-aarch64

test-package:
	mkdir -p "$(CURDIR)/.work/tmp"
	TMPDIR="$(CURDIR)/.work/tmp" deno task build
	TMPDIR="$(CURDIR)/.work/tmp" cargo build --locked --release --bin $(NAME)
	TMPDIR="$(CURDIR)/.work/tmp" python3 scripts/test-package.py target/release/$(NAME)

bench:
	mkdir -p "$(CURDIR)/.work/tmp"
	TMPDIR="$(CURDIR)/.work/tmp" node bench/integrated-bench.mjs --browser=chromium --warmups=2 --runs=5
	TMPDIR="$(CURDIR)/.work/tmp" node bench/note-cache-bench.mjs --runs=9 --delay=200
	TMPDIR="$(CURDIR)/.work/tmp" MD_WYSIWYG_BENCH=1 deno task test web/ts/editor/tests/large-note-bench.test.ts

bench-full:
	mkdir -p "$(CURDIR)/.work/tmp"
	TMPDIR="$(CURDIR)/.work/tmp" node bench/integrated-bench.mjs --browser=chromium,firefox,webkit --warmups=5 --runs=20
	TMPDIR="$(CURDIR)/.work/tmp" node bench/note-cache-bench.mjs --runs=20 --delay=200
	TMPDIR="$(CURDIR)/.work/tmp" MD_WYSIWYG_BENCH=1 deno task test web/ts/editor/tests/large-note-bench.test.ts

bench-long-session:
	mkdir -p "$(CURDIR)/.work/tmp"
	TMPDIR="$(CURDIR)/.work/tmp" node bench/long-session.mjs

.PHONY: audit bench bench-full bench-long-session build-linux-musl-aarch64 build-linux-musl-both build-linux-musl-docker build-linux-musl-x86_64 ci coverage coverage-html coverage-rs coverage-ts dev dev-config check lint test-package types types-check ts test test-ts test-e2e test-rs
