#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
: "${DEPLOY_HOST:?DEPLOY_HOST must name the SSH target, for example user@host}"
deploy_host=$DEPLOY_HOST
ssh_opts=${SSH_OPTS:--o BatchMode=yes -o ConnectTimeout=10}

services_file="$repo_root/deploy/tansu-services"
if [[ -f "$services_file" ]]; then
  # shellcheck disable=SC1090
  . "$services_file"
fi
stats_service=${STATS_SERVICE:-${TANSU_STATS_SERVICE:-tansu}}
stats_origin=${STATS_ORIGIN:-}
stats_token_file=${STATS_DEPLOY_TOKEN_FILE:-}
statsctl=${STATSCTL:-statsctl}
stats_enabled=0
if [[ -n "$stats_origin" && -n "$stats_token_file" ]]; then
  stats_enabled=1
fi

deploy_state() {
  SSH_OPTS="$ssh_opts" "$repo_root/deploy/deploy-state.sh" "$1" \
    --host "$deploy_host" \
    --statsctl "$statsctl" \
    --token-file "$stats_token_file" \
    --origin "$stats_origin" \
    --service "$stats_service"
}

deploy_state_exists() {
  # shellcheck disable=SC2086
  ssh $ssh_opts -- "$deploy_host" 'doas -n test -f /var/lib/tansu/deploy/deploy-state.json' >/dev/null 2>&1
}

mode=deploy
rollback_revision=
case "${1:-}" in
  --status) mode=status ;;
  --smoke) mode=smoke ;;
  --marker-sync) mode=marker-sync ;;
  --rollback)
    mode=rollback
    rollback_revision=${2:-}
    [[ -n "$rollback_revision" ]] || { printf 'rollback needs a revision\n' >&2; exit 2; }
    ;;
  "") ;;
  *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
esac

remote_preflight() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$deploy_host" sh -s <<'PREFLIGHT'
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
command -v tailscale >/dev/null
command -v doas >/dev/null
command -v rc-service >/dev/null
command -v rc-update >/dev/null
command -v python3 >/dev/null
test -x /sbin/openrc
doas -n true
remote_arch=$(uname -m)
tailnet_dns_name=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
printf '%s %s\n' "$remote_arch" "$tailnet_dns_name"
PREFLIGHT
}

remote_metadata=$(remote_preflight)
read -r remote_arch tailnet_dns_name <<< "$remote_metadata"

readiness() {
  expected=$1
  attempt=0
  while [ "$attempt" -lt 30 ]; do
    # shellcheck disable=SC2086
    if ssh $ssh_opts -- "$deploy_host" "doas -n sh -s -- '$expected' '$tailnet_dns_name'" <<'HEALTH'
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
expected=$1
tailnet=$2
python3 - "$expected" "$tailnet" <<'PY'
import json, sys, urllib.request
expected, tailnet = sys.argv[1], sys.argv[2]
request = urllib.request.Request("http://127.0.0.1:3001/api/v2/health", headers={"Host": tailnet})
try:
    with urllib.request.urlopen(request, timeout=3) as response:
        body = json.load(response)
except Exception:
    raise SystemExit(1)
if response.status != 200 or body.get("ok") is not True or body.get("release") != expected:
    raise SystemExit(1)
PY
HEALTH
    then return 0; fi
    attempt=$((attempt + 1))
    sleep 2
  done
  return 1
}

previous_revision=
if deploy_state_exists; then
  # shellcheck disable=SC2086
  previous_revision=$(ssh $ssh_opts -- "$deploy_host" 'doas -n sh -s' <<'PREVIOUS'
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
sed -n 's/.*"revision":"\([A-Za-z0-9._-]*\)".*/\1/p' /var/lib/tansu/deploy/deploy-state.json | head -n 1
PREVIOUS
  )
fi

case "$tailnet_dns_name" in
  *.ts.net) ;;
  *) printf 'unexpected Tailscale DNS name: %s\n' "$tailnet_dns_name" >&2; exit 1 ;;
esac

if [[ "$mode" == "marker-sync" ]]; then
  [[ "$stats_enabled" -eq 1 ]] || { printf 'STATS_ORIGIN and STATS_DEPLOY_TOKEN_FILE are required\n' >&2; exit 2; }
  if deploy_state_exists; then
    deploy_state sync
  else
    printf 'no deploy receipt on %s\n' "$deploy_host"
  fi
  exit 0
fi

if [[ "$mode" == "status" ]]; then
  ssh -o BatchMode=yes "$deploy_host" 'doas -n sh -s' <<'STATUS'
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
printf 'host: %s\n' "$(uname -n)"
printf 'current: %s\n' "$(readlink /opt/tansu/current 2>/dev/null || printf 'missing')"
if [ -f /var/lib/tansu/deploy/deploy-state.json ]; then
  printf 'receipt: '
  cat /var/lib/tansu/deploy/deploy-state.json
else
  printf 'receipt: missing\n'
fi
rc-service tansu status || true
rc-service tansu-http-redirect status || true
tailscale serve status
STATUS
  exit 0
fi

if [[ "$mode" == "smoke" ]]; then
  ssh -o BatchMode=yes "$deploy_host" 'doas -n sh -s' <<'SMOKE'
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
rc-service tansu status
rc-service tansu-http-redirect status
python3 - <<'PY'
import http.client

connection = http.client.HTTPConnection("127.0.0.1", 3001, timeout=5)
connection.request("GET", "/")
response = connection.getresponse()
if response.status >= 500:
    raise SystemExit(f"tansu answered {response.status}")
print(f"tansu answered {response.status}")

connection = http.client.HTTPConnection("127.0.0.1", 3002, timeout=5)
connection.request("HEAD", "/")
response = connection.getresponse()
if response.status not in (301, 302, 307, 308):
    raise SystemExit(f"redirect answered {response.status}")
print(f"redirect answered {response.status}")
PY
SMOKE
  exit 0
fi

if [[ "$mode" == "rollback" ]]; then
  case "$rollback_revision" in
    *[!A-Za-z0-9._-]*|"") printf 'invalid revision: %s\n' "$rollback_revision" >&2; exit 2 ;;
  esac
  if [[ "$stats_enabled" -eq 1 ]] && deploy_state_exists; then
    deploy_state sync
  fi
  ssh -o BatchMode=yes "$deploy_host" "doas -n sh -s -- --tailnet '$tailnet_dns_name' --rollback '$rollback_revision'" < "$repo_root/deploy/install.sh"
  if ! readiness "$rollback_revision"; then
    printf '%s: rolled-back release %s is not ready\n' "$deploy_host" "$rollback_revision" >&2
    exit 1
  fi
  if [[ "$stats_enabled" -eq 1 ]] && ! deploy_state mark; then
    printf '%s: deployment marker pending; retry with make deploy-sync\n' "$deploy_host" >&2
  fi
  exit 0
fi

case "$remote_arch" in
  x86_64)
    rust_target=x86_64-unknown-linux-musl
    make_target=build-linux-musl-x86_64
    ;;
  aarch64)
    rust_target=aarch64-unknown-linux-musl
    make_target=build-linux-musl-aarch64
    ;;
  *) printf 'unsupported remote architecture: %s\n' "$remote_arch" >&2; exit 1 ;;
esac

revision=$(git -C "$repo_root" rev-parse HEAD)
mkdir -p "$repo_root/.work/tmp"
TMPDIR="$repo_root/.work/tmp" make -C "$repo_root" "$make_target"
artifact="$repo_root/.work/dist/$rust_target/tansu"
test -s "$artifact"

remote_stage=$(ssh -o BatchMode=yes "$deploy_host" 'mkdir -p "$HOME/.cache/tansu" && chmod 700 "$HOME/.cache/tansu" && mktemp -d "$HOME/.cache/tansu/deploy.XXXXXXXX"')
case "$remote_stage" in
  */.cache/tansu/deploy.*) ;;
  *) printf 'unexpected remote staging path: %s\n' "$remote_stage" >&2; exit 1 ;;
esac

cleanup() {
  ssh -o BatchMode=yes "$deploy_host" sh -s -- "$remote_stage" <<'CLEANUP' >/dev/null 2>&1 || true
set -eu
stage=$1
rm -rf "$stage"
CLEANUP
}
trap cleanup EXIT

ssh -o BatchMode=yes "$deploy_host" "mkdir -p '$remote_stage/openrc'"
scp -q "$artifact" "$deploy_host:$remote_stage/tansu"
scp -q "$repo_root/deploy/http-redirect.py" "$deploy_host:$remote_stage/http-redirect.py"
scp -q "$repo_root/deploy/openrc/tansu" "$deploy_host:$remote_stage/openrc/tansu"
scp -q "$repo_root/deploy/openrc/tansu-http-redirect" "$deploy_host:$remote_stage/openrc/tansu-http-redirect"
if [[ "$stats_enabled" -eq 1 ]] && deploy_state_exists; then
  deploy_state sync
fi
stats_install_args=()
if [[ "$stats_enabled" -eq 1 ]]; then
  ingest_token=$(jaq -er '.ingestToken' "$stats_token_file")
  stats_env="$repo_root/.work/tmp/tansu-stats.env"
  umask 077
  printf 'TANSU_STATS_TOKEN=%s\n' "$ingest_token" > "$stats_env"
  scp -q "$stats_env" "$deploy_host:$remote_stage/stats.env"
  rm -f "$stats_env"
  stats_install_args=(--stats-origin "$stats_origin" --stats-service "$stats_service")
fi
ssh -o BatchMode=yes "$deploy_host" "doas -n sh -s -- --tailnet '$tailnet_dns_name' --revision '$revision' --stage '$remote_stage' ${stats_install_args[*]:-}" < "$repo_root/deploy/install.sh"
if ! readiness "$revision"; then
  printf '%s: release %s did not become ready\n' "$deploy_host" "$revision" >&2
  if [ -n "$previous_revision" ]; then
    printf '%s: rolling back to %s\n' "$deploy_host" "$previous_revision" >&2
    ssh -o BatchMode=yes "$deploy_host" "doas -n sh -s -- --tailnet '$tailnet_dns_name' --rollback '$previous_revision'" < "$repo_root/deploy/install.sh"
    if ! readiness "$previous_revision"; then
      printf '%s: rollback release %s is not ready\n' "$deploy_host" "$previous_revision" >&2
    fi
  fi
  exit 1
fi
if [[ "$stats_enabled" -eq 1 ]] && ! deploy_state mark; then
  printf '%s: deployment marker pending; retry with make deploy-sync\n' "$deploy_host" >&2
fi
