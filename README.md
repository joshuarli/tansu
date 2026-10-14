# Tansu2

Tansu2 is a local Markdown note app. Notes stay as ordinary `.md` files in
configured vaults. The catalog, revision history, search index, and settings
live in the app-managed data directory described in
[Configuration](docs/configuration.md).

## Availability

This repository contains no end-user installer or standalone bundle. The server
expects a `web/` directory in its working directory. With a compatible build,
configure a vault, run `tansu2 --port 3000`, and open
<http://127.0.0.1:3000>.

See [Configuration](docs/configuration.md) for vault paths and storage locations.
Read [Migration](docs/migration.md) before opening an existing vault.

## Help and license

The configuration and migration guides cover vault setup and first-run
behavior. This checkout does not specify a software license.
