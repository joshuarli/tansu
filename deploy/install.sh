#!/bin/sh
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

root=
check=0
rollback=0
revision=
stage=
tailnet=
origin=
rp_id=
stats_origin=
stats_service=tansu
keep=${TANSU_KEEP_RELEASES:-5}

usage() {
  printf '%s\n' "usage: install.sh --tailnet DNS --revision REV --stage DIR [--origin URL] [--rp-id ID] [--stats-origin URL] [--stats-service NAME] [--root DIR] [--check]" "       install.sh --tailnet DNS --rollback REV [--origin URL] [--rp-id ID] [--root DIR] [--check]" >&2
  exit 2
}

die() {
  printf 'tansu install: %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --root) root=${2:?--root needs a path}; shift 2 ;;
    --check) check=1; shift ;;
    --rollback) rollback=1; revision=${2:?--rollback needs a revision}; shift 2 ;;
    --revision) revision=${2:?--revision needs a revision}; shift 2 ;;
    --stage) stage=${2:?--stage needs a path}; shift 2 ;;
    --tailnet) tailnet=${2:?--tailnet needs a DNS name}; shift 2 ;;
    --origin) origin=${2:?--origin needs a URL}; shift 2 ;;
    --rp-id) rp_id=${2:?--rp-id needs an ID}; shift 2 ;;
    --stats-origin) stats_origin=${2:?--stats-origin needs a URL}; shift 2 ;;
    --stats-service) stats_service=${2:?--stats-service needs a name}; shift 2 ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ "$(id -u)" = 0 ] || die "run as root (doas)"
if [ -n "$root" ]; then
  case "$root" in /*) ;; *) die "--root must be absolute" ;; esac
  [ -d "$root" ] || die "--root is not a directory: $root"
  [ ! -L "$root" ] || die "--root is a symlink: $root"
fi
root=${root%/}
path() { printf '%s%s' "$root" "$1"; }

case "$revision" in
  ''|*[!A-Za-z0-9._-]*) die "revision must be 1-64 letters, digits, or ._-, got: $revision" ;;
esac
[ "${#revision}" -le 64 ] || die "revision is longer than 64 characters"
case "$tailnet" in
  ''|*[!A-Za-z0-9.-]*|*..*) die "tailnet must be a DNS name, got: $tailnet" ;;
esac
case "$tailnet" in
  *.ts.net) ;;
  *) die "tailnet must end in .ts.net, got: $tailnet" ;;
esac
if [ -n "$origin" ]; then
  public_mode=1
  case "$origin" in
    https://*) ;;
    *) die "--origin must be an HTTPS origin, got: $origin" ;;
  esac
  case "$origin" in
    https://*/*) die "--origin must be an HTTPS origin with nothing after the host, got: $origin" ;;
  esac
  if [ -z "$rp_id" ]; then die "--rp-id is required with --origin" ; fi
  case "$rp_id" in
    ''|*[!A-Za-z0-9.-]*|*..*) die "--rp-id must be a DNS name, got: $rp_id" ;;
  esac
  if [ "$origin" != "https://$rp_id" ]; then die "--origin must be exactly https://$rp_id" ; fi
else
  public_mode=0
  origin="https://$tailnet"
  rp_id="$tailnet"
fi

if [ "$rollback" -eq 0 ]; then
  [ -n "$stage" ] || die "--stage is required"
  [ -d "$stage" ] || die "stage is not a directory: $stage"
  for file in tansu http-redirect.py openrc/tansu openrc/tansu-http-redirect; do
    [ -s "$stage/$file" ] || die "stage is missing $file"
    [ ! -L "$stage/$file" ] || die "stage $file is a symlink"
  done
fi

for command in python3 tailscale getent install cmp mv ln chown chmod date rc-service rc-update; do
  command -v "$command" >/dev/null 2>&1 || die "missing command: $command"
done
if [ "$rollback" -eq 0 ]; then
  for command in useradd runuser; do
    command -v "$command" >/dev/null 2>&1 || die "missing command: $command"
  done
fi

if [ -z "$public_mode" ]; then
  current_dns_name=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null) || die "cannot read the Tailscale DNS name"
  [ "$current_dns_name" = "$tailnet" ] || die "Tailscale DNS name is $current_dns_name, not $tailnet"
fi

for directory in /opt/tansu /opt/tansu/releases /var/lib/tansu /var/lib/tansu/config /var/lib/tansu/config/tansu /var/lib/tansu/data /var/lib/tansu/vault /var/lib/tansu/deploy /var/log/tansu /etc/init.d /etc/conf.d /etc/runlevels/default; do
  target=$(path "$directory")
  if [ -L "$target" ]; then die "$target must not be a symlink"; fi
  if [ -e "$target" ] && [ ! -d "$target" ]; then die "$target must be a directory"; fi
done
for file in /etc/init.d/tansu /etc/init.d/tansu-http-redirect /etc/conf.d/tansu /etc/conf.d/tansu-http-redirect; do
  target=$(path "$file")
  if [ -L "$target" ]; then die "$target must not be a symlink"; fi
  if [ -e "$target" ] && [ ! -f "$target" ]; then die "$target must be a regular file"; fi
done
current=$(path /opt/tansu/current)
if [ -L "$current" ]; then :; elif [ -e "$current" ]; then die "$current must be a symlink"; fi
for file in /etc/runlevels/default/tansu /etc/runlevels/default/tansu-http-redirect; do
  target=$(path "$file")
  if [ -L "$target" ]; then
    case "$(readlink "$target")" in /etc/init.d/*) ;; *) die "$target points outside /etc/init.d" ;; esac
  elif [ -e "$target" ]; then
    die "$target must be a symlink"
  fi
done

settings=$(path /var/lib/tansu/config/tansu/settings.sqlite3)
if [ -L "$settings" ]; then die "$settings must not be a symlink"; fi
if [ -e "$settings" ] && [ ! -f "$settings" ]; then die "$settings must be a regular file"; fi
config_missing=0
if [ ! -e "$settings" ]; then
  config_missing=1
  [ "$rollback" -eq 0 ] || die "cannot roll back without an initialized settings database"
fi
if [ "$config_missing" -eq 0 ]; then
  python3 - "$settings" "$origin" "$rp_id" <<'CONFIG_CHECK' || die "Tansu settings database is not initialized for $origin"
import json
import sqlite3
import sys

with sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True) as database:
    row = database.execute("SELECT value FROM settings WHERE key='app'").fetchone()
if row is None:
    raise SystemExit("Tansu app settings are not initialized")
config = json.loads(row[0])

auth = config.get("auth", {})
expected_origin = sys.argv[2]
expected_rp_id = sys.argv[3]
if auth.get("externalOrigin") != expected_origin or auth.get("rpId") != expected_rp_id:
    raise SystemExit("Tansu config must use authenticated mode with the current HTTPS origin and RP ID")
CONFIG_CHECK
fi

release=$(path "/opt/tansu/releases/$revision")
new_release=$(path "/opt/tansu/releases/.$revision.new")
if [ -e "$new_release" ] || [ -L "$new_release" ]; then die "stale release staging path: $new_release"; fi
release_changed=0
if [ -L "$release" ]; then die "$release must not be a symlink"; fi
if [ -e "$release" ]; then
  [ -d "$release" ] || die "$release is not a directory"
  if [ "$rollback" -eq 0 ]; then
    cmp -s "$stage/tansu" "$release/tansu" || die "release $revision already exists with a different binary"
    cmp -s "$stage/http-redirect.py" "$release/http-redirect.py" || die "release $revision already exists with a different redirect script"
  fi
else
  [ "$rollback" -eq 0 ] || die "release $revision is not installed; rollback needs a retained release"
  release_changed=1
fi
if [ "$rollback" -eq 1 ]; then
  [ -f "$release/tansu" ] && [ -x "$release/tansu" ] || die "release $revision has no executable tansu"
  [ -f "$release/http-redirect.py" ] || die "release $revision has no http-redirect.py"
fi

service_changed=0
conf_changed=0
conf_tansu="TANSU_PORT=3001
TANSU_HOME=/var/lib/tansu"
if [ -n "$stats_origin" ]; then
  conf_tansu="$conf_tansu
TANSU_STATS_ENDPOINT=$stats_origin
TANSU_STATS_SERVICE=$stats_service"
fi
conf_redirect="TANSU_REDIRECT_ORIGIN=$origin
TANSU_HOME=/var/lib/tansu"
stats_env="$stage/stats.env"
stats_env_changed=0
if [ "$rollback" -eq 0 ] && [ -f "$stats_env" ]; then
  if [ ! -f "$(path /etc/tansu/stats.env)" ] || ! cmp -s "$stats_env" "$(path /etc/tansu/stats.env)"; then
    stats_env_changed=1
  fi
fi
if [ "$rollback" -eq 0 ]; then
  installed_tansu=$(path /etc/init.d/tansu)
  installed_redirect=$(path /etc/init.d/tansu-http-redirect)
  if [ ! -f "$installed_tansu" ] || [ ! -x "$installed_tansu" ] || ! cmp -s "$stage/openrc/tansu" "$installed_tansu"; then service_changed=1; fi
  if [ ! -f "$installed_redirect" ] || [ ! -x "$installed_redirect" ] || ! cmp -s "$stage/openrc/tansu-http-redirect" "$installed_redirect"; then service_changed=1; fi
  if ! printf '%s\n' "$conf_tansu" | cmp -s - "$(path /etc/conf.d/tansu)" 2>/dev/null; then conf_changed=1; fi
  if ! printf '%s\n' "$conf_redirect" | cmp -s - "$(path /etc/conf.d/tansu-http-redirect)" 2>/dev/null; then conf_changed=1; fi
else
  for file in /etc/init.d/tansu /etc/init.d/tansu-http-redirect /etc/conf.d/tansu /etc/conf.d/tansu-http-redirect; do
    [ -f "$(path "$file")" ] || die "cannot roll back without installed service file $file"
  done
fi

current_target=$(readlink "$current" 2>/dev/null || true)
current_changed=0
[ "$current_target" = "releases/$revision" ] || current_changed=1

runlevel_changed=0
for service in tansu tansu-http-redirect; do
  [ -L "$(path "/etc/runlevels/default/$service")" ] || runlevel_changed=1
done

tansu_active=0
redirect_active=0
if rc-service tansu status >/dev/null 2>&1; then tansu_active=1; fi
if rc-service tansu-http-redirect status >/dev/null 2>&1; then redirect_active=1; fi

restart_required=0
if [ "$release_changed" -eq 1 ] || [ "$current_changed" -eq 1 ] || [ "$service_changed" -eq 1 ] || [ "$conf_changed" -eq 1 ] || [ "$stats_env_changed" -eq 1 ] || [ "$config_missing" -eq 1 ]; then
  restart_required=1
fi

if [ "$check" -eq 1 ]; then
  printf 'deploy-check: revision=%s release_changed=%s current_changed=%s service_changed=%s conf_changed=%s config_missing=%s runlevel_changed=%s tansu_active=%s redirect_active=%s\n' \
    "$revision" "$release_changed" "$current_changed" "$service_changed" "$conf_changed" "$config_missing" "$runlevel_changed" "$tansu_active" "$redirect_active"
  exit 0
fi

if ! getent passwd tansu >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/tansu --no-create-home --shell /usr/sbin/nologin tansu
fi

install -d -o root -g root -m 0755 "$(path /opt/tansu)" "$(path /opt/tansu/releases)"
install -d -o root -g tansu -m 0750 "$(path /var/lib/tansu)"
install -d -o tansu -g tansu -m 0750 "$(path /var/lib/tansu/config)" "$(path /var/lib/tansu/config/tansu)" "$(path /var/lib/tansu/data)" "$(path /var/lib/tansu/vault)" "$(path /var/log/tansu)"
install -d -o tansu -g tansu -m 0700 "$(path /var/lib/tansu/deploy)"
install -d -o root -g root -m 0755 "$(path /etc/init.d)" "$(path /etc/conf.d)" "$(path /etc/runlevels/default)"
install -d -o root -g tansu -m 0750 "$(path /etc/tansu)"
if [ "$stats_env_changed" -eq 1 ]; then
  install -o root -g tansu -m 0640 "$stats_env" "$(path /etc/tansu/stats.env)"
fi

if [ "$release_changed" -eq 1 ]; then
  install -d -o root -g root -m 0755 "$new_release"
  install -o root -g root -m 0755 "$stage/tansu" "$new_release/tansu"
  install -o root -g root -m 0644 "$stage/http-redirect.py" "$new_release/http-redirect.py"
  mv "$new_release" "$release"
fi

if [ "$current_changed" -eq 1 ]; then
  ln -sfn "releases/$revision" "$current"
fi

if [ "$service_changed" -eq 1 ]; then
  install -o root -g root -m 0755 "$stage/openrc/tansu" "$(path /etc/init.d/tansu).new"
  mv -f "$(path /etc/init.d/tansu).new" "$(path /etc/init.d/tansu)"
  install -o root -g root -m 0755 "$stage/openrc/tansu-http-redirect" "$(path /etc/init.d/tansu-http-redirect).new"
  mv -f "$(path /etc/init.d/tansu-http-redirect).new" "$(path /etc/init.d/tansu-http-redirect)"
fi

if [ "$conf_changed" -eq 1 ]; then
  printf '%s\n' "$conf_tansu" > "$(path /etc/conf.d/tansu).new"
  chown root:root "$(path /etc/conf.d/tansu).new"
  chmod 0644 "$(path /etc/conf.d/tansu).new"
  mv -f "$(path /etc/conf.d/tansu).new" "$(path /etc/conf.d/tansu)"
  printf '%s\n' "$conf_redirect" > "$(path /etc/conf.d/tansu-http-redirect).new"
  chown root:root "$(path /etc/conf.d/tansu-http-redirect).new"
  chmod 0644 "$(path /etc/conf.d/tansu-http-redirect).new"
  mv -f "$(path /etc/conf.d/tansu-http-redirect).new" "$(path /etc/conf.d/tansu-http-redirect)"
fi

if [ "$config_missing" -eq 1 ]; then
  runuser -u tansu -- env \
    HOME="$(path /var/lib/tansu)" \
    XDG_CONFIG_HOME="$(path /var/lib/tansu/config)" \
    XDG_DATA_HOME="$(path /var/lib/tansu/data)" \
    "$(path /opt/tansu/current/tansu)" config init \
    --vault Personal "$(path /var/lib/tansu/vault)" \
    --auth "$origin" "$rp_id" Tansu
  chown tansu:tansu "$settings"
  chmod 0640 "$settings"
fi

for service in tansu tansu-http-redirect; do
  if [ ! -L "$(path "/etc/runlevels/default/$service")" ]; then
    rc-update add "$service" default
  fi
done

for service in tansu tansu-http-redirect; do
  if [ "$restart_required" -eq 1 ]; then
    if rc-service "$service" status >/dev/null 2>&1; then
      rc-service "$service" restart
    else
      rc-service "$service" start
    fi
  elif ! rc-service "$service" status >/dev/null 2>&1; then
    rc-service "$service" start
  fi
done

if [ "$restart_required" -eq 1 ] || [ "$runlevel_changed" -eq 1 ]; then
  if [ "$public_mode" -eq 0 ]; then
    tailscale serve --yes --bg --https=443 3001
    tailscale serve --yes --bg --http=3000 3002
    tailscale serve status
  fi
fi

state=$(path /var/lib/tansu/deploy/deploy-state.json)
previous_revision=
if [ -f "$state" ]; then
  previous_revision=$(sed -n 's/.*"revision":"\([A-Za-z0-9._-]*\)".*/\1/p' "$state" | head -n 1)
fi
if [ ! -f "$state" ] || [ "$previous_revision" != "$revision" ]; then
  now_ms=$(( $(date +%s) * 1000 ))
  printf '{"revision":"%s","previousRevision":"%s","release":"/opt/tansu/releases/%s","updatedAtMs":%s}\n' "$revision" "$previous_revision" "$revision" "$now_ms" > "$state.new"
  chown tansu:tansu "$state.new"
  chmod 0600 "$state.new"
  mv -f "$state.new" "$state"
fi

if [ "$release_changed" -eq 1 ]; then
  index=0
  for name in $(ls -1t "$(path /opt/tansu/releases)" 2>/dev/null || true); do
    case "$name" in .*) continue ;; esac
    [ -d "$(path "/opt/tansu/releases/$name")" ] || continue
    index=$((index + 1))
    [ "$index" -le "$keep" ] && continue
    [ "$name" = "$revision" ] && continue
    rm -rf "$(path "/opt/tansu/releases/$name")"
  done
fi

printf 'Tansu deployed at %s\n' "$origin"
printf 'release: %s\n' "$release"
printf 'current: %s\n' "$(readlink "$current" 2>/dev/null || printf 'missing')"
printf 'HTTP entry point: http://%s:3000\n' "${tailnet%%.*}"
