#!/bin/sh
set -eu

src=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/tansu-deploy-check.XXXXXX")
trap 'rm -rf "$work"' EXIT

root=$work/root
bin=$work/bin
state=$work/state
mkdir -p "$root" "$bin" "$state"
export PATH="$bin:$PATH"
export TANSU_TEST_ROOT="$root"
export TANSU_TEST_STATE="$state"

fail() {
  printf 'deploy-check: FAIL: %s\n' "$*" >&2
  exit 1
}

pass() {
  printf 'deploy-check: ok: %s\n' "$*"
}

if ! getent group tansu >/dev/null 2>&1; then addgroup -S tansu; fi
if ! getent passwd tansu >/dev/null 2>&1; then adduser -S -D -H -h /var/lib/tansu -s /sbin/nologin -G tansu tansu; fi

cat > "$bin/python3" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "-c" ]; then
  printf 'test-host.tail1234.ts.net\n'
  exit 0
fi
cat >/dev/null
exit 0
EOF

cat > "$bin/tailscale" <<'EOF'
#!/bin/sh
printf 'tailscale %s\n' "$*" >> "$TANSU_TEST_STATE/log"
case "${1:-}" in
  status) printf '{"Self":{"DNSName":"test-host.tail1234.ts.net."}}\n' ;;
  serve) if [ "${2:-}" = "status" ]; then printf 'https://test-host.tail1234.ts.net -> 127.0.0.1:3001\n'; fi ;;
esac
exit 0
EOF

cat > "$bin/rc-service" <<'EOF'
#!/bin/sh
service=$1
action=$2
printf 'rc-service %s %s\n' "$service" "$action" >> "$TANSU_TEST_STATE/log"
case "$action" in
  status) [ -f "$TANSU_TEST_STATE/active.$service" ] && exit 0 || exit 3 ;;
  start|restart) : > "$TANSU_TEST_STATE/active.$service" ;;
  stop) rm -f "$TANSU_TEST_STATE/active.$service" ;;
  *) exit 2 ;;
esac
EOF

cat > "$bin/rc-update" <<'EOF'
#!/bin/sh
[ "${1:-}" = "add" ] || exit 0
service=$2
runlevel=$3
printf 'rc-update add %s %s\n' "$service" "$runlevel" >> "$TANSU_TEST_STATE/log"
mkdir -p "$TANSU_TEST_ROOT/etc/runlevels/$runlevel"
ln -sfn "/etc/init.d/$service" "$TANSU_TEST_ROOT/etc/runlevels/$runlevel/$service"
EOF

cat > "$bin/runuser" <<'EOF'
#!/bin/sh
[ "${1:-}" = "-u" ] && shift 2
[ "${1:-}" = "--" ] && shift
exec "$@"
EOF

cat > "$bin/useradd" <<'EOF'
#!/bin/sh
printf 'useradd %s\n' "$*" >> "$TANSU_TEST_STATE/log"
exit 0
EOF

chmod 755 "$bin"/*

stage_for() {
  revision=$1
  directory=$work/stage-$revision
  mkdir -p "$directory/openrc"
  cat > "$directory/tansu" <<EOF
#!/bin/sh
printf 'tansu $revision %s\n' "\$*" >> "\$TANSU_TEST_STATE/log"
if [ "\${1:-}" = "config" ]; then
  mkdir -p "\$XDG_CONFIG_HOME/tansu"
  : > "\$XDG_CONFIG_HOME/tansu/settings.sqlite3"
fi
exit 0
EOF
  chmod 755 "$directory/tansu"
  cp "$src/deploy/http-redirect.py" "$directory/http-redirect.py"
  cp "$src/deploy/openrc/tansu" "$directory/openrc/tansu"
  cp "$src/deploy/openrc/tansu-http-redirect" "$directory/openrc/tansu-http-redirect"
}

install_tansu() {
  revision=$1
  directory=$2
  shift 2
  sh "$src/deploy/install.sh" --root "$root" --tailnet test-host.tail1234.ts.net --revision "$revision" --stage "$directory" "$@"
}

rollback_tansu() {
  sh "$src/deploy/install.sh" --root "$root" --tailnet test-host.tail1234.ts.net --rollback "$1"
}

snapshot() {
  (
    cd "$root"
    find . \( -type f -o -type l \) -print | LC_ALL=C sort | while IFS= read -r file; do
      if [ -L "$file" ]; then
        printf 'L %s %s\n' "$file" "$(readlink "$file")"
      else
        printf 'F %s %s\n' "$file" "$(sha256sum "$file" | cut -d' ' -f1)"
      fi
    done
  )
}

stage_for rev1
stage_for rev2
stage_for rev3

install_tansu rev1 "$work/stage-rev1"
[ -x "$root/opt/tansu/releases/rev1/tansu" ] || fail "rev1 binary missing"
[ "$(readlink "$root/opt/tansu/current")" = "releases/rev1" ] || fail "current does not point at rev1"
[ -x "$root/etc/init.d/tansu" ] || fail "tansu OpenRC service missing"
[ -x "$root/etc/init.d/tansu-http-redirect" ] || fail "redirect OpenRC service missing"
grep -qx 'TANSU_PORT=3001' "$root/etc/conf.d/tansu" || fail "tansu conf.d content is wrong"
grep -qx 'TANSU_REDIRECT_ORIGIN=https://test-host.tail1234.ts.net' "$root/etc/conf.d/tansu-http-redirect" || fail "redirect conf.d origin is wrong"
grep -q '"revision":"rev1"' "$root/var/lib/tansu/deploy/deploy-state.json" || fail "fresh receipt is wrong"
[ -L "$root/etc/runlevels/default/tansu" ] || fail "tansu was not added to default"
[ -L "$root/etc/runlevels/default/tansu-http-redirect" ] || fail "redirect was not added to default"
pass "fresh install"

before=$(snapshot)
: > "$state/log"
install_tansu rev1 "$work/stage-rev1"
after=$(snapshot)
[ "$before" = "$after" ] || fail "a repeated install changed the target"
if grep -Eq 'rc-service (tansu|tansu-http-redirect) (start|restart)|rc-update add|tailscale serve --' "$state/log"; then
  fail "a repeated install restarted services or rewrote tailscale serve"
fi
pass "repeated install writes nothing"

install_tansu rev2 "$work/stage-rev2"
[ "$(readlink "$root/opt/tansu/current")" = "releases/rev2" ] || fail "current does not point at rev2"
[ -x "$root/opt/tansu/releases/rev1/tansu" ] || fail "rev1 was not retained"
[ -x "$root/opt/tansu/releases/rev2/tansu" ] || fail "rev2 binary missing"
grep -q '"revision":"rev2"' "$root/var/lib/tansu/deploy/deploy-state.json" || fail "upgrade receipt is wrong"
grep -q '"previousRevision":"rev1"' "$root/var/lib/tansu/deploy/deploy-state.json" || fail "upgrade receipt lost the previous revision"
pass "upgrade keeps the previous release"

rollback_tansu rev1
[ "$(readlink "$root/opt/tansu/current")" = "releases/rev1" ] || fail "rollback did not activate rev1"
[ -x "$root/opt/tansu/releases/rev2/tansu" ] || fail "rollback removed rev2"
grep -q '"revision":"rev1"' "$root/var/lib/tansu/deploy/deploy-state.json" || fail "rollback receipt is wrong"
grep -q '"previousRevision":"rev2"' "$root/var/lib/tansu/deploy/deploy-state.json" || fail "rollback receipt lost the previous revision"
pass "rollback activates a retained release"

mv "$root/etc/init.d/tansu" "$root/etc/init.d/tansu.real"
ln -s tansu.real "$root/etc/init.d/tansu"
before=$(snapshot)
: > "$state/log"
if install_tansu rev3 "$work/stage-rev3"; then fail "a symlinked service file was accepted"; fi
after=$(snapshot)
[ "$before" = "$after" ] || fail "a failed preflight wrote to the target"
[ ! -e "$root/opt/tansu/releases/rev3" ] || fail "a failed preflight created rev3"
pass "preflight failure is inert"

printf 'deploy-check: all lifecycle checks passed\n'
