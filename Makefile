NAME := tansu2
DEV_DIR := $(CURDIR)/.dev
DEV_CONFIG_HOME := $(DEV_DIR)/config
DEV_DATA_HOME := $(DEV_DIR)/data

dev: types dev-config
	pnpm run bundle-dev
	TANSU2_LOGS=pretty XDG_CONFIG_HOME="$(DEV_CONFIG_HOME)" XDG_DATA_HOME="$(DEV_DATA_HOME)" cargo run --bin $(NAME) -- --port 3000

dev-config:
	node scripts/test-fixture.mjs "$(DEV_DIR)"

check: types-check
	pnpm exec tsgo --noEmit --pretty false
	cargo check -q

lint: lint-ts lint-rs

lint-ts: types-check
	pnpm exec oxlint --fix --config oxlint.config.mjs
	pnpm exec knip --reporter compact

lint-rs:
	cargo clippy --fix --allow-dirty --all-targets --message-format=short

coverage-rs:
	cargo llvm-cov --workspace --all-targets --ignore-filename-regex 'src/(main\.rs|bin/gen-api-types\.rs)$$' --fail-under-lines 87 --fail-under-functions 80 --no-clean

coverage-ts: types-check
	pnpm exec vitest run --coverage

coverage: coverage-rs coverage-ts

coverage-html: types-check
	cargo llvm-cov --workspace --all-targets --ignore-filename-regex 'src/(main\.rs|bin/gen-api-types\.rs)$$' --html --no-clean
	pnpm exec vitest run --coverage --coverage.reporter=html

audit:
	pnpm audit --prod --audit-level=high
	# cargo deny check

ci: lint coverage test-e2e-chromium test-e2e-firefox test-e2e-webkit audit

types:
	cargo run --quiet --bin gen-api-types

types-check:
	cargo run --quiet --bin gen-api-types -- --check

ts: types
	pnpm run bundle-dev
	pnpm exec tsgo --noEmit --pretty false

test: types-check test-ts test-rs

test-ts:
	pnpm exec vitest run

test-e2e-chromium:
	TANSU2_E2E_BROWSER=chromium pnpm run test-e2e

test-e2e-firefox:
	TANSU2_E2E_BROWSER=firefox pnpm run test-e2e

test-e2e-webkit:
	TANSU2_E2E_BROWSER=webkit pnpm run test-e2e

test-rs:
	cargo test -q

build-linux-musl-docker:
	docker build --platform $${PLATFORM:-linux/amd64} -f docker/linux-musl.Dockerfile --build-arg TARGET=$${TARGET:-x86_64-unknown-linux-musl} --build-arg CARGO_PROFILE=$${CARGO_PROFILE:-release} --output type=local,dest=dist .

bench:
	node bench/integrated-bench.mjs --browser=chromium --warmups=2 --runs=5
	node bench/note-cache-bench.mjs --runs=9 --delay=200
	MD_WYSIWYG_BENCH=1 pnpm exec vitest run web/ts/editor/tests/large-note-bench.test.ts

bench-full:
	node bench/integrated-bench.mjs --browser=chromium,firefox,webkit --warmups=5 --runs=20
	node bench/note-cache-bench.mjs --runs=20 --delay=200
	MD_WYSIWYG_BENCH=1 pnpm exec vitest run web/ts/editor/tests/large-note-bench.test.ts

.PHONY: audit bench bench-full ci coverage coverage-html coverage-rs coverage-ts dev dev-config check lint types types-check ts test test-ts test-e2e test-rs
