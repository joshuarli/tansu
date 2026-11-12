#!/usr/bin/env bash
set -euo pipefail

src=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work="$src/.work/tmp/tansu-recovery-check"
rm -rf "$work"
mkdir -p "$work/bin" "$work/state"
trap 'rm -rf "$work"' EXIT

cat > "$work/bin/ssh" <<'EOF'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$TANSU_RECOVERY_STATE/ssh-args"
stdin=$(cat || true)
case "$*" in
  *"--rollback "*)
    printf 'rollback\n' >> "$TANSU_RECOVERY_STATE/events"
    if [ "$ROLLBACK_STATUS" -ne 0 ]; then
      exit "$ROLLBACK_STATUS"
    fi
    printf 'releases/%s\n' "$PREVIOUS" > "$TANSU_RECOVERY_STATE/current"
    exit 0
    ;;
  *"--revision "*)
    printf 'install\n' >> "$TANSU_RECOVERY_STATE/events"
    if [ "$SWITCH_ON_INSTALL" = 1 ]; then
      printf 'releases/%s\n' "$FAKE_REV" > "$TANSU_RECOVERY_STATE/current"
    fi
    exit "$INSTALL_STATUS"
    ;;
  *"readlink /opt/tansu/current"*)
    cat "$TANSU_RECOVERY_STATE/current"
    exit 0
    ;;
  *"test -f /var/lib/tansu/deploy/deploy-state.json"*)
    if [ "$STATE_EXISTS" = 1 ]; then
      exit 0
    fi
    exit 1
    ;;
esac
case "$stdin" in
  *"api/v2/health"*)
    rev=$(printf '%s\n' "$*" | sed -n "s/.*-- '\\([^']*\\)'.*/\\1/p")
    printf 'readiness %s\n' "$rev" >> "$TANSU_RECOVERY_STATE/events"
    if [ "$rev" = "$PREVIOUS" ]; then
      exit "$PREVIOUS_READY"
    fi
    exit "$CANDIDATE_READY"
    ;;
  *"command -v tailscale"*)
    printf 'x86_64 host.tail1234.ts.net\n'
    exit 0
    ;;
  *"deploy-state.json"*)
    printf '%s\n' "$PREVIOUS"
    exit 0
    ;;
  *"rm -rf"*)
    exit 0
    ;;
esac
case "$*" in
  *"mktemp -d"*)
    printf '/home/user/.cache/tansu/deploy.ABCDEF\n'
    exit 0
    ;;
  *"mkdir -p"*)
    exit 0
    ;;
esac
printf 'unmocked ssh: %s\n' "$*" >&2
exit 99
EOF

cat > "$work/bin/scp" <<'EOF'
#!/bin/sh
exit 0
EOF

cat > "$work/bin/sleep" <<'EOF'
#!/bin/sh
exit 0
EOF

cat > "$work/bin/git" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "-C" ] && [ "${3:-}" = "rev-parse" ]; then
  printf '%s\n' "$FAKE_REV"
  exit 0
fi
printf 'unmocked git: %s\n' "$*" >&2
exit 99
EOF

cat > "$work/bin/make" <<'EOF'
#!/bin/sh
dir=
while [ $# -gt 0 ]; do
  if [ "$1" = "-C" ]; then
    dir=$2
    shift 2
    continue
  fi
  shift
done
mkdir -p "$dir/.work/dist/x86_64-unknown-linux-musl"
printf 'x\n' > "$dir/.work/dist/x86_64-unknown-linux-musl/tansu"
EOF

chmod +x "$work/bin/ssh" "$work/bin/scp" "$work/bin/sleep" "$work/bin/git" "$work/bin/make"

fail() {
  printf 'recovery-check: FAIL: %s\n' "$*" >&2
  exit 1
}

pass() {
  printf 'recovery-check: ok: %s\n' "$*"
}

count_events() {
  local pattern=$1
  if [ ! -f "$work/state/events" ]; then
    printf '0'
    return
  fi
  grep -c -F -x "$pattern" "$work/state/events" || true
}

run_deploy() {
  local status=0
  : > "$work/state/ssh-args"
  : > "$work/state/events"
  printf 'releases/%s\n' "$PREVIOUS" > "$work/state/current"
  output=$(
    DEPLOY_HOST=user@host \
    PATH="$work/bin:$PATH" \
    TANSU_RECOVERY_STATE="$work/state" \
    FAKE_REV="$FAKE_REV" \
    PREVIOUS="$PREVIOUS" \
    INSTALL_STATUS="$INSTALL_STATUS" \
    SWITCH_ON_INSTALL="$SWITCH_ON_INSTALL" \
    ROLLBACK_STATUS="$ROLLBACK_STATUS" \
    STATE_EXISTS="$STATE_EXISTS" \
    CANDIDATE_READY="$CANDIDATE_READY" \
    PREVIOUS_READY="$PREVIOUS_READY" \
    "$BASH" "$src/deploy/deploy.sh" </dev/null 2>&1
  ) || status=$?
  printf '%s\n' "$output" > "$work/state/output"
  printf '%s' "$status" > "$work/state/exit"
}

expect_exit() {
  local want=$1
  local got
  got=$(cat "$work/state/exit")
  [ "$got" = "$want" ] || fail "$2: exit $got, want $want; output: $(cat "$work/state/output")"
}

expect_output() {
  grep -F -q -- "$1" "$work/state/output" || fail "$2: missing [$1]; output: $(cat "$work/state/output")"
}

expect_absent() {
  if grep -F -q -- "$1" "$work/state/output"; then
    fail "$2: unexpected [$1]; output: $(cat "$work/state/output")"
  fi
}

FAKE_REV=rev-next
PREVIOUS=rev-prev

INSTALL_STATUS=0
SWITCH_ON_INSTALL=1
ROLLBACK_STATUS=0
STATE_EXISTS=1
CANDIDATE_READY=0
PREVIOUS_READY=0
run_deploy
expect_exit 0 "healthy install"
[ "$(count_events rollback)" = 0 ] || fail "healthy install rolled back"
[ "$(count_events "readiness $FAKE_REV")" -ge 1 ] || fail "healthy install skipped readiness"
pass "healthy install leaves the new release selected"

INSTALL_STATUS=0
SWITCH_ON_INSTALL=1
CANDIDATE_READY=1
PREVIOUS_READY=0
run_deploy
expect_exit 1 "failed readiness"
expect_output "release $FAKE_REV did not become ready" "failed readiness"
expect_output "rolling back to $PREVIOUS" "failed readiness"
[ "$(count_events rollback)" = 1 ] || fail "failed readiness did not roll back"
[ "$(count_events "readiness $PREVIOUS")" -ge 1 ] || fail "failed readiness skipped restored readiness"
pass "failed readiness rolls back to the prior release"

INSTALL_STATUS=71
SWITCH_ON_INSTALL=1
CANDIDATE_READY=1
PREVIOUS_READY=0
run_deploy
expect_exit 71 "installer failure after switch"
expect_output "installer failed for release $FAKE_REV (status 71)" "installer failure after switch"
expect_output "rolling back to $PREVIOUS" "installer failure after switch"
[ "$(count_events rollback)" = 1 ] || fail "installer failure after switch did not roll back"
[ "$(count_events "readiness $FAKE_REV")" = 0 ] || fail "installer failure waited on the failed release"
[ "$(count_events "readiness $PREVIOUS")" -ge 1 ] || fail "installer failure skipped restored readiness"
[ "$(cat "$work/state/current")" = "releases/$PREVIOUS" ] || fail "installer failure left $(cat "$work/state/current")"
pass "installer failure after switching restores the prior release"

INSTALL_STATUS=71
SWITCH_ON_INSTALL=0
run_deploy
expect_exit 71 "installer failure before switch"
expect_absent "rolling back" "installer failure before switch"
[ "$(count_events rollback)" = 0 ] || fail "installer failure before switch rolled back"
[ "$(cat "$work/state/current")" = "releases/$PREVIOUS" ] || fail "installer failure before switch moved current"
pass "installer failure before switching keeps the prior release"

INSTALL_STATUS=71
SWITCH_ON_INSTALL=1
ROLLBACK_STATUS=9
run_deploy
expect_exit 71 "rollback command failure"
expect_output "rollback to $PREVIOUS failed (status 9)" "rollback command failure"
expect_absent "rollback release $PREVIOUS is not ready" "rollback command failure"
[ "$(count_events "readiness $PREVIOUS")" = 0 ] || fail "failed rollback still checked readiness"
pass "rollback command failure keeps the installer status"

ROLLBACK_STATUS=0
PREVIOUS_READY=1
run_deploy
expect_exit 71 "restored release not ready"
expect_output "rollback release $PREVIOUS is not ready" "restored release not ready"
expect_output "installer failed for release $FAKE_REV (status 71)" "restored release not ready"
pass "restored release that is not ready keeps the installer status"

STATE_EXISTS=0
PREVIOUS=
PREVIOUS_READY=0
SWITCH_ON_INSTALL=1
run_deploy
expect_exit 71 "no prior release"
expect_output "no prior release to restore" "no prior release"
[ "$(count_events rollback)" = 0 ] || fail "first install rolled back"
pass "installer failure with no prior release keeps the installer status"
