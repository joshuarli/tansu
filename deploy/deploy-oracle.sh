#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
deploy_host=${DEPLOY_HOST:-ubuntu@oracle}

remote_metadata=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$deploy_host" bash -s <<'PREFLIGHT'
set -euo pipefail
command -v tailscale >/dev/null
command -v systemctl >/dev/null
remote_arch=$(uname -m)
tailnet_dns_name=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
printf '%s %s\n' "$remote_arch" "$tailnet_dns_name"
PREFLIGHT
)
read -r remote_arch tailnet_dns_name <<< "$remote_metadata"

case "$tailnet_dns_name" in
  oracle.*.ts.net) ;;
  *) printf 'unexpected Tailscale DNS name: %s\n' "$tailnet_dns_name" >&2; exit 1 ;;
esac

case "$remote_arch" in
  x86_64)
    rust_target=x86_64-unknown-linux-musl
    make_target=build-linux-musl-x86_64
    ;;
  aarch64)
    rust_target=aarch64-unknown-linux-musl
    make_target=build-linux-musl-aarch64
    ;;
  *) printf 'unsupported Oracle architecture: %s\n' "$remote_arch" >&2; exit 1 ;;
esac

mkdir -p "$repo_root/.work/tmp"
TMPDIR="$repo_root/.work/tmp" make -C "$repo_root" "$make_target"
artifact="$repo_root/.work/dist/$rust_target/tansu2"
test -s "$artifact"

remote_stage=$(ssh -o BatchMode=yes "$deploy_host" 'mkdir -p "$HOME/.cache/tansu2" && chmod 700 "$HOME/.cache/tansu2" && mktemp -d "$HOME/.cache/tansu2/deploy.XXXXXXXX"')
case "$remote_stage" in
  /home/*/.cache/tansu2/deploy.*) ;;
  *) printf 'unexpected remote staging path: %s\n' "$remote_stage" >&2; exit 1 ;;
esac

cleanup() {
  ssh -o BatchMode=yes "$deploy_host" bash -s -- "$remote_stage" <<'CLEANUP' >/dev/null 2>&1 || true
set -euo pipefail
stage=$1
rm -f "$stage/tansu2" "$stage/http-redirect.py"
rmdir "$stage"
CLEANUP
}
trap cleanup EXIT

scp -q "$artifact" "$deploy_host:$remote_stage/tansu2"
scp -q "$repo_root/deploy/http-redirect.py" "$deploy_host:$remote_stage/http-redirect.py"
ssh -o BatchMode=yes "$deploy_host" sudo bash -s -- "$tailnet_dns_name" "$remote_stage" < "$repo_root/deploy/install-oracle.sh"
