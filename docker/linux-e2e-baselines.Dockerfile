ARG NODE_VERSION
FROM node:${NODE_VERSION}-bookworm AS node
FROM mcr.microsoft.com/playwright:v1.64.0-noble

COPY --from=node /usr/local/bin/node /usr/local/bin/node

ARG PNPM_VERSION

RUN apt-get update \
  && apt-get install --yes --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -fsSL \
    "https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/pnpm-linux-x64.tar.gz" \
    -o /tmp/pnpm.tar.gz \
  && echo "55b5ed0092bd11176c1669598e231ae52e7cedac59de6efd0d415730f37d0598  /tmp/pnpm.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/pnpm.tar.gz -C /usr/local/bin pnpm \
  && chmod 0755 /usr/local/bin/pnpm \
  && rm /tmp/pnpm.tar.gz

WORKDIR /work
