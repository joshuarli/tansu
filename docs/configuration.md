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

Tansu2 stores each vault's catalog, history, search index, session, and settings
under `tansu/<vault-name>` in `XDG_DATA_HOME`. If `XDG_DATA_HOME` is unset, it
uses `~/.local/share/tansu/<vault-name>`. Choose a data home outside your vaults
to keep app state separate from note files.

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

All five fields are required. The origin must use HTTPS, and the RP ID must
match the origin host or be one of its parent domains. Tansu2 stores passkeys
under `tansu/identity/<state_directory>` in `XDG_DATA_HOME`; the value must be
one directory name. The auth directory is private to the server account.

Create the first registration capability while the server is stopped:

```sh
tansu2 auth enroll
```

The command prints a single-use capability that expires after ten minutes. Use
it to complete the first passkey registration. Later passkeys are added from a
recently verified owner session.

Back up and restore auth data with the server stopped:

```sh
tansu2 auth backup /path/to/auth-backup.db
tansu2 auth restore /path/to/auth-backup.db
```

Backup refuses to replace an existing path and publishes a complete SQLite
backup atomically. Restore validates the backup, preserves credentials, and
clears sessions, enrollment capabilities, and pending ceremonies. These
commands manage passkey state only; they do not back up vault notes or app
history.

When an older auth database is first opened after the token hash format
upgrade, Tansu2 clears sessions, enrollment capabilities, and unfinished
ceremonies. Registered passkeys remain available.
