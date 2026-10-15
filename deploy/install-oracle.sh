set -euo pipefail

tailnet_dns_name=$1
stage=$2
origin="https://$tailnet_dns_name"
config_file=/var/lib/tansu2/config/tansu/config.toml
restart_server=0
restart_redirect=0
units_changed=0

[[ -s "$stage/tansu2" ]]
[[ -s "$stage/http-redirect.py" ]]
current_dns_name=$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
[[ "$current_dns_name" == "$tailnet_dns_name" ]]

for directory in /opt/tansu2 /var/lib/tansu2 /var/lib/tansu2/config /var/lib/tansu2/config/tansu /var/lib/tansu2/data /var/lib/tansu2/vault; do
  if [[ -L "$directory" || ( -e "$directory" && ! -d "$directory" ) ]]; then
    printf 'Tansu2 directory must be a real directory: %s\n' "$directory" >&2
    exit 1
  fi
done

if ! getent passwd tansu2 >/dev/null; then
  useradd --system --user-group --home-dir /var/lib/tansu2 --no-create-home --shell /usr/sbin/nologin tansu2
fi

install -d -o root -g tansu2 -m 0750 /opt/tansu2
install -d -o root -g tansu2 -m 0750 /var/lib/tansu2
install -d -o root -g tansu2 -m 0750 /var/lib/tansu2/config/tansu
install -d -o tansu2 -g tansu2 -m 0750 /var/lib/tansu2/data
install -d -o tansu2 -g tansu2 -m 0750 /var/lib/tansu2/vault

if [[ -L "$config_file" || ( -e "$config_file" && ! -f "$config_file" ) ]]; then
  printf 'Tansu2 config must be a regular file: %s\n' "$config_file" >&2
  exit 1
fi

if [[ ! -e "$config_file" ]]; then
  config_stage="$config_file.new"
  cat > "$config_stage" <<CONFIG
[[vaults]]
name = "Personal"
path = "/var/lib/tansu2/vault"

[auth]
mode = "authenticated"
external_origin = "$origin"
rp_id = "$tailnet_dns_name"
rp_name = "Tansu"
state_directory = "auth"
CONFIG
  chown root:tansu2 "$config_stage"
  chmod 0640 "$config_stage"
  mv -f "$config_stage" "$config_file"
  restart_server=1
fi

python3 - "$config_file" "$tailnet_dns_name" <<'CONFIG_CHECK'
import sys
import tomllib

with open(sys.argv[1], "rb") as config_file:
    config = tomllib.load(config_file)

auth = config.get("auth", {})
expected_origin = f"https://{sys.argv[2]}"
if auth.get("mode") != "authenticated" or auth.get("external_origin") != expected_origin or auth.get("rp_id") != sys.argv[2]:
    raise SystemExit("Tansu2 config must use authenticated mode with the current Oracle HTTPS origin and RP ID")
CONFIG_CHECK

chown root:tansu2 "$config_file"
chmod 0640 "$config_file"

if [[ -L /opt/tansu2/tansu2 || ( -e /opt/tansu2/tansu2 && ! -f /opt/tansu2/tansu2 ) ]]; then
  printf 'Tansu2 executable path must be a regular file: /opt/tansu2/tansu2\n' >&2
  exit 1
fi
if [[ ! -e /opt/tansu2/tansu2 ]] || ! cmp -s "$stage/tansu2" /opt/tansu2/tansu2; then
  install -o root -g root -m 0755 "$stage/tansu2" /opt/tansu2/.tansu2.new
  mv -f /opt/tansu2/.tansu2.new /opt/tansu2/tansu2
  restart_server=1
fi

if [[ -L /opt/tansu2/http-redirect.py || ( -e /opt/tansu2/http-redirect.py && ! -f /opt/tansu2/http-redirect.py ) ]]; then
  printf 'Redirect script path must be a regular file: /opt/tansu2/http-redirect.py\n' >&2
  exit 1
fi
if [[ ! -e /opt/tansu2/http-redirect.py ]] || ! cmp -s "$stage/http-redirect.py" /opt/tansu2/http-redirect.py; then
  install -o root -g root -m 0644 "$stage/http-redirect.py" /opt/tansu2/.http-redirect.new
  mv -f /opt/tansu2/.http-redirect.new /opt/tansu2/http-redirect.py
  restart_redirect=1
fi

server_unit=/etc/systemd/system/tansu2.service
server_unit_stage="$server_unit.new"
cat > "$server_unit_stage" <<'SERVER_UNIT'
[Unit]
Description=Tansu2 note server
After=network.target

[Service]
Type=simple
User=tansu2
Group=tansu2
WorkingDirectory=/var/lib/tansu2
Environment=HOME=/var/lib/tansu2
Environment=XDG_CONFIG_HOME=/var/lib/tansu2/config
Environment=XDG_DATA_HOME=/var/lib/tansu2/data
ExecStart=/opt/tansu2/tansu2 --port 3001
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/tansu2

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

redirect_unit=/etc/systemd/system/tansu2-http-redirect.service
redirect_unit_stage="$redirect_unit.new"
cat > "$redirect_unit_stage" <<REDIRECT_UNIT
[Unit]
Description=Tansu2 HTTP to HTTPS redirect
After=network.target

[Service]
Type=simple
User=tansu2
Group=tansu2
WorkingDirectory=/var/lib/tansu2
Environment=HOME=/var/lib/tansu2
Environment=PYTHONDONTWRITEBYTECODE=1
Environment=TANSU2_REDIRECT_ORIGIN=$origin
ExecStart=/usr/bin/python3 /opt/tansu2/http-redirect.py
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

systemctl enable tansu2.service tansu2-http-redirect.service >/dev/null
if systemctl is-active --quiet tansu2.service; then
  if (( restart_server )); then systemctl restart tansu2.service; fi
else
  systemctl start tansu2.service
fi
if systemctl is-active --quiet tansu2-http-redirect.service; then
  if (( restart_redirect )); then systemctl restart tansu2-http-redirect.service; fi
else
  systemctl start tansu2-http-redirect.service
fi

tailscale serve --yes --bg --https=443 3001
tailscale serve --yes --bg --http=3000 3002
tailscale serve status
printf 'Tansu2 deployed at %s\n' "$origin"
printf 'HTTP entry point: http://oracle:3000\n'
