NAME := tansu
DEV_DIR := $(CURDIR)/.dev
DEV_CONFIG_HOME := $(DEV_DIR)/config
DEV_DATA_HOME := $(DEV_DIR)/data
DEPLOY_HOST ?= ubuntu@oracle
SQLITE_STATIC_DIR ?= $(CURDIR)/.work/sqlite-static
AUTH_DRILL_BIN ?= $(CURDIR)/.work/dist/x86_64-unknown-linux-musl/tansu

setup:
	pnpm install --frozen-lockfile

dev: setup
	TANSU_WEB_HMR=1 pnpm run build:dev
	$(MAKE) types-generated
	node scripts/dev-fixture.mjs "$(DEV_DIR)"
	@node scripts/dev-hmr.mjs & \
	watcher=$$!; \
	trap 'kill -TERM "$$watcher" 2>/dev/null; wait "$$watcher" 2>/dev/null' EXIT INT TERM; \
	TANSU_WEB_HMR=1 TANSU_LOGS=pretty XDG_CONFIG_HOME="$(DEV_CONFIG_HOME)" XDG_DATA_HOME="$(DEV_DATA_HOME)" cargo run --bin $(NAME) -- --port 3000

dev-config: setup
	pnpm run build:dev
	node scripts/dev-fixture.mjs "$(DEV_DIR)"

check: setup
	pnpm run check

lint: lint-ts lint-rs

lint-ts: types-check
	pnpm run lint

lint-rs:
	cargo clippy --workspace --all-targets --message-format=short -- \
		-D warnings \
		-A clippy::too_many_arguments \
		-A clippy::redundant_closure \
		-A clippy::collapsible_if \
		-A clippy::question_mark \
		-A clippy::type_complexity \
		-A clippy::needless_borrow

types: web-build
	cargo run --quiet -p gen-api-types

types-check: web-build
	cargo run --quiet -p gen-api-types -- --check

types-generated:
	cargo run --quiet -p gen-api-types

ts: types
	pnpm run build:dev
	pnpm run typecheck

test: types-check test-ts test-rs

test-ts: setup
	pnpm run test

web-build: setup
	pnpm run build

test-e2e-chromium: setup
	pnpm run test:e2e:chromium

test-e2e-webkit: setup
	pnpm run test:e2e:webkit

update-e2e-baselines-linux: setup build-linux-musl-x86_64
	mkdir -p "$(CURDIR)/.work/tmp/linux-e2e-node_modules"
	docker build --platform linux/amd64 --build-arg NODE_VERSION="$$(cat .node-version)" --build-arg PNPM_VERSION="$$(jaq --from json -r '.packageManager | split("@")[1]' package.json)" -f docker/linux-e2e-baselines.Dockerfile --tag tansu-linux-e2e-baselines .
	docker run --rm --platform linux/amd64 \
		--volume "$(CURDIR):/work" \
		--volume "$(CURDIR)/.work/tmp/linux-e2e-node_modules:/work/node_modules" \
		--workdir /work \
		--env TANSU_E2E_SERVER_BINARY=/work/.work/dist/x86_64-unknown-linux-musl/tansu \
		--env TMPDIR=/work/.work/tmp \
		tansu-linux-e2e-baselines \
		sh -c 'set -eu; pnpm install --frozen-lockfile; for browser in chromium webkit; do TANSU_UPDATE_BASELINES=1 TANSU_E2E_BROWSER=$$browser pnpm run test:browser -- -t baselines; TANSU_E2E_BROWSER=$$browser pnpm run test:browser -- -t baselines; done'

loupe: setup
	mkdir -p "$(CURDIR)/.work/tmp"
	TMPDIR="$(CURDIR)/.work/tmp" pnpm run loupe:dist
	@if [ "$$(uname -s)" = "Darwin" ] && [ -d "/Applications/Helium.app" ]; then open -a "/Applications/Helium.app" "chrome://extensions"; fi
	@echo "Load unpacked in your Chromium browser:"
	@echo "  $(CURDIR)/dist/extension-loupe"

test-loupe-browser: setup
	mkdir -p "$(CURDIR)/.work/tmp"
	TMPDIR="$(CURDIR)/.work/tmp" pnpm run loupe:browser

test-e2e-loupe: setup
	mkdir -p "$(CURDIR)/.work/tmp"
	TMPDIR="$(CURDIR)/.work/tmp" pnpm run test:e2e:loupe

test-rs: web-build
	cargo test -q --workspace

test-sqlite-static: web-build
	mkdir -p "$(CURDIR)/.work/tmp"
	TMPDIR="$(CURDIR)/.work/tmp" scripts/build-sqlite-static.sh "$(SQLITE_STATIC_DIR)"
	TMPDIR="$(CURDIR)/.work/tmp" CARGO_TARGET_DIR="$(CURDIR)/.work/target-sqlite-static" SQLITE3_STATIC=1 SQLITE3_LIB_DIR="$(SQLITE_STATIC_DIR)/lib" SQLITE3_INCLUDE_DIR="$(SQLITE_STATIC_DIR)/include" LIBSQLITE3_SYS_USE_PKG_CONFIG=0 cargo test --locked --lib auth::tests

auth-recovery-drill:
	mkdir -p "$(CURDIR)/.work/tmp"
	TMPDIR="$(CURDIR)/.work/tmp" scripts/auth-recovery-drill.sh "$(AUTH_DRILL_BIN)"

ACCEPTANCE_BROWSER ?= chromium
ACCEPTANCE_DEFAULT_SERVER_BINARY := $(if $(CARGO_TARGET_DIR),$(CARGO_TARGET_DIR),target)/debug/$(NAME)

test-acceptance: setup
	@rev="$$(git rev-parse HEAD)$$(git diff --quiet HEAD -- || echo -dirty)"; \
	echo "acceptance suite revision: $$rev"; \
	echo "acceptance server binary: $(abspath $(if $(strip $(ACCEPTANCE_SERVER_BINARY)),$(ACCEPTANCE_SERVER_BINARY),$(ACCEPTANCE_DEFAULT_SERVER_BINARY)))"; \
	TANSU_E2E_SERVER_BINARY="$(ACCEPTANCE_SERVER_BINARY)" TANSU_E2E_BROWSER=$(ACCEPTANCE_BROWSER) pnpm run test:acceptance && \
	echo "acceptance suite passed at revision: $$rev"

build-linux-musl-docker: setup
	mkdir -p "$(CURDIR)/.work/tmp" "$(CURDIR)/.work/dist/$${TARGET:-x86_64-unknown-linux-musl}"
	TMPDIR="$(CURDIR)/.work/tmp" pnpm run build
	TMPDIR="$(CURDIR)/.work/tmp" docker build --platform $${PLATFORM:-linux/amd64} -f docker/linux-musl.Dockerfile --build-arg TARGET=$${TARGET:-x86_64-unknown-linux-musl} --build-arg CARGO_PROFILE=$${CARGO_PROFILE:-release} --output type=local,dest="$(CURDIR)/.work/dist/$${TARGET:-x86_64-unknown-linux-musl}" .

build-linux-musl-x86_64:
	$(MAKE) build-linux-musl-docker TARGET=x86_64-unknown-linux-musl PLATFORM=linux/amd64

build-linux-musl-aarch64:
	$(MAKE) build-linux-musl-docker TARGET=aarch64-unknown-linux-musl PLATFORM=linux/amd64

deploy:
	DEPLOY_HOST="$(DEPLOY_HOST)" TMPDIR="$(CURDIR)/.work/tmp" deploy/deploy-oracle.sh

PERF_GATE_BEFORE := scripts/perf-gate.sh before
PERF_GATE_AFTER := scripts/perf-gate.sh after

bench: setup
	mkdir -p "$(CURDIR)/.work/tmp"
	$(PERF_GATE_BEFORE)
	TMPDIR="$(CURDIR)/.work/tmp" node bench/integrated-bench.mjs --browser=chromium --warmups=2 --runs=5
	$(PERF_GATE_AFTER)

bench-full: setup
	mkdir -p "$(CURDIR)/.work/tmp"
	$(PERF_GATE_BEFORE)
	TMPDIR="$(CURDIR)/.work/tmp" node bench/integrated-bench.mjs --browser=chromium,webkit --warmups=5 --runs=20
	$(PERF_GATE_AFTER)

.PHONY: auth-recovery-drill bench bench-full build-linux-musl-aarch64 build-linux-musl-docker build-linux-musl-x86_64 deploy dev dev-config check lint loupe setup test-loupe-browser types types-check types-generated ts test test-e2e-chromium test-e2e-webkit update-e2e-baselines-linux test-e2e-loupe test-rs test-sqlite-static test-acceptance web-build
