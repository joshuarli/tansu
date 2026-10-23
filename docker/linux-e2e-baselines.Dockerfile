FROM node:26.12.0-bookworm AS node
FROM mcr.microsoft.com/playwright:v1.64.0-noble

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm

RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm

ENV PATH="/usr/local/bin:${PATH}"
WORKDIR /work
