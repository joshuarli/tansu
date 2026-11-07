FROM alpine:edge@sha256:020dfcbaaf4cc1078bf2d9c7ba31a8466e334061dcd2f248001d68f79e52c000 AS build

ARG TARGET=x86_64-unknown-linux-musl
ARG TARGETARCH
ARG CARGO_PROFILE=release
ARG RUSTUP_VERSION=1.29.1
ARG RUSTUP_X86_64_SHA256=331228566cc931f32cd684f9bebc5956a5e5d7394c8d5de595f196a658ab98e6
ARG RUSTUP_AARCH64_SHA256=1ddf36182ac5d1782dbeefcb9bea7f5f9412d88f4a0d5047b1564a223624e8c6
ARG LLVM_RELEASE=llvm-musl-23.1.5-2f0b039
ARG LLVM_VERSION=23.1.5
ARG LLVM_X86_64_SHA256=baba8cf90dd957cf64fdca219f659ec6817b699037a15dfa97bb847a01a64219
ARG LLVM_AARCH64_SHA256=48d1801c1ccc0197182231b7b465879cf7366336f282287bdd30aa7573725dda

RUN apk add --no-cache \
  ca-certificates=20261020-r0 \
  curl=8.23.0-r0 \
  file=5.48-r0 \
  libgcc=15.2.0-r9 \
  musl-dev=1.2.6-r6 \
  openssl=3.5.9-r0 \
  pax-utils=1.3.11-r0 \
  tar=1.35-r5 \
  xz=5.8.4-r0

RUN case "$TARGETARCH" in \
        amd64) arch=x86_64; sum="$LLVM_X86_64_SHA256" ;; \
        arm64) arch=aarch64; sum="$LLVM_AARCH64_SHA256" ;; \
        *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && name="clang+llvm-${LLVM_VERSION}-${arch}-linux-musl" \
    && curl -fsSL -o /tmp/llvm.tar.xz "https://github.com/laputa-systems/llvm-prebuilt-musl/releases/download/${LLVM_RELEASE}/${name}.tar.xz" \
    && echo "$sum  /tmp/llvm.tar.xz" | sha256sum -c - \
    && tar -xf /tmp/llvm.tar.xz -C /opt \
    && ln -s "/opt/${name}" /opt/llvm \
    && rm /tmp/llvm.tar.xz \
    && ln -s libgcc_s.so.1 /usr/lib/libgcc_s.so

RUN case "$TARGETARCH" in \
        amd64) arch=x86_64; sum="$RUSTUP_X86_64_SHA256" ;; \
        arm64) arch=aarch64; sum="$RUSTUP_AARCH64_SHA256" ;; \
        *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSL -o /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${arch}-unknown-linux-musl/rustup-init" \
    && echo "$sum  /tmp/rustup-init" | sha256sum -c - \
    && chmod +x /tmp/rustup-init \
    && /tmp/rustup-init -y --default-toolchain none \
    && rm /tmp/rustup-init

ENV PATH="/root/.cargo/bin:/opt/llvm/bin:${PATH}" \
  CC=clang \
  AR=llvm-ar \
  SQLITE3_STATIC=1 \
  SQLITE3_LIB_DIR=/opt/tansu-sqlite/lib \
  SQLITE3_INCLUDE_DIR=/opt/tansu-sqlite/include \
  LIBSQLITE3_SYS_USE_PKG_CONFIG=0

COPY .cargo/config.toml /root/.cargo/config.toml
RUN printf '#!/bin/sh\nexec clang --target=%s -fuse-ld=lld -static "$@"\n' "${TARGET}" > /usr/local/bin/tansu-clang \
  && chmod 0755 /usr/local/bin/tansu-clang \
  && mkdir -p /root/.cargo \
  && printf '[target."%s"]\nlinker = "/usr/local/bin/tansu-clang"\nrustflags = ["-C", "target-feature=+crt-static"]\n' "${TARGET}" >> /root/.cargo/config.toml

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
