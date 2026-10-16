#!/bin/sh
set -eu

bin="${1:?usage: auth-recovery-drill.sh PATH_TO_TANSU2_BINARY}"
drill_dir="${AUTH_RECOVERY_DRILL_DIR:-.work/tmp/auth-recovery-drill}"

case "$bin" in
  /*) ;;
  *) bin="$PWD/$bin" ;;
esac

if [ ! -x "$bin" ]; then
  echo "not an executable: $bin" >&2
  exit 1
fi

rm -rf "$drill_dir"
mkdir -p "$drill_dir/vault" "$drill_dir/config" "$drill_dir/data" "$drill_dir/backups"
drill_dir="$(cd "$drill_dir" && pwd)"

export XDG_CONFIG_HOME="$drill_dir/config"
export XDG_DATA_HOME="$drill_dir/data"
export HOME="$drill_dir"

tansu() {
  "$bin" "$@"
}

tansu config init --vault drill "$drill_dir/vault" --auth https://notes.example.com example.com Tansu
tansu auth enroll >/dev/null
tansu auth backup "$drill_dir/backups/first.db"
test -s "$drill_dir/backups/first.db"
tansu auth restore "$drill_dir/backups/first.db"
tansu auth backup "$drill_dir/backups/second.db"
test -s "$drill_dir/backups/second.db"

head -c 4096 /dev/urandom > "$drill_dir/backups/corrupt.db"
if tansu auth restore "$drill_dir/backups/corrupt.db" 2>/dev/null; then
  echo "restore accepted a corrupt backup" >&2
  exit 1
fi

tansu auth restore "$drill_dir/backups/second.db"
echo "auth recovery drill passed: $bin"
