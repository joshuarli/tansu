set -euo pipefail

tailnet_dns_name=$1
stage=$2
origin="https://$tailnet_dns_name"
settings_database=/var/lib/tansu/config/tansu/settings.sqlite3
restart_server=0
restart_redirect=0
units_changed=0

[[ -s "$stage/tansu" ]]
[[ -s "$stage/http-redirect.py" ]]
current_dns_name=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
[[ "$current_dns_name" == "$tailnet_dns_name" ]]

for directory in /opt/tansu /var/lib/tansu /var/lib/tansu/config /var/lib/tansu/config/tansu /var/lib/tansu/data /var/lib/tansu/vault; do
  if [[ -L "$directory" || ( -e "$directory" && ! -d "$directory" ) ]]; then
    printf 'Tansu directory must be a real directory: %s\n' "$directory" >&2
    exit 1
  fi
done

if ! getent passwd tansu >/dev/null; then
  useradd --system --user-group --home-dir /var/lib/tansu --no-create-home --shell /usr/sbin/nologin tansu
fi

install -d -o root -g tansu -m 0750 /opt/tansu
install -d -o root -g tansu -m 0750 /var/lib/tansu
install -d -o tansu -g tansu -m 0750 /var/lib/tansu/config/tansu
install -d -o tansu -g tansu -m 0750 /var/lib/tansu/data
install -d -o tansu -g tansu -m 0750 /var/lib/tansu/vault

if [[ -L "$settings_database" || ( -e "$settings_database" && ! -f "$settings_database" ) ]]; then
  printf 'Tansu settings database must be a regular file: %s\n' "$settings_database" >&2
  exit 1
fi

if [[ ! -e "$settings_database" ]]; then
  runuser -u tansu -- env \
    HOME=/var/lib/tansu \
    XDG_CONFIG_HOME=/var/lib/tansu/config \
    XDG_DATA_HOME=/var/lib/tansu/data \
    "$stage/tansu" config init \
    --vault Personal /var/lib/tansu/vault \
    --auth "$origin" "$tailnet_dns_name" Tansu
  restart_server=1
fi

python3 - "$settings_database" "$tailnet_dns_name" <<'CONFIG_CHECK'
import json
import sqlite3
import sys

with sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True) as database:
    row = database.execute("SELECT value FROM settings WHERE key='app'").fetchone()
if row is None:
    raise SystemExit("Tansu app settings are not initialized")
config = json.loads(row[0])

auth = config.get("auth", {})
expected_origin = f"https://{sys.argv[2]}"
if auth.get("externalOrigin") != expected_origin or auth.get("rpId") != sys.argv[2]:
    raise SystemExit("Tansu config must use authenticated mode with the current Oracle HTTPS origin and RP ID")
CONFIG_CHECK

chown tansu:tansu "$settings_database"
chmod 0640 "$settings_database"

if [[ -L /opt/tansu/tansu || ( -e /opt/tansu/tansu && ! -f /opt/tansu/tansu ) ]]; then
  printf 'Tansu executable path must be a regular file: /opt/tansu/tansu\n' >&2
  exit 1
fi
if [[ ! -e /opt/tansu/tansu ]] || ! cmp -s "$stage/tansu" /opt/tansu/tansu; then
  install -o root -g root -m 0755 "$stage/tansu" /opt/tansu/.tansu.new
  mv -f /opt/tansu/.tansu.new /opt/tansu/tansu
  restart_server=1
fi

if [[ -L /opt/tansu/http-redirect.py || ( -e /opt/tansu/http-redirect.py && ! -f /opt/tansu/http-redirect.py ) ]]; then
  printf 'Redirect script path must be a regular file: /opt/tansu/http-redirect.py\n' >&2
  exit 1
fi
if [[ ! -e /opt/tansu/http-redirect.py ]] || ! cmp -s "$stage/http-redirect.py" /opt/tansu/http-redirect.py; then
  install -o root -g root -m 0644 "$stage/http-redirect.py" /opt/tansu/.http-redirect.new
  mv -f /opt/tansu/.http-redirect.new /opt/tansu/http-redirect.py
  restart_redirect=1
fi

server_unit=/etc/systemd/system/tansu.service
server_unit_stage="$server_unit.new"
cat > "$server_unit_stage" <<'SERVER_UNIT'
[Unit]
Description=Tansu note server
After=network.target

[Service]
Type=simple
User=tansu
Group=tansu
WorkingDirectory=/var/lib/tansu
Environment=HOME=/var/lib/tansu
Environment=XDG_CONFIG_HOME=/var/lib/tansu/config
Environment=XDG_DATA_HOME=/var/lib/tansu/data
ExecStart=/opt/tansu/tansu --port 3001
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/tansu

[Install]
WantedBy=multi-user.target
SERVER_UNIT
chmod 0644 "$server_unit_stage"
if [[ ! -e "$server_unit" ]] || ! cmp -s "$server_unit_stage" "$server_unit"; then
  mv -f "$server_unit_stage" "$server_unit"
  units_changed=1
  restart_server=1
else
  rm -f "$server_unit_stage"
fi

redirect_unit=/etc/systemd/system/tansu-http-redirect.service
redirect_unit_stage="$redirect_unit.new"
cat > "$redirect_unit_stage" <<REDIRECT_UNIT
[Unit]
Description=Tansu HTTP to HTTPS redirect
After=network.target

[Service]
Type=simple
User=tansu
Group=tansu
WorkingDirectory=/var/lib/tansu
Environment=HOME=/var/lib/tansu
Environment=PYTHONDONTWRITEBYTECODE=1
Environment=TANSU_REDIRECT_ORIGIN=$origin
ExecStart=/usr/bin/python3 /opt/tansu/http-redirect.py
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
REDIRECT_UNIT
chmod 0644 "$redirect_unit_stage"
if [[ ! -e "$redirect_unit" ]] || ! cmp -s "$redirect_unit_stage" "$redirect_unit"; then
  mv -f "$redirect_unit_stage" "$redirect_unit"
  units_changed=1
  restart_redirect=1
else
  rm -f "$redirect_unit_stage"
fi

if (( units_changed )); then
  systemctl daemon-reload
fi

systemctl enable tansu.service tansu-http-redirect.service >/dev/null
if systemctl is-active --quiet tansu.service; then
  if (( restart_server )); then systemctl restart tansu.service; fi
else
  systemctl start tansu.service
fi
if systemctl is-active --quiet tansu-http-redirect.service; then
  if (( restart_redirect )); then systemctl restart tansu-http-redirect.service; fi
else
  systemctl start tansu-http-redirect.service
fi

tailscale serve --yes --bg --https=443 3001
tailscale serve --yes --bg --http=3000 3002
tailscale serve status
printf 'Tansu deployed at %s\n' "$origin"
printf 'HTTP entry point: http://oracle:3000\n'
