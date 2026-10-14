#!/bin/sh
set -eu

prefix="${1:-/opt/tansu-sqlite}"
work_dir="${SQLITE_BUILD_DIR:-.work/tmp/tansu-sqlite-build}"
version="${SQLITE_VERSION:-3.54.0}"
autoconf="${SQLITE_AUTOCONF:-3540000}"
sha3="${SQLITE_SHA3_256:-f5e3e724e9c9b3b5d512c76b02082091a59eeea9becd169a9fbf4d376403acce}"
year="${SQLITE_RELEASE_YEAR:-2026}"
cc="${CC:-clang}"
ar="${AR:-llvm-ar}"
url="${SQLITE_URL:-https://www.sqlite.org/${year}/sqlite-autoconf-${autoconf}.tar.gz}"
archive="${work_dir}/sqlite-autoconf-${autoconf}.tar.gz"
src_dir="${work_dir}/sqlite-autoconf-${autoconf}"

mkdir -p "$work_dir" "$prefix/include" "$prefix/lib"

if [ ! -f "$archive" ]; then
  curl -fsSL "$url" -o "$archive"
fi

if openssl list -digest-commands 2>/dev/null | grep -Eq '(^|[[:space:]])sha3-256($|[[:space:]])'; then
  actual="$(openssl dgst -sha3-256 "$archive" | awk '{print $NF}')"
else
  actual="$(python3 -c 'import hashlib, pathlib, sys; print(hashlib.sha3_256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())' "$archive")"
fi
if [ "$actual" != "$sha3" ]; then
  echo "sqlite archive SHA3-256 mismatch for $archive" >&2
  echo "expected: $sha3" >&2
  echo "actual:   $actual" >&2
  exit 1
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
  -DSQLITE_OMIT_INTEGRITY_CHECK \
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
