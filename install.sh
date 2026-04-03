#!/usr/bin/env bash
# install.sh — digitalhome.edge runtime setup
#
# Run as root (or with sudo) on a fresh Ubuntu 24.04 LTS server.
# Idempotent: safe to re-run after partial failures or upgrades.
#
# Usage:
#   sudo bash install.sh [--repo-url <git-url>]
#
# Options:
#   --repo-url   Git URL to clone the repo from (default: auto-detect from
#                the directory this script lives in, if already cloned)

set -euo pipefail

# ── helpers ───────────────────────────────────────────────────────────────────

log()  { echo "==> $*"; }
die()  { echo "ERROR: $*" >&2; exit 1; }

require_root() {
    [[ $EUID -eq 0 ]] || die "Run this script with sudo or as root."
}

# ── config ────────────────────────────────────────────────────────────────────

DHC_USER="dhc-svc"
DHC_HOME="/home/${DHC_USER}"
REPO_DIR="${DHC_HOME}/digitalhome-edge"
MCP_DIR="${DHC_HOME}/mcp-server"
DB_DIR="${REPO_DIR}/db"
VENV="${MCP_DIR}/venv"
NODE_RED_USER_DIR="${DHC_HOME}/.node-red"

REPO_URL=""

# parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo-url) REPO_URL="$2"; shift 2 ;;
        *) die "Unknown argument: $1" ;;
    esac
done

# if no --repo-url, detect from the script's own location
if [[ -z "$REPO_URL" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if git -C "$SCRIPT_DIR" remote get-url origin &>/dev/null; then
        REPO_URL="$(git -C "$SCRIPT_DIR" remote get-url origin)"
        log "Detected repo URL: ${REPO_URL}"
    else
        die "Cannot detect repo URL. Pass --repo-url <git-url>."
    fi
fi

# ── 1. system packages ────────────────────────────────────────────────────────

log "Installing system packages..."
apt-get update -qq
apt-get install -y --no-install-recommends \
    python3.12 python3.12-venv python3-pip \
    nodejs npm \
    git curl ufw

# ── 2. service account ────────────────────────────────────────────────────────

log "Creating service account ${DHC_USER}..."
if ! id "${DHC_USER}" &>/dev/null; then
    useradd --system --create-home --shell /usr/sbin/nologin "${DHC_USER}"
fi

# ── 3. Node-RED ───────────────────────────────────────────────────────────────

log "Installing Node-RED globally..."
npm install -g --silent node-red

log "Installing Node-RED palettes..."
mkdir -p "${NODE_RED_USER_DIR}"
# write package.json so npm install is idempotent
cat > "${NODE_RED_USER_DIR}/package.json" <<'EOF'
{
    "name": "node-red-project",
    "description": "A Node-RED Project",
    "version": "0.0.1",
    "private": true,
    "dependencies": {
        "node-red-contrib-ccu": "^3.4.2",
        "node-red-contrib-huemagic": "^4.2.2"
    }
}
EOF
(cd "${NODE_RED_USER_DIR}" && npm install --silent)
chown -R "${DHC_USER}:${DHC_USER}" "${NODE_RED_USER_DIR}"

# ── 4. clone / update repo ────────────────────────────────────────────────────

log "Setting up repo at ${REPO_DIR}..."
if [[ -d "${REPO_DIR}/.git" ]]; then
    sudo -u "${DHC_USER}" git -C "${REPO_DIR}" pull
else
    sudo -u "${DHC_USER}" git clone "${REPO_URL}" "${REPO_DIR}"
fi

# ── 5. MCP server ─────────────────────────────────────────────────────────────

log "Setting up MCP server Python venv..."
mkdir -p "${MCP_DIR}"

# copy server files from repo into the standalone mcp-server dir
# (the service WorkingDirectory is ${MCP_DIR}, not the repo)
cp "${REPO_DIR}/mcp-server/server.py"       "${MCP_DIR}/server.py"
cp "${REPO_DIR}/mcp-server/requirements.txt" "${MCP_DIR}/requirements.txt"

# create .env from example if it doesn't exist yet
if [[ ! -f "${MCP_DIR}/.env" ]]; then
    cp "${REPO_DIR}/mcp-server/.env.example" "${MCP_DIR}/.env"
    log "  Created ${MCP_DIR}/.env from example — edit it to set real values."
fi

python3.12 -m venv "${VENV}"
"${VENV}/bin/pip" install --quiet --upgrade pip
"${VENV}/bin/pip" install --quiet -r "${MCP_DIR}/requirements.txt"

chown -R "${DHC_USER}:${DHC_USER}" "${MCP_DIR}"

# ── 6. database directory ─────────────────────────────────────────────────────

log "Creating DB directory..."
mkdir -p "${DB_DIR}"
chown -R "${DHC_USER}:${DHC_USER}" "${DB_DIR}"
# schema.sql is already in the repo at db/schema.sql — the MCP server init
# reads it relative to server.py, so no copy needed here.

# ── 7. config cache ───────────────────────────────────────────────────────────

CONFIG_CACHE="${DHC_HOME}/digitalhome.edge.config.cache"
if [[ ! -f "${CONFIG_CACHE}" ]]; then
    log "Creating config cache from example..."
    cp "${REPO_DIR}/digitalhome.edge.config.cache.example" "${CONFIG_CACHE}"
    chown "${DHC_USER}:${DHC_USER}" "${CONFIG_CACHE}"
    log "  Edit ${CONFIG_CACHE} to set cloud.api_key and instance details."
else
    log "  Config cache already exists — skipping."
fi

# ── 8. systemd units ──────────────────────────────────────────────────────────

log "Installing systemd service units..."

cat > /etc/systemd/system/nodered.service <<EOF
[Unit]
Description=Node-RED
After=network.target

[Service]
Type=simple
User=${DHC_USER}
Group=${DHC_USER}
WorkingDirectory=${DHC_HOME}
Environment=HOME=${DHC_HOME}
ExecStart=/usr/bin/node-red --port 1880 --userDir ${NODE_RED_USER_DIR}
Restart=on-failure
RestartSec=10
KillSignal=SIGINT

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/mcp-server.service <<EOF
[Unit]
Description=digitalhome.edge MCP Server
After=network.target nodered.service

[Service]
Type=simple
User=${DHC_USER}
Group=${DHC_USER}
WorkingDirectory=${MCP_DIR}
EnvironmentFile=${MCP_DIR}/.env
ExecStart=${VENV}/bin/python server.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable nodered mcp-server
systemctl restart nodered mcp-server

# ── 9. firewall ───────────────────────────────────────────────────────────────

log "Configuring firewall (ufw)..."
ufw --force enable
ufw allow 22/tcp   comment 'SSH'
ufw allow 1880/tcp comment 'Node-RED'
ufw allow 8000/tcp comment 'MCP server'

# ── done ──────────────────────────────────────────────────────────────────────

log ""
log "Installation complete."
log ""
log "Next steps:"
log "  1. Edit ${CONFIG_CACHE}"
log "     - Set cloud.api_key"
log "     - Set instance.id and instance.name"
log "  2. Register Hue API key:"
log "     http://192.168.1.15/debug/clip.html"
log "  3. Install Node-RED Dashboard v2 in the Node-RED editor:"
log "     http://<server-ip>:1880  → Manage palette → @flowfuse/node-red-dashboard"
log "  4. Connect Claude to the MCP server:"
log "     http://<server-ip>:8000/sse"
log ""
log "Services:"
systemctl is-active --quiet nodered    && log "  nodered     running" || log "  nodered     FAILED"
systemctl is-active --quiet mcp-server && log "  mcp-server  running" || log "  mcp-server  FAILED"
