# Tansu2

Tansu2 stores notes as ordinary Markdown files in configured vaults. It keeps
the catalog, revision history, search index, and settings in app-managed data.
See [Configuration](docs/configuration.md) for storage paths.

## Get Tansu2

Standalone binaries, when available, are listed on the
[GitHub releases page](https://github.com/joshuarli/tansu2/releases). Put the
`tansu2` binary on your `PATH`.

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

## Help and license

See [Configuration](docs/configuration.md) for vault setup. This checkout does
not specify a software license.
