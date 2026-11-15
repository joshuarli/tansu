ARG NODE_VERSION
FROM node:${NODE_VERSION}-bookworm@sha256:b7087bc4d973034b30854b378ba107f9fab622b47514cb7e2592e41b8bab8d49 AS node
FROM mcr.microsoft.com/playwright:v1.65.0-noble@sha256:9beb546099e11f52d62e505537914870e01a67e0e6b00ae41da4775324e73dbe

COPY --from=node /usr/local/bin/node /usr/local/bin/node
ARG NODE_VERSION
RUN test "$(node --version)" = "v${NODE_VERSION}"

ARG PNPM_VERSION

RUN apt-get update \
  && apt-get install --yes --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -fsSL \
    "https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/pnpm-linux-x64.tar.gz" \
    -o /tmp/pnpm.tar.gz \
  && echo "84c4773bcf4a217f4083cd7b2a91e4cee6103cf42426c1282ef37d308f55a410  /tmp/pnpm.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/pnpm.tar.gz -C /usr/local/bin pnpm \
  && chmod 0755 /usr/local/bin/pnpm \
  && rm /tmp/pnpm.tar.gz

WORKDIR /work
