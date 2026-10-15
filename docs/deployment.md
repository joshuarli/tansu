# Deployment

Tansu2 binds to `127.0.0.1` on port `3000` by default. Without an `[auth]`
section, the server uses loopback development mode and passkey routes are
disabled. Keep the default for local use.

## Serve privately over Tailscale

[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) gives
tailnet devices HTTPS access to the loopback server. Configure HTTPS for your
tailnet, then set the browser URL as the authenticated origin:

```toml
[auth]
mode = "authenticated"
external_origin = "https://laptop.example-tailnet.ts.net"
rp_id = "laptop.example-tailnet.ts.net"
rp_name = "Tansu"
state_directory = "auth"
```

Use the exact tailnet HTTPS hostname shown by Tailscale for
`external_origin`. The RP ID must match that hostname or be one of its parent
domains. See [Configuration](configuration.md) for the full path and validation
rules.

Start Tansu2, then publish its local port to your tailnet:

```sh
tansu2
tailscale serve --bg 3000
tailscale serve status
```

Open the HTTPS URL shown by `tailscale serve status`. Tailscale Serve restricts
access to your tailnet and its access controls. Do not run `tailscale funnel`;
Funnel exposes the service to the public internet. Tailscale identity headers
do not replace Tansu2 passkey authentication.

## Deploy to Oracle

Run `make deploy` from the repository root. The command builds a static Linux
binary for Oracle's architecture, installs it as a systemd service, and keeps
the config, vault, and app data under `/var/lib/tansu2/`.

Tailscale Serve exposes the app to your tailnet over HTTPS. The URL
`http://oracle:3000` redirects to `https://oracle.<tailnet>.ts.net`, where the
server uses authenticated mode. The HTTP endpoint only redirects. Tailscale
HTTPS must be enabled for your tailnet. See the
[Tailscale Serve documentation](https://tailscale.com/docs/reference/tailscale-cli/serve).

The first deployment creates an empty `Personal` vault. Enroll the first
passkey before editing notes. Stop the service, issue a one-time capability,
then start the service again:

```sh
ssh ubuntu@oracle 'sudo systemctl stop tansu2'
ssh ubuntu@oracle 'sudo -u tansu2 env HOME=/var/lib/tansu2 XDG_CONFIG_HOME=/var/lib/tansu2/config XDG_DATA_HOME=/var/lib/tansu2/data /opt/tansu2/tansu2 auth enroll'
ssh ubuntu@oracle 'sudo systemctl start tansu2'
```

Enter the printed capability at the authenticated HTTPS URL and complete
passkey registration. The capability expires after ten minutes.

## Enroll and recover passkeys

Stop the server before running local auth commands. The exclusive auth-state
lock rejects these commands while the server is running.

1. Run `tansu2 auth enroll` and keep the printed capability private. It expires
   after ten minutes and can enroll only the first credential.
2. Start Tansu2 and open its configured HTTPS origin in a browser.
3. Complete the first passkey registration with the capability.
4. Add a second passkey from a recently verified owner session. Keep access to
   both authenticators or to their credential manager's recovery process.

Back up the server's auth database while the server is stopped:

```sh
tansu2 auth backup "$HOME/tansu-auth-backup.db"
```

Restore it with `tansu2 auth restore PATH`. Keep `external_origin` and `rp_id`
set to the values used when you created the backup. Tansu2 clears credentials
when either value changes. Restore clears sessions, enrollment capabilities,
and unfinished ceremonies. The backup contains the
server's public credential records, not authenticator private keys. If every
registered authenticator is lost, an auth database backup alone cannot restore
login access.

## Back up and restore Tansu2 state

Stop Tansu2 and other vault writers before copying state. Back up these items
together from one quiescent point:

- Every configured vault, including Markdown files and `z-images/` assets.
- The config file at `$XDG_CONFIG_HOME/tansu/config.toml`, or
  `$HOME/.config/tansu/config.toml` when `XDG_CONFIG_HOME` is unset.
- The full `tansu/` directory in `XDG_DATA_HOME`, or
  `$HOME/.local/share/tansu/` when `XDG_DATA_HOME` is unset.
- The browser profile if you need its IndexedDB workspace and draft records.

Vault files are authored content. The app data directory contains stable server
and vault identities, catalogs, revision snapshots, conflict drafts, settings,
and search indexes. Search indexes are derived and can be rebuilt from the
vault and catalog data. Keep the vaults and app data from the same backup; the
catalog tracks visible file hashes and revisions. Browser IndexedDB is separate
from server state, is not encrypted by Tansu2, and is not included in a server
backup. Browser storage can be cleared or evicted, and a journal checkpoint may
not include the most recent keystrokes.

If you lose a search index, restart Tansu2 so startup can rebuild it. Do not
delete the catalog or revision data to rebuild search. Those files hold durable
identity and recovery state.

## Roll back

Stop the server before restoring a backup. Restore the config, all vaults, and
the full app data directory from the same point in time before starting an older
binary. Tansu2 may update its SQLite schema when it opens app data. The project
does not guarantee that a newer catalog can be opened by an older binary.

The Markdown files remain ordinary files, but restoring only the vault or only
app data can pair different file contents and catalog state. A rollback cannot
recover edits made after the backup unless those edits remain in another copy
or in browser-local drafts.

## Before distribution

Confirm redistribution rights for the vendored WebAuthn source in
[`crates/tansu-webauthn/UPSTREAM.md`](../crates/tansu-webauthn/UPSTREAM.md).
Audit downstream use of the remaining public Rust API before distribution or
further API removals. See [Rust API compatibility](api.md#rust-api-compatibility).
