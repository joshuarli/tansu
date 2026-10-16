# Configuration

Application settings are stored in SQLite at
`$XDG_CONFIG_HOME/tansu/settings.sqlite3`. When `XDG_CONFIG_HOME` is unset,
Tansu2 uses `~/.config/tansu/settings.sqlite3`. Start Tansu2 without settings
to open the first-run setup page at `http://127.0.0.1:3000`.

The setup page stores the app-wide vault list and optional authentication
policy. Saving settings asks for a restart before the configured vaults are
opened. The first-run server binds to loopback and exposes only setup.

For scripts and development fixtures, initialize settings from the command
line:

```sh
tansu2 config init --vault Notes "$HOME/Documents/Notes"
```

Repeat `--vault NAME PATH` for more vaults. Paths must be absolute; `~` and
`~/` are expanded. Nested vault roots and duplicate app-state directories are
rejected. Existing TOML files are not imported.

## Settings layers

App-wide settings contain registered vault names and paths, plus optional
authentication settings. Per-vault settings remain in each vault's SQLite
catalog and include excluded folders, search weights, autosave delay, undo
history size, and image quality. The settings dialog bounds autosave delay,
undo history size, and image quality with the limits in
`web/ts/app/settings-policy.ts`, which a unit test keeps equal to the ranges in
`src/api_types.rs`. App-wide settings live under the config home;
vault catalogs and other durable state live under `tansu/` in `XDG_DATA_HOME`
or `~/.local/share/tansu/` when unset.

### Vault settings limits

The server validates vault settings once, before saving, for both the HTTP API
and Rust callers. A value outside these limits is rejected and nothing is
persisted:

| Field | Valid values |
| --- | --- |
| `autosaveDelayMs` | integer, 150 to 3,600,000 (one hour) |
| `undoStackMax` | integer, 20 to 10,000 |
| `imageWebpQuality` | finite, 0.1 to 1 |
| `searchTitleWeight`, `searchHeadingWeight`, `searchTagWeight`, `searchContentWeight`, `recencyBoost` | finite, 0 to 1,000 |
| `excludedFolders` | each entry is a single folder name: nonempty, not `.` or `..`, no `/`, `\`, or NUL |

The settings form enforces the same limits: it clamps numbers, rejects an
invalid excluded folder entry with an inline error, and shows stored
out-of-range values clamped. Settings saved by an earlier version are not
revalidated on load, so an out-of-range stored value is served unchanged and
the client accepts it; the next save from the form brings it into range.

The app data directory contains stable server and vault identities, catalogs,
revision snapshots, conflict drafts, and derived search indexes. Vault IDs
follow the canonical vault root, so renaming a vault does not move its state.
Keep app data and vaults in backups from the same point in time. See
[Deployment](deployment.md).

## Authenticated mode

Authentication is optional for loopback use. To enable passkeys, set the
external HTTPS origin, relying party ID, and relying party name in the setup
page, or initialize from the command line:

```sh
tansu2 config init \
  --vault Notes "$HOME/Documents/Notes" \
  --auth https://notes.example.com example.com Tansu
```

The origin must use HTTPS. The RP ID must match the origin host or be a
registrable domain suffix of it. Public suffixes such as `com` and `co.uk` are
rejected even when they equal the origin host, and so are IP addresses.
`localhost` and single-label local names such as `devbox` are accepted when
they equal the origin host. Passkeys live under `tansu/identity/auth` in the data home. The
`externalOrigin` must exactly match the HTTPS URL browsers use. For Tailscale
Serve, use the machine's HTTPS tailnet DNS name and set `rpId` to that hostname
or an allowed parent domain. See [Deployment](deployment.md).
