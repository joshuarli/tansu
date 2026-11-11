ARG NODE_VERSION
FROM node:${NODE_VERSION}-bookworm AS node
FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f

COPY --from=node /usr/local/bin/node /usr/local/bin/node

ARG PNPM_VERSION

RUN apt-get update \
  && apt-get install --yes --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -fsSL \
    "https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/pnpm-linux-x64.tar.gz" \
    -o /tmp/pnpm.tar.gz \
  && echo "3726060e236c0db3e7124c0a5af123c840ba0cb76682149b63ea0baf290017c2  /tmp/pnpm.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/pnpm.tar.gz -C /usr/local/bin pnpm \
  && chmod 0755 /usr/local/bin/pnpm \
  && rm /tmp/pnpm.tar.gz

WORKDIR /work
