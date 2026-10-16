NAME := tansu2
DEV_DIR := $(CURDIR)/.dev
DEV_CONFIG_HOME := $(DEV_DIR)/config
DEV_DATA_HOME := $(DEV_DIR)/data
DEPLOY_HOST ?= ubuntu@oracle
SQLITE_STATIC_DIR ?= $(CURDIR)/.work/sqlite-static
AUTH_DRILL_BIN ?= $(CURDIR)/.work/dist/x86_64-unknown-linux-musl/tansu2

dev:
	pnpm install --frozen-lockfile
	deno task build:dev
	$(MAKE) types-generated
	node scripts/dev-fixture.mjs "$(DEV_DIR)"
	TANSU2_LOGS=pretty XDG_CONFIG_HOME="$(DEV_CONFIG_HOME)" XDG_DATA_HOME="$(DEV_DATA_HOME)" cargo run --bin $(NAME) -- --port 3000

dev-config:
	pnpm install --frozen-lockfile
	deno task build:dev
	node scripts/dev-fixture.mjs "$(DEV_DIR)"

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

coverage-ts: types-check
	deno task coverage

coverage: coverage-ts

coverage-html: types-check
	deno task coverage:html

types:
	deno task build
	cargo run --quiet --bin gen-api-types

types-check:
	deno task build
	cargo run --quiet --bin gen-api-types -- --check

types-generated:
	cargo run --quiet --bin gen-api-types

ts: types
	deno task build:dev
	deno task typecheck

test: types-check test-ts test-rs

test-ts:
	deno task test

test-e2e-chromium:
	TANSU2_E2E_BROWSER=chromium deno task test:browser

test-e2e-webkit:
	TANSU2_E2E_BROWSER=webkit deno task test:browser

test-rs:
	cargo test -q --workspace

test-sqlite-static:
	mkdir -p "$(CURDIR)/.work/tmp"
	TMPDIR="$(CURDIR)/.work/tmp" scripts/build-sqlite-static.sh "$(SQLITE_STATIC_DIR)"
	TMPDIR="$(CURDIR)/.work/tmp" deno task build
	TMPDIR="$(CURDIR)/.work/tmp" CARGO_TARGET_DIR="$(CURDIR)/.work/target-sqlite-static" SQLITE3_STATIC=1 SQLITE3_LIB_DIR="$(SQLITE_STATIC_DIR)/lib" SQLITE3_INCLUDE_DIR="$(SQLITE_STATIC_DIR)/include" LIBSQLITE3_SYS_USE_PKG_CONFIG=0 cargo test --locked --lib auth::tests

auth-recovery-drill:
	mkdir -p "$(CURDIR)/.work/tmp"
	TMPDIR="$(CURDIR)/.work/tmp" scripts/auth-recovery-drill.sh "$(AUTH_DRILL_BIN)"

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

deploy:
	DEPLOY_HOST="$(DEPLOY_HOST)" TMPDIR="$(CURDIR)/.work/tmp" deploy/deploy-oracle.sh

test-package:
	mkdir -p "$(CURDIR)/.work/tmp"
	TMPDIR="$(CURDIR)/.work/tmp" deno task build
	TMPDIR="$(CURDIR)/.work/tmp" cargo build --locked --release --bin $(NAME)
	TMPDIR="$(CURDIR)/.work/tmp" python3 scripts/test-package.py target/release/$(NAME)

PERF_GATE_BEFORE := scripts/perf-gate.sh before
PERF_GATE_AFTER := scripts/perf-gate.sh after

bench:
	mkdir -p "$(CURDIR)/.work/tmp"
	$(PERF_GATE_BEFORE)
	TMPDIR="$(CURDIR)/.work/tmp" node bench/integrated-bench.mjs --browser=chromium --warmups=2 --runs=5
	TMPDIR="$(CURDIR)/.work/tmp" node bench/note-cache-bench.mjs --runs=9 --delay=200
	TMPDIR="$(CURDIR)/.work/tmp" MD_WYSIWYG_BENCH=1 deno task test web/ts/editor/tests/large-note-bench.test.ts
	$(PERF_GATE_AFTER)

bench-full:
	mkdir -p "$(CURDIR)/.work/tmp"
	$(PERF_GATE_BEFORE)
	TMPDIR="$(CURDIR)/.work/tmp" node bench/integrated-bench.mjs --browser=chromium,webkit --warmups=5 --runs=20
	TMPDIR="$(CURDIR)/.work/tmp" node bench/note-cache-bench.mjs --runs=20 --delay=200
	TMPDIR="$(CURDIR)/.work/tmp" MD_WYSIWYG_BENCH=1 deno task test web/ts/editor/tests/large-note-bench.test.ts
	$(PERF_GATE_AFTER)

bench-long-session:
	mkdir -p "$(CURDIR)/.work/tmp"
	$(PERF_GATE_BEFORE)
	TMPDIR="$(CURDIR)/.work/tmp" node bench/long-session.mjs
	$(PERF_GATE_AFTER)

.PHONY: auth-recovery-drill bench bench-full bench-long-session build-linux-musl-aarch64 build-linux-musl-both build-linux-musl-docker build-linux-musl-x86_64 coverage coverage-html deploy dev dev-config check lint test-package types types-check types-generated ts test test-e2e-chromium test-e2e-webkit test-rs test-sqlite-static
