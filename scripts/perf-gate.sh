#!/bin/sh
set -u

results_dir=.work/tmp/bench-results
stamp=.work/tmp/perf-gate.stamp

defer () {
	>&2 printf 'perf gate deferred: host busy (%s)\n' "$1"
	exit 75
}

check () {
	"$@"
	status=$?
	case "$status" in
	0) ;;
	75) return 1 ;;
	*) >&2 printf 'perf-gate-ready failed with status %s\n' "$status"; exit "$status" ;;
	esac
}

case "${1:-}" in
before)
	check perf-gate-ready || defer 'not started'
	mkdir -p .work/tmp
	touch "$stamp"
	;;
after)
	[ -f "$stamp" ] || { >&2 printf 'perf-gate.sh after: no matching before\n'; exit 2; }
	if ! check perf-gate-ready -1; then
		[ -d "$results_dir" ] && find "$results_dir" -type f -newer "$stamp" -delete
		rm -f "$stamp"
		defer 'results discarded'
	fi
	rm -f "$stamp"
	;;
*)
	>&2 printf 'usage: perf-gate.sh before|after\n'
	exit 2
	;;
esac
