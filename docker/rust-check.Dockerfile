FROM alpine:edge

ARG TARGET=x86_64-unknown-linux-musl

RUN apk add --no-cache \
  ca-certificates \
  clang22 \
  curl \
  gcc \
  git \
  lld22 \
  llvm22 \
  musl-dev \
  openssl \
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

COPY rust-toolchain.toml /tmp/toolchain/rust-toolchain.toml
RUN cd /tmp/toolchain && rustup show active-toolchain && rustup target add "${TARGET}"

COPY scripts/build-sqlite-static.sh /tmp/build-sqlite-static.sh
RUN CC=/usr/local/bin/tansu-clang sh /tmp/build-sqlite-static.sh /opt/tansu-sqlite

WORKDIR /work
