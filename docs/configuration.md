# Configuration

Tansu2 reads `tansu/config.toml` from `XDG_CONFIG_HOME`. If that variable is
unset, it reads `~/.config/tansu/config.toml`. If `XDG_CONFIG_HOME` is set but
the file is missing, startup fails instead of checking the home-directory path.

The file must contain at least one vault. Each vault needs a unique name and a
path. `excluded_folders` is optional and lists folder names to skip at any depth.

```toml
[[vaults]]
name = "Personal"
path = "~/notes"
excluded_folders = ["archive", "tmp"]

[[vaults]]
name = "Work"
path = "~/work-notes"
```

Tansu2 expands `~` and `~/` at the start of a vault path. Nested vault paths
and duplicate app-state directories are rejected.

Tansu2 stores app state under `tansu/` in `XDG_DATA_HOME`. If `XDG_DATA_HOME`
is unset, it uses `~/.local/share/tansu/`. The `identity/` directory contains
the server ID and vault-root mapping. Each vault's catalog, revision snapshots,
and derived search index live under `vaults/<vaultId>/`. Vault IDs follow the
canonical vault root, so renaming a vault in the config does not move its state.
Choose a data home outside your vaults to keep app state separate from note
files. Back up the data home with the vaults. See [Deployment](deployment.md).

## Authenticated mode

Without an `[auth]` section, Tansu2 uses loopback development mode. To expose a
server through HTTPS, add the authenticated settings below:

```toml
[auth]
mode = "authenticated"
external_origin = "https://notes.example.com"
rp_id = "example.com"
rp_name = "Tansu"
state_directory = "auth"
```

All five fields are required. The origin must use HTTPS. The RP ID must match
the origin host or be a registrable domain suffix of it. A parent RP ID equal
to a public suffix such as `com` or `co.uk` is rejected. Tansu2 stores
passkeys under `tansu/identity/<state_directory>` in `XDG_DATA_HOME`; the value
must be one directory name. The auth directory is private to the server account.
`external_origin` must be the exact HTTPS URL that browsers use. For Tailscale
Serve, use the machine's HTTPS tailnet DNS name and set `rp_id` to that hostname
or a parent domain allowed by WebAuthn.

For passkey enrollment, backup, restore, and remote access, see
[Deployment](deployment.md).
