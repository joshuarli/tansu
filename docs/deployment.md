# Deployment

Run one Tansu server per vault root. A second server, or a second config
naming the same directory, exits at startup with an "already owned" error.

Tansu binds to `127.0.0.1` on port `3000` by default. Without authentication
settings, the server uses loopback mode and passkey routes are disabled. Keep
the default for local use.

## Serve privately over Tailscale

[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) gives
tailnet devices HTTPS access to the loopback server. Configure HTTPS for your
tailnet, then set the browser URL as the authenticated origin:

Set authentication in the setup page or with
`tansu config init --vault Notes /path/to/notes --auth https://laptop.example-tailnet.ts.net laptop.example-tailnet.ts.net Tansu`.

Use the exact tailnet HTTPS hostname shown by Tailscale for
`external_origin`. The RP ID must match that hostname or be one of its parent
domains. See [Configuration](configuration.md) for the full path and validation
rules.

Start Tansu, then publish its local port to your tailnet:

```sh
tansu
tailscale serve --bg 3000
tailscale serve status
```

Open the HTTPS URL shown by `tailscale serve status`. Tailscale Serve restricts
access to your tailnet and its access controls. Do not run `tailscale funnel`;
Funnel exposes the service to the public internet. Tailscale identity headers
do not replace Tansu passkey authentication.

## Deploy to a remote host

Run `make deploy` from the repository root. `DEPLOY_HOST` defaults to
`josh@lisa`; override it with `make deploy DEPLOY_HOST=user@host`. The script
connects over SSH, builds the static Linux binary for the remote architecture
in Docker, uploads the binary, redirect script, and OpenRC templates, and runs
`deploy/install.sh` through passwordless `doas`.

The remote host must run Alpine with OpenRC (`/sbin/openrc`, `rc-service`,
`rc-update`), Tailscale, Python 3, and passwordless `doas` for the SSH user.
The deployment uses OpenRC only; it does not write systemd units.

The Stats agent is a host prerequisite, not part of a Tansu release. Install it
once per host as described in the Stats README, and keep its token out of the
Tansu release. The agent reports host metrics; Tansu reports its own application
events with the ingest token from its service credential file.

The layout is:

- `/opt/tansu/releases/<commit>/tansu` and `http-redirect.py` are immutable.
- `/opt/tansu/current` is a symlink to the active release.
- `/etc/init.d/tansu`, `/etc/init.d/tansu-http-redirect`, `/etc/conf.d/tansu`,
  and `/etc/conf.d/tansu-http-redirect` are the OpenRC service files from
  `deploy/openrc/`. Both run under `supervise-daemon` as `tansu:tansu`.
- `/var/lib/tansu` keeps the config, data, and vault.
- `/var/lib/tansu/deploy/deploy-state.json` is the owner-only receipt with the
  active and previous revisions.

The app listens on 3001 and the redirect on 3002. Tailscale Serve maps HTTPS
443 to 3001 and HTTP 3000 to 3002. The URL `http://<host>:3000` redirects to
`https://<host>.<tailnet>.ts.net`, where the server uses authenticated mode.
Tailscale HTTPS must be enabled for your tailnet. See the
[Tailscale Serve documentation](https://tailscale.com/docs/reference/tailscale-cli/serve).

Preflight runs entirely before the first write. A second deploy of the same
commit with the same binary and service files writes nothing and restarts
neither service. A different binary for an existing revision is refused;
commit the change instead. The five newest releases are retained and older ones
are pruned after an upgrade.

`make deploy-status` prints the current link, receipt, OpenRC status, and
Tailscale Serve status. `make deploy-smoke` verifies both services are running
and that ports 3001 and 3002 answer. `make deploy` does not run the smoke check
for you.

`make deploy-check` runs `deploy/lifecycle-check.sh` in a disposable
`alpine:3.22` container. It proves a fresh install, a no-op repeat, an upgrade
that retains the previous release, a rollback, and a preflight rejection that
writes nothing.

A deploy replaces only the release directory and the generated OpenRC/conf
files. It never replaces `/var/lib/tansu` (settings, data, vault, auth state),
the host's Tailscale identity, or the Stats agent installation. A rollback
reuses the retained release and the existing data; it does not downgrade the
data schema, so restore a backup if an older binary cannot open newer state.

### First and subsequent deploys

The first deploy needs `DEPLOY_HOST` (or the default `josh@lisa`), a public key
the host accepts, and an empty or initialized `/var/lib/tansu`. Subsequent
deploys of the same commit are no-ops; a new commit builds and activates a new
release, keeps the previous release, and writes a marker only for a genuine
activation. A rollback is a new activation and gets its own marker.

```sh
make deploy-check
make deploy DEPLOY_HOST=user@host
make deploy-status DEPLOY_HOST=user@host
make deploy-smoke DEPLOY_HOST=user@host
make rollback REV=<commit> DEPLOY_HOST=user@host
```

The server's readiness URL is `GET /api/v2/health`; it reports the active
release. `make deploy-smoke` checks both the Tansu and redirect services. Use
`make deploy-status` after a failed readiness wait; a failed preflight leaves
the previous release and data untouched.

### Report deployments to Stats

Tansu follows the
[Stats integration contract](https://github.com/joshuarli/stats/blob/master/docs/integration.md).
The Stats agent is installed once per host, separately from a Tansu release;
`make deploy` only changes Tansu itself.

Register the host and `tansu` service once from a Stats checkout. `HOST_ID` is
the host that runs Tansu and the agent, and the credential file is mode 0600:

```sh
pnpm --dir cloudflare -s statsctl service create \
  --name tansu \
  --host HOST_ID \
  --unit tansu \
  --health-url "https://tansu.$TAILNET.ts.net/api/v2/health" \
  --credential-file .work/credentials/tansu.json
```

Then pass the marker settings to `make deploy` or `make rollback`:

```sh
export STATS_ORIGIN=https://stats.17166969.xyz
export STATS_DEPLOY_TOKEN_FILE=../stats/.work/credentials/tansu.json
export STATSCTL=../stats/dist/statsctl-0.1.0.mjs
make deploy
```

`make deploy` syncs a pending marker before installing and records a marker
after a genuine activation. Repeating an already recorded release publishes
nothing. If the marker POST fails, the receipt keeps the marker pending and
`make deploy-sync` (or the next deploy) retries it with the same id; a marker is
reported recorded only after Stats accepts it. `make rollback REV=...` records
the rollback as a new activation. The receipt is
`/var/lib/tansu/deploy/deploy-state.json`; `make deploy-status` prints it.

The credential file from `statsctl service create` is JSON with `deployToken`,
`ingestToken`, and `hostIds`. Keep it mode 0600. `make deploy` uses
`deployToken` only for the marker; the OpenRC unit receives `ingestToken` from
`/etc/tansu/stats.env` and never reads the credential file. Rotating the deploy
token does not change telemetry, and rotating the ingest token requires
reinstalling or rewriting `stats.env`.

Tansu reports application telemetry when `TANSU_STATS_ENDPOINT` and
`TANSU_STATS_TOKEN` are present. The endpoint is the Stats origin, the token is
the service's `ingestToken` from the credential file, and
`TANSU_STATS_SERVICE` defaults to `tansu`. The OpenRC unit sets `TANSU_RELEASE`
from the active release, which matches the marker version. The producer is
bounded and asynchronous: a save never waits for Stats, and an unreachable
endpoint drops events within the queue limit. The installer owns
`/etc/conf.d/tansu`, so keep the ingest token in a root-owned, `tansu`-readable
file and source it from the unit rather than putting it in that file.

### When Stats is unavailable

A note save, search, or health check still succeeds when Stats is down. The
producer drops events once its bounded queue is full; the drop count is exposed
through the Tansu telemetry state and is not an application failure. A deploy
whose marker POST fails exits nonzero with the marker still pending:
`make deploy-status` shows it, and `make deploy-sync` retries the same marker id
after Stats returns. Do not invent a new marker id for a retry. If telemetry is
not configured, the producer is a no-op and no network request is made.

The deployment initializes SQLite settings for an empty `Personal` vault. Enroll
the first passkey before editing notes. Stop the service, issue a one-time
capability, then start the service again:

```sh
ssh user@host 'doas -n rc-service tansu stop'
ssh user@host 'doas -n -u tansu env HOME=/var/lib/tansu XDG_CONFIG_HOME=/var/lib/tansu/config XDG_DATA_HOME=/var/lib/tansu/data /opt/tansu/current/tansu auth enroll'
ssh user@host 'doas -n rc-service tansu start'
```

Enter the printed capability at the authenticated HTTPS URL and complete
passkey registration. The capability expires after ten minutes.

## Enroll and recover passkeys

Stop the server before running local auth commands. The exclusive auth-state
lock rejects these commands while the server is running.

1. Run `tansu auth enroll` and keep the printed capability private. It expires
   after ten minutes and can enroll only the first credential.
2. Start Tansu and open its configured HTTPS origin in a browser.
3. Complete the first passkey registration with the capability.
4. Add a second passkey from a recently verified owner session. Keep access to
   both authenticators or to their credential manager's recovery process.

Back up the server's auth database while the server is stopped:

```sh
tansu auth backup "$HOME/tansu-auth-backup.db"
```

Restore it with `tansu auth restore PATH`. Keep `external_origin` and `rp_id`
set to the values used when you created the backup. Tansu clears credentials
when either value changes. Restore clears sessions, enrollment capabilities,
and unfinished ceremonies. The backup contains the
server's public credential records, not authenticator private keys. If every
registered authenticator is lost, an auth database backup alone cannot restore
login access.

Backup and restore verify the database with `PRAGMA quick_check`, which a
SQLite build compiled with `SQLITE_OMIT_INTEGRITY_CHECK` does not provide.
Check the shipped SQLite build and binary before a release:

```sh
make test-sqlite-static
make build-linux-musl-x86_64
make auth-recovery-drill
```

`make test-sqlite-static` builds the static SQLite archive from
`scripts/build-sqlite-static.sh`, which downloads the SQLite source, and runs
the auth tests linked against it. `make auth-recovery-drill` runs
`scripts/auth-recovery-drill.sh` against the binary at `AUTH_DRILL_BIN`, which
defaults to the x86_64 musl artifact. The drill uses a scratch config, data, and
vault under `.work/tmp/auth-recovery-drill`. It enrolls, backs up, restores,
backs up the restored database, and confirms that restore rejects a corrupt
backup. The binary must run on the host, so run the drill on Linux for the musl
artifact.

On 2026-10-23, `make test-sqlite-static` passed all 33 auth tests on macOS
arm64 with the downloaded SQLite 3.54.0 archive. `make build-linux-musl-x86_64`
produced the static release binary. The recovery drill passed against that
binary in an x86_64 Linux Alpine container, including corrupt-backup rejection.
Run the drill in a container on macOS:

```sh
docker run --rm --platform linux/amd64 -v "$PWD:/work" -w /work alpine:edge \
  sh scripts/auth-recovery-drill.sh /work/.work/dist/x86_64-unknown-linux-musl/tansu
```

## Back up and restore Tansu state

Stop Tansu and other vault writers before copying state. Back up these items
together from one quiescent point:

- Every configured vault, including Markdown files and `z-images/` assets.
- The settings database at `$XDG_CONFIG_HOME/tansu/settings.sqlite3`, or
  `$HOME/.config/tansu/settings.sqlite3` when `XDG_CONFIG_HOME` is unset.
- The full `tansu/` directory in `XDG_DATA_HOME`, or
  `$HOME/.local/share/tansu/` when `XDG_DATA_HOME` is unset.
- The browser profile if you need its IndexedDB workspace and draft records.

Vault files are authored content. The app data directory contains stable server
and vault identities, catalogs, revision snapshots, conflict drafts, settings,
and search indexes. Search indexes are derived and can be rebuilt from the
vault and catalog data. Keep the vaults and app data from the same backup; the
catalog tracks visible file hashes and revisions. Browser IndexedDB is separate
from server state, is not encrypted by Tansu, and is not included in a server
backup. Browser storage can be cleared or evicted, and a journal checkpoint may
not include the most recent keystrokes.

If you lose a search index, restart Tansu so startup can rebuild it. Do not
delete the catalog or revision data to rebuild search. Those files hold durable
identity and recovery state.

## Roll back

### Roll back a release

List the retained releases on the host, then activate one:

```sh
ssh user@host 'doas -n sh -c "ls -1 /opt/tansu/releases"'
make rollback REV=<commit> DEPLOY_HOST=user@host
```

`make rollback` does not build or upload. It verifies
`/opt/tansu/releases/<commit>/tansu` exists, points `/opt/tansu/current` at it,
restarts both OpenRC services, and updates the receipt. The release that was
active is retained, so a second rollback can return to it.

A rollback runs the older binary against the current data. Tansu may update its
SQLite schema when a newer release opens app data, and it does not guarantee
that a newer catalog can be opened by an older binary. Back up and restore the
data if the schema needs to move backwards; the release rollback alone does not
downgrade persistent state.

### Restore from a backup

Stop the server before restoring a backup. Restore the settings database, all vaults, and
the full app data directory from the same point in time before starting an older
binary. Tansu may update its SQLite schema when it opens app data. The project
does not guarantee that a newer catalog can be opened by an older binary.

The Markdown files remain ordinary files, but restoring only the vault or only
app data can pair different file contents and catalog state. A rollback cannot
recover edits made after the backup unless those edits remain in another copy
or in browser-local drafts.
