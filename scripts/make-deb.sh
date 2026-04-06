#!/bin/bash
# Assembles a .deb from the already-built release binary.
# Called by `make release` — do not run directly.
set -euo pipefail

TARGET=${TARGET:-x86_64-unknown-linux-gnu}
ARCH=${ARCH:-amd64}
VERSION=$(grep '^version = ' Cargo.toml | cut -d'"' -f2)
DEB_NAME="tansu_${VERSION}_${ARCH}"
DEB_ROOT="target/${DEB_NAME}"

rm -rf "$DEB_ROOT"
mkdir -p "$DEB_ROOT/DEBIAN"
mkdir -p "$DEB_ROOT/usr/local/bin"
mkdir -p "$DEB_ROOT/usr/lib/systemd/system"
mkdir -p "$DEB_ROOT/var/lib/tansu/notes"

install -m755 "target/${TARGET}/release/tansu" "$DEB_ROOT/usr/local/bin/tansu"
install -m644 tansu.service "$DEB_ROOT/usr/lib/systemd/system/tansu.service"

cat > "$DEB_ROOT/DEBIAN/control" <<EOF
Package: tansu
Version: ${VERSION}
Architecture: ${ARCH}
Maintainer: Joshua Li
Description: Tansu note server
EOF

cat > "$DEB_ROOT/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
mkdir -p /var/lib/tansu/notes
systemctl daemon-reload
systemctl enable tansu
systemctl start tansu
EOF
chmod 755 "$DEB_ROOT/DEBIAN/postinst"

cat > "$DEB_ROOT/DEBIAN/prerm" <<'EOF'
#!/bin/sh
set -e
systemctl stop tansu || true
systemctl disable tansu || true
EOF
chmod 755 "$DEB_ROOT/DEBIAN/prerm"

dpkg-deb --root-owner-group --build "$DEB_ROOT" "target/${DEB_NAME}.deb"
echo "→ target/${DEB_NAME}.deb"
