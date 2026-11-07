#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
: "${DEPLOY_HOST:?DEPLOY_HOST must name the SSH target, for example user@host}"
deploy_host=$DEPLOY_HOST

mode=deploy
rollback_revision=
case "${1:-}" in
  --status) mode=status ;;
  --smoke) mode=smoke ;;
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

case "$tailnet_dns_name" in
  *.ts.net) ;;
  *) printf 'unexpected Tailscale DNS name: %s\n' "$tailnet_dns_name" >&2; exit 1 ;;
esac

if [[ "$mode" == "status" ]]; then
  ssh -o BatchMode=yes "$deploy_host" 'doas -n sh -s' <<'STATUS'
set -eu
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
  ssh -o BatchMode=yes "$deploy_host" "doas -n sh -s -- --tailnet '$tailnet_dns_name' --rollback '$rollback_revision'" < "$repo_root/deploy/install.sh"
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
ssh -o BatchMode=yes "$deploy_host" "doas -n sh -s -- --tailnet '$tailnet_dns_name' --revision '$revision' --stage '$remote_stage'" < "$repo_root/deploy/install.sh"
