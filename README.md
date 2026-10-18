# Tansu2

Tansu2 stores notes as ordinary Markdown files in configured vaults. It keeps
the catalog, revision history, search index, and settings in app-managed data.
See [Configuration](docs/configuration.md) for storage paths.

## Get Tansu2

Download the standalone binary for macOS arm64, Linux x86_64 musl, or Linux
arm64 musl from the [latest GitHub release](https://github.com/joshuarli/tansu2/releases/latest).
Each archive includes the web app. The `.sha256` files can verify downloads.
Rename the extracted `tansu2-<target>` binary to `tansu2` and put it on your
`PATH`.

## Run Tansu2

Create a vault directory, run Tansu2, and open the first-run setup page:

```sh
mkdir -p "$HOME/Documents/Notes"
tansu2
```

Add `$HOME/Documents/Notes` in the setup page. The server listens on loopback;
use
[Deployment](docs/deployment.md) for remote access.

Read [Migration](docs/migration.md) before opening an existing vault.

## Loupe browser extension

See [Loupe](docs/loupe.md) for the browser extension that reads pages and sends
notes and images to Tansu.

## Help and license

See [Configuration](docs/configuration.md) for vault setup. This checkout does
not specify a software license.
