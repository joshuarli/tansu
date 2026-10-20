# Configuration

Application settings live in SQLite at
`$XDG_CONFIG_HOME/tansu/settings.sqlite3`, or
`~/.config/tansu/settings.sqlite3` when `XDG_CONFIG_HOME` is unset. Without
settings, Tansu serves the first-run setup page on loopback.

Setup stores the app-wide vault list and optional authentication policy. Saving
settings requires a restart before those changes take effect. The first-run
server binds to loopback and exposes only setup.

For scripts and development fixtures, initialize settings from the command
line:

```sh
tansu config init --vault Notes "$HOME/Documents/Notes"
```

Repeat `--vault NAME PATH` for more vaults. Paths must be absolute; `~` and
`~/` are expanded. Nested vault roots and duplicate app-state directories are
rejected. Existing TOML files are not imported.

## Settings

App-wide settings contain registered vault names and paths, plus optional
authentication settings. Per-vault settings live in each vault's SQLite
catalog and include excluded folders, search weights, autosave delay, undo
history size, and image quality. Server limits are in `crates/tansu-api-types/src/lib.rs`; the
client policy is in `web/ts/app/settings-policy.ts`, and
`web/ts/app/settings-policy.test.ts` checks that their ranges agree. Invalid
settings are rejected before persistence by both HTTP and Rust callers.

An `excludedFolders` entry is one exact, case-sensitive folder or file name
matched at any depth. A path such as `projects/Archive` is not a valid entry.
Saving a changed list reconciles the vault before returning: excluded notes
leave the catalog and search, and removing an entry brings them back.

Settings loaded from an earlier version are not revalidated on load. An
out-of-range stored value is served unchanged; saving the settings form brings
it into range.

Vault catalogs and other durable state live under `tansu/` in
`XDG_DATA_HOME`, or `~/.local/share/tansu/` when unset. This directory contains
stable server and vault identities, catalogs, revision snapshots, conflict
drafts, and derived search indexes. Keep app data and vaults in backups from the
same point in time. See [Deployment](deployment.md).

## Authenticated mode

Authentication is optional for loopback use. To enable passkeys, set the
external HTTPS origin, relying party ID, and relying party name in setup, or
initialize from the command line:

```sh
tansu config init \
  --vault Notes "$HOME/Documents/Notes" \
  --auth https://notes.example.com example.com Tansu
```

The origin must use HTTPS. The RP ID must match the origin host or be a
registrable domain suffix. Public suffixes and IP addresses are rejected. The
validator uses an embedded Public Suffix List and makes no network lookup.
`localhost` and single-label local names such as `devbox` are accepted when
they match the origin host. Passkeys live under `tansu/identity/auth` in the
data home. `externalOrigin` must exactly match the HTTPS URL used by browsers.
For Tailscale Serve, use the machine's HTTPS tailnet DNS name. See
[Deployment](deployment.md).
