#!/bin/sh
set -eu

usage() {
  cat >&2 <<'EOF'
usage: deploy-state.sh read|mark|sync [options]

  --state FILE       local receipt file (tests and local use)
  --host HOST        SSH target; reads and writes under --root
  --root DIR         remote filesystem root (default /)
  --statsctl PATH    statsctl executable (default statsctl)
  --token-file FILE  service credential JSON from `statsctl service create`
  --origin URL       Stats origin
  --service NAME     service name (default tansu)
  --version V        marker version (mark only; default the receipt revision)
  --message TEXT     marker message (default "tansu deploy V")
EOF
  exit 2
}

mode=${1:-}
[ "$#" -gt 0 ] && shift

state_file=
host=
root=/
statsctl=statsctl
token_file=
origin=
service=tansu
version=
message=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --state) state_file=${2:?--state needs a path}; shift 2 ;;
    --host) host=${2:?--host needs an SSH target}; shift 2 ;;
    --root) root=${2:?--root needs a path}; shift 2 ;;
    --statsctl) statsctl=${2:?--statsctl needs a path}; shift 2 ;;
    --token-file) token_file=${2:?--token-file needs a path}; shift 2 ;;
    --origin) origin=${2:?--origin needs a URL}; shift 2 ;;
    --service) service=${2:?--service needs a name}; shift 2 ;;
    --version) version=${2:?--version needs a value}; shift 2 ;;
    --message) message=${2:?--message needs text}; shift 2 ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

case "$mode" in
  read|mark|sync) ;;
  *) usage ;;
esac

case "$root" in
  /*) ;;
  *) printf 'deploy-state: --root must be absolute\n' >&2; exit 2 ;;
esac
case "$root" in
  *[!A-Za-z0-9/._-]*) printf 'deploy-state: invalid --root: %s\n' "$root" >&2; exit 2 ;;
esac
root=${root%/}

if [ -n "$state_file" ]; then
  [ -z "$host" ] || { printf 'deploy-state: --state and --host are mutually exclusive\n' >&2; exit 2; }
  local_state=1
  state_path=$state_file
else
  [ -n "$host" ] || { printf 'deploy-state: --state or --host is required\n' >&2; exit 2; }
  local_state=0
  state_path="${root}/var/lib/tansu/deploy/deploy-state.json"
fi

ssh_opts=${SSH_OPTS:--o BatchMode=yes -o ConnectTimeout=10}

read_state() {
  if [ "$local_state" -eq 1 ]; then
    cat "$state_path"
  else
    # shellcheck disable=SC2086
    ssh $ssh_opts -- "$host" "doas -n cat '$state_path'"
  fi
}

write_state() {
  if [ "$local_state" -eq 1 ]; then
    umask 077
    printf '%s\n' "$1" > "$state_path.new"
    mv -f "$state_path.new" "$state_path"
  else
    printf '%s\n' "$1" | ssh $ssh_opts -- "$host" "doas -n sh -c 'umask 077; cat > \"$state_path.new\"'"
    # shellcheck disable=SC2086
    ssh $ssh_opts -- "$host" "doas -n sh -c 'chown tansu:tansu \"$state_path.new\"; chmod 0600 \"$state_path.new\"; mv -f \"$state_path.new\" \"$state_path\"'"
  fi
}

state_field() {
  printf '%s' "$1" | jaq -r --arg field "$2" '(.marker // {}) as $m | {revision: (.revision // ""), marker_id: ($m.id // ""), marker_version: ($m.version // ""), marker_status: ($m.status // ""), attemptedAtMs: ($m.attemptedAtMs // 0)}[$field]'
}

set_marker() {
  status=$1
  id=$2
  marker_version=$3
  attempted=$4
  recorded=$5
  state_json=$(printf '%s' "$state_json" | jaq -c --arg status "$status" --arg id "$id" --arg version "$marker_version" --argjson attempted "$attempted" --arg recorded "$recorded" \
    '.marker = ({id: $id, version: $version, status: $status, attemptedAtMs: $attempted} + (if $recorded == "" then {} else {recordedAtMs: ($recorded | tonumber)} end))')
  write_state "$state_json"
}

publish() {
  id=$1
  marker_version=$2
  marker_message=${message:-"tansu deploy $marker_version"}
  "$statsctl" deploy mark \
    --service "$service" \
    --version "$marker_version" \
    --marker-id "$id" \
    --message "$marker_message" \
    --token-file "$token_file" \
    --origin "$origin" >/dev/null
}

require_marker_settings() {
  [ -n "$token_file" ] || { printf 'deploy-state: --token-file is required\n' >&2; exit 2; }
  [ -n "$origin" ] || { printf 'deploy-state: --origin is required\n' >&2; exit 2; }
  [ -n "$statsctl" ] || { printf 'deploy-state: --statsctl is required\n' >&2; exit 2; }
}

now_ms() {
  printf '%s\n' "$(( $(date +%s) * 1000 ))"
}

state_json=$(read_state)

case "$mode" in
  read)
    printf '%s\n' "$state_json"
    ;;
  mark)
    require_marker_settings
    version=${version:-$(state_field "$state_json" revision)}
    [ -n "$version" ] || { printf 'deploy-state: the receipt has no revision\n' >&2; exit 1; }
    marker_status=$(state_field "$state_json" marker_status)
    marker_version=$(state_field "$state_json" marker_version)
    marker_id=$(state_field "$state_json" marker_id)
    if [ "$marker_status" = "recorded" ] && [ "$marker_version" = "$version" ]; then
      printf 'marker: recorded %s for %s; no marker needed\n' "$marker_id" "$version"
      exit 0
    fi
    if [ "$marker_status" = "pending" ] && [ "$marker_version" = "$version" ] && [ -n "$marker_id" ]; then
      id=$marker_id
    else
      id="v-$version-$(now_ms)"
    fi
    attempted=$(now_ms)
    set_marker pending "$id" "$version" "$attempted" ""
    if publish "$id" "$version"; then
      set_marker recorded "$id" "$version" "$attempted" "$(now_ms)"
      printf 'marker: recorded %s for %s\n' "$id" "$version"
      exit 0
    fi
    printf 'marker: pending %s for %s; retry with sync or the next deploy\n' "$id" "$version" >&2
    exit 1
    ;;
  sync)
    require_marker_settings
    marker_status=$(state_field "$state_json" marker_status)
    marker_version=$(state_field "$state_json" marker_version)
    marker_id=$(state_field "$state_json" marker_id)
    attempted=$(state_field "$state_json" attemptedAtMs)
    if [ -z "$marker_status" ] || [ "$marker_status" = "recorded" ]; then
      printf 'marker: none pending\n'
      exit 0
    fi
    [ -n "$marker_id" ] && [ -n "$marker_version" ] || { printf 'deploy-state: pending marker is incomplete\n' >&2; exit 1; }
    if publish "$marker_id" "$marker_version"; then
      set_marker recorded "$marker_id" "$marker_version" "$attempted" "$(now_ms)"
      printf 'marker: recorded %s for %s\n' "$marker_id" "$marker_version"
      exit 0
    fi
    printf 'marker: pending %s for %s; retry later\n' "$marker_id" "$marker_version" >&2
    exit 1
    ;;
esac
