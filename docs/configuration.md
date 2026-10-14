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
