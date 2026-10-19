FROM alpine:edge AS build

ARG TARGET=x86_64-unknown-linux-musl
ARG CARGO_PROFILE=release

RUN apk add --no-cache \
  ca-certificates \
  clang22 \
  curl \
  file \
  gcc \
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
  LIBSQLITE3_SYS_USE_PKG_CONFIG=0

RUN printf '#!/bin/sh\nexec clang --target=%s -fuse-ld=lld -static "$@"\n' "${TARGET}" > /usr/local/bin/tansu-clang \
  && chmod 0755 /usr/local/bin/tansu-clang \
  && mkdir -p /root/.cargo \
  && printf '[target."%s"]\nlinker = "/usr/local/bin/tansu-clang"\nrustflags = ["-C", "target-feature=+crt-static"]\n' "${TARGET}" > /root/.cargo/config.toml

WORKDIR /work

COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
COPY build.rs ./build.rs
COPY src ./src
COPY crates ./crates
COPY scripts ./scripts
COPY web/dist ./web/dist

RUN rustup target add "${TARGET}"
RUN CC=/usr/local/bin/tansu-clang scripts/build-sqlite-static.sh /opt/tansu-sqlite
RUN if [ "${CARGO_PROFILE}" = "release" ]; then \
    cargo build --locked --release --target "${TARGET}" --bin tansu; \
  else \
    cargo build --locked --target "${TARGET}" --bin tansu; \
  fi
RUN set -eu; \
  if [ "${CARGO_PROFILE}" = "release" ]; then bin="target/${TARGET}/release/tansu"; else bin="target/${TARGET}/debug/tansu"; fi; \
  dynamic_section="$(llvm-readelf -d "$bin")" || exit 1; \
  printf '%s\n' "$dynamic_section"; \
  if printf '%s\n' "$dynamic_section" | grep NEEDED; then exit 1; fi; \
  if [ "${CARGO_PROFILE}" = "release" ]; then llvm-strip "$bin"; fi; \
  mkdir -p /out && cp "$bin" /out/tansu

FROM scratch AS artifact
COPY --from=build /out/tansu /tansu
