#!/bin/sh
set -eu

prefix="${1:-/opt/tansu-sqlite}"
work_dir="${SQLITE_BUILD_DIR:-.work/tmp/tansu-sqlite-build}"
version="${SQLITE_VERSION:-3.54.0}"
autoconf="${SQLITE_AUTOCONF:-3540000}"
sha3="${SQLITE_SHA3_256:-f5e3e724e9c9b3b5d512c76b02082091a59eeea9becd169a9fbf4d376403acce}"
year="${SQLITE_RELEASE_YEAR:-2026}"
cc="${CC:-clang}"
ar="${AR:-ar}"
url="${SQLITE_URL:-https://www.sqlite.org/${year}/sqlite-autoconf-${autoconf}.tar.gz}"
archive="${work_dir}/sqlite-autoconf-${autoconf}.tar.gz"
src_dir="${work_dir}/sqlite-autoconf-${autoconf}"
tmp_archive=

cleanup() {
  if [ -n "$tmp_archive" ]; then
    rm -f "$tmp_archive"
  fi
}

sha3_file() {
  if openssl list -digest-commands 2>/dev/null | grep -Eq '(^|[[:space:]])sha3-256($|[[:space:]])'; then
    openssl dgst -sha3-256 "$1" | awk '{print $NF}'
  else
    python3 -c 'import hashlib, pathlib, sys; print(hashlib.sha3_256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())' "$1"
  fi
}

trap cleanup 0
trap 'exit 1' HUP INT TERM

mkdir -p "$work_dir" "$prefix/include" "$prefix/lib"

if [ -L "$archive" ]; then
  echo "sqlite archive cache path is a symlink: $archive" >&2
  exit 1
fi

if [ -d "$archive" ]; then
  echo "sqlite archive cache path is a directory: $archive" >&2
  exit 1
fi

cached=0
if [ -f "$archive" ]; then
  actual="$(sha3_file "$archive")"
  if [ "$actual" = "$sha3" ]; then
    cached=1
  fi
fi

if [ "$cached" -eq 0 ]; then
  tmp_archive="$(mktemp "${archive}.tmp.XXXXXX")"
  curl -fsSL "$url" -o "$tmp_archive"
  actual="$(sha3_file "$tmp_archive")"
  if [ "$actual" != "$sha3" ]; then
    echo "sqlite archive SHA3-256 mismatch for $tmp_archive" >&2
    echo "expected: $sha3" >&2
    echo "actual:   $actual" >&2
    exit 1
  fi
  mv -f "$tmp_archive" "$archive"
  tmp_archive=
fi

rm -rf "$src_dir"
tar -xzf "$archive" -C "$work_dir"

"$cc" \
  -O2 \
  -std=c11 \
  -DNDEBUG \
  -DSQLITE_THREADSAFE=1 \
  -DSQLITE_DEFAULT_FOREIGN_KEYS=1 \
  -DSQLITE_DQS=0 \
  -DSQLITE_ENABLE_API_ARMOR \
  -DHAVE_USLEEP=1 \
  -DHAVE_ISNAN=1 \
  -DSQLITE_OMIT_AUTHORIZATION \
  -DSQLITE_OMIT_COMPLETE \
  -DSQLITE_OMIT_COMPILEOPTION_DIAGS \
  -DSQLITE_OMIT_DECLTYPE \
  -DSQLITE_OMIT_DEPRECATED \
  -DSQLITE_OMIT_DESERIALIZE \
  -DSQLITE_OMIT_EXPLAIN \
  -DSQLITE_OMIT_GET_TABLE \
  -DSQLITE_OMIT_JSON \
  -DSQLITE_OMIT_LOAD_EXTENSION \
  -DSQLITE_OMIT_PROGRESS_CALLBACK \
  -DSQLITE_OMIT_TCL_VARIABLE \
  -DSQLITE_OMIT_TRACE \
  -DSQLITE_OMIT_UTF16 \
  -c "$src_dir/sqlite3.c" \
  -o "$work_dir/sqlite3.o"

"$ar" crs "$prefix/lib/libsqlite3.a" "$work_dir/sqlite3.o"
cp "$src_dir/sqlite3.h" "$src_dir/sqlite3ext.h" "$prefix/include/"
printf '%s\n' "$version" > "$prefix/VERSION"
