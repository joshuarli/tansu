FROM alpine:edge AS build

ARG TARGET=x86_64-unknown-linux-musl
ARG SQLITE_VERSION=3.54.0
ARG SQLITE_AUTOCONF=3540000
ARG SQLITE_RELEASE_YEAR=2026
ARG SQLITE_SHA3_256=f5e3e724e9c9b3b5d512c76b02082091a59eeea9becd169a9fbf4d376403acce
ARG CARGO_PROFILE=release

RUN apk add --no-cache \
  ca-certificates \
  clang22 \
  curl \
  file \
  lld22 \
  llvm22 \
  musl-dev \
  openssl \
  pax-utils \
  tar

RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none

ENV PATH="/root/.cargo/bin:/usr/lib/llvm22/bin:${PATH}" \
  CC=clang \
  AR=llvm-ar \
  SQLITE3_STATIC=1 \
  SQLITE3_LIB_DIR=/opt/tansu-sqlite/lib \
  SQLITE3_INCLUDE_DIR=/opt/tansu-sqlite/include \
  LIBSQLITE3_SYS_USE_PKG_CONFIG=0 \
  RUSTFLAGS="-C target-feature=+crt-static -C linker=clang -C link-arg=-fuse-ld=lld -C link-arg=-static"

WORKDIR /work

COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
COPY src ./src
COPY scripts ./scripts

RUN rustup target add "${TARGET}"
RUN SQLITE_VERSION="${SQLITE_VERSION}" \
  SQLITE_AUTOCONF="${SQLITE_AUTOCONF}" \
  SQLITE_RELEASE_YEAR="${SQLITE_RELEASE_YEAR}" \
  SQLITE_SHA3_256="${SQLITE_SHA3_256}" \
  scripts/build-sqlite-static.sh /opt/tansu-sqlite
RUN if [ "${CARGO_PROFILE}" = "release" ]; then \
    cargo build --locked --release --target "${TARGET}" --bin tansu2; \
  else \
    cargo build --locked --target "${TARGET}" --bin tansu2; \
  fi
RUN if [ "${CARGO_PROFILE}" = "release" ]; then bin="target/${TARGET}/release/tansu2"; else bin="target/${TARGET}/debug/tansu2"; fi; \
  ! llvm-readelf -d "$bin" | grep NEEDED; \
  if [ "${CARGO_PROFILE}" = "release" ]; then llvm-strip "$bin"; fi; \
  mkdir -p /out && cp "$bin" /out/tansu2

FROM scratch AS artifact
COPY --from=build /out/tansu2 /tansu2
