# Tansu2

Tansu2 stores notes as ordinary Markdown files in configured vaults. It keeps
the catalog, revision history, search index, and settings in app-managed data.
See [Configuration](docs/configuration.md) for storage paths.

## Get Tansu2

There is no installer. When a GitHub release is published, it includes a
standalone `tansu2` binary for macOS arm64, Linux x86_64 musl, and Linux arm64
musl. The binary includes the web app and does not need a separate `web/`
directory.

## Run Tansu2

Configure at least one vault, then run `tansu2`. It listens on
`http://127.0.0.1:3000` by default. Use `tansu2 --port PORT` to choose another
port. The server listens on loopback; use [Deployment](docs/deployment.md) for
remote access.

Read [Migration](docs/migration.md) before opening an existing vault.

## Help and license

See [Configuration](docs/configuration.md) for vault setup. This checkout does
not specify a software license.
