#!/usr/bin/env bash
# Install the door station adapter on a Raspberry Pi (Raspberry Pi OS 12 / Debian 12), as root:
#   sudo bash install.sh
# It asks for the door code's link (shown once in the edge portal) without echoing it, so the
# secret stays out of the shell history and the process list.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root: sudo bash install.sh" >&2; exit 1; }
here="$(cd "$(dirname "$0")" && pwd)"

apt-get update -qq
apt-get install -y -qq nodejs npm ffmpeg gpiod alsa-utils espeak-ng >/dev/null
node -e 'process.exit(parseInt(process.versions.node) >= 18 ? 0 : 1)' || { echo "Node 18 or newer is needed" >&2; exit 1; }

id dhc-door >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin dhc-door
for g in video audio gpio; do getent group "$g" >/dev/null && usermod -aG "$g" dhc-door; done

install -d -m 0755 /opt/dhc-door
cp "$here"/index.js "$here"/package.json "$here"/package-lock.json "$here"/make-clips.sh /opt/dhc-door/
[ -d "$here/clips" ] && cp -r "$here/clips" /opt/dhc-door/
(cd /opt/dhc-door && npm ci --omit=dev --no-audit --no-fund >/dev/null && bash make-clips.sh)

install -d -m 0750 -o root -g dhc-door /etc/dhc-door
if [ ! -s /etc/dhc-door/config.json ]; then
  read -rsp "The door code's link from the edge portal (input hidden): " link; echo
  case "$link" in http://*"#c=p"*) ;; *) echo "that is not a door code link" >&2; exit 1 ;; esac
  umask 027
  node -e 'require("fs").writeFileSync("/etc/dhc-door/config.json", JSON.stringify({ link: process.argv[1] }, null, 2) + "\n")' "$link"
  chown root:dhc-door /etc/dhc-door/config.json; chmod 0640 /etc/dhc-door/config.json
fi

install -m 0644 "$here/dhc-door.service" /etc/systemd/system/dhc-door.service
systemctl daemon-reload
systemctl enable --now dhc-door.service
sleep 3
systemctl --no-pager --lines=8 status dhc-door.service || true
echo
echo "Test the chain without the button:  sudo systemctl kill -s USR2 dhc-door"
