#!/usr/bin/env bash
# install.sh — digitalhome.edge runtime setup
#
# Run as root (or with sudo) on a fresh Ubuntu 24.04 LTS server.
# Idempotent: safe to re-run after partial failures or upgrades.
#
# Usage:
#   sudo bash install.sh [--repo-url <git-url>] [--mode prod|stage]
#
# Options:
#   --repo-url   Git URL to clone the repo from (default: auto-detect from
#                the directory this script lives in, if already cloned)
#   --mode       Installation mode: "prod" or "stage" (default: prompt)
#                prod  — services enabled and started automatically
#                stage — services installed but stopped and disabled by default

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
INSTALL_MODE=""

# parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo-url) REPO_URL="$2"; shift 2 ;;
        --mode)     INSTALL_MODE="$2"; shift 2 ;;
        *) die "Unknown argument: $1" ;;
    esac
done

# prompt for mode if not supplied
if [[ -z "$INSTALL_MODE" ]]; then
    echo ""
    echo "Select installation mode:"
    echo "  1) prod  — services enabled and started automatically"
    echo "  2) stage — services installed but stopped (use dhcedge to start)"
    echo ""
    read -rp "Enter 1 or 2 [default: 1]: " mode_choice
    case "${mode_choice:-1}" in
        1|prod)  INSTALL_MODE="prod"  ;;
        2|stage) INSTALL_MODE="stage" ;;
        *) die "Invalid choice: ${mode_choice}" ;;
    esac
fi

case "$INSTALL_MODE" in
    prod|stage) ;;
    *) die "Invalid mode '${INSTALL_MODE}'. Use 'prod' or 'stage'." ;;
esac

log "Installation mode: ${INSTALL_MODE}"

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
    nodejs \
    git curl ufw

# ── 2. service account ────────────────────────────────────────────────────────

log "Creating service account ${DHC_USER}..."
if ! id "${DHC_USER}" &>/dev/null; then
    useradd --system --create-home --shell /usr/sbin/nologin "${DHC_USER}"
fi
# ensure home is traversable so dhcedge can read .dhcedge-mode
chmod 755 "${DHC_HOME}"

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
    log "  Edit ${CONFIG_CACHE} to set cloud.api_key and instance details."
fi
chown "${DHC_USER}:${DHC_USER}" "${CONFIG_CACHE}"
chmod 600 "${CONFIG_CACHE}"

# ── 8. secrets: credential secret, MCP bearer token, Node-RED passwords ─────

# All secret material is generated idempotently: read the config cache, only
# generate + persist a value if the current one is empty. Plain-text passwords
# are needed for the MCP server (basic auth → Node-RED /api/*) and for the
# operator (Node-RED editor login) — they stay in the config cache which is
# now 0600. The bcrypt-hashed forms live in Node-RED's settings.js.

# Emit a helper that reads config → writes if empty → prints the value used.
# Args: <json.path.dotted> <generator command>
config_get_or_gen() {
    local path="$1"
    local gen_cmd="$2"
    python3 - "$path" "$gen_cmd" "${CONFIG_CACHE}" <<'PY'
import json, os, subprocess, sys
path_key, gen_cmd, config_path = sys.argv[1], sys.argv[2], sys.argv[3]
with open(config_path) as f:
    cfg = json.load(f)
# walk dotted path, seeding intermediate dicts
parts = path_key.split(".")
node = cfg
for p in parts[:-1]:
    node = node.setdefault(p, {})
current = node.get(parts[-1], "")
if not current:
    current = subprocess.check_output(["bash", "-c", gen_cmd], text=True).strip()
    node[parts[-1]] = current
    with open(config_path, "w") as f:
        json.dump(cfg, f, indent=2)
    os.chmod(config_path, 0o600)
print(current)
PY
}

log "Configuring Node-RED credential secret..."
CRED_SECRET="$(config_get_or_gen "nodered.credential_secret" "python3 -c 'import secrets; print(secrets.token_hex(32))'")"

log "Configuring MCP bearer auth token..."
MCP_AUTH_TOKEN="$(config_get_or_gen "mcp.auth_token" "python3 -c 'import secrets; print(secrets.token_hex(32))'")"

log "Configuring Node-RED admin password..."
NODERED_ADMIN_USER="$(config_get_or_gen "nodered.admin_user" "echo admin")"
NODERED_ADMIN_PW="$(config_get_or_gen "nodered.admin_password" "python3 -c 'import secrets; print(secrets.token_hex(24))'")"

log "Configuring Node-RED /api/* password (used by MCP server)..."
NODERED_HTTP_USER="$(config_get_or_gen "nodered.http_user" "echo dhcedge")"
NODERED_HTTP_PW="$(config_get_or_gen "nodered.http_password" "python3 -c 'import secrets; print(secrets.token_hex(24))'")"

chown "${DHC_USER}:${DHC_USER}" "${CONFIG_CACHE}"
chmod 600 "${CONFIG_CACHE}"

# ── 9. Node-RED Projects + auth configuration ───────────────────────────────

log "Configuring Node-RED settings.js..."
SETTINGS_JS="${NODE_RED_USER_DIR}/settings.js"

# Locate bcryptjs — Node-RED ships it, and we need it to hash the admin +
# httpNodeAuth passwords into settings.js. Fall back through common install
# paths so this works on npm-global and userDir-local installs.
BCRYPT_MODULE=""
for path in \
    "/usr/lib/node_modules/node-red/node_modules/bcryptjs" \
    "/usr/local/lib/node_modules/node-red/node_modules/bcryptjs" \
    "${NODE_RED_USER_DIR}/node_modules/bcryptjs"; do
    [[ -d "$path" ]] && BCRYPT_MODULE="$path" && break
done
[[ -n "$BCRYPT_MODULE" ]] || die "bcryptjs not found under Node-RED — palette install may have failed."

# hash_pw <plaintext> — echoes the bcrypt hash (Node-RED-compatible).
# The `<<< "$pw"` heredoc appends a newline, so trim before hashing —
# otherwise the stored hash is for `password\n` and basic-auth (which sends
# the plain password) will fail to match at Node-RED's checker.
hash_pw() {
    local pw="$1"
    node -e "
        const bcrypt = require('${BCRYPT_MODULE}');
        let data = '';
        process.stdin.on('data', c => data += c);
        process.stdin.on('end', () => {
            bcrypt.hash(data.replace(/\r?\n$/, ''), 8, (err, h) => {
                if (err) { console.error(err); process.exit(1); }
                process.stdout.write(h);
            });
        });
    " <<< "$pw"
}

if [[ -f "$SETTINGS_JS" ]]; then
    # enable Projects feature
    sed -i 's/enabled: false,/enabled: true,/' "$SETTINGS_JS"

    # set credentialSecret
    if grep -q '//credentialSecret:' "$SETTINGS_JS"; then
        sed -i "s|//credentialSecret: \"a-secret-key\",|credentialSecret: \"${CRED_SECRET}\",|" "$SETTINGS_JS"
    elif grep -q 'credentialSecret:' "$SETTINGS_JS"; then
        sed -i "s|credentialSecret: \"[^\"]*\",|credentialSecret: \"${CRED_SECRET}\",|" "$SETTINGS_JS"
    else
        # settings.js exists but no credentialSecret line — insert before module.exports closing
        sed -i "/module.exports/a\\    credentialSecret: \"${CRED_SECRET}\"," "$SETTINGS_JS"
    fi

    # adminAuth: idempotent — only inject if not already present. Skip
    # comment lines (Node-RED's default settings.js ships with a commented
    # `//adminAuth: {…}` example that would otherwise match).
    # Rotating requires the operator to delete the existing block first.
    if grep -qE '^[[:space:]]*adminAuth:' "$SETTINGS_JS"; then
        log "  adminAuth already present in settings.js — not touching."
    else
        ADMIN_PW_HASH="$(hash_pw "$NODERED_ADMIN_PW")"
        ADMIN_BLOCK="    adminAuth: {\n        type: \"credentials\",\n        users: [{ username: \"${NODERED_ADMIN_USER}\", password: \"${ADMIN_PW_HASH}\", permissions: \"*\" }]\n    },"
        # insert before the closing brace of module.exports = {...}
        awk -v block="$ADMIN_BLOCK" '
            /module\.exports[[:space:]]*=[[:space:]]*\{/ && !inserted { print; print block; inserted=1; next }
            { print }
        ' "$SETTINGS_JS" > "${SETTINGS_JS}.tmp" && mv "${SETTINGS_JS}.tmp" "$SETTINGS_JS"
        log "  adminAuth block inserted."
    fi

    # httpNodeAuth: idempotent — protects /api/* endpoints. MCP server uses
    # basic auth with the plaintext pair from the config cache. Same
    # comment-line filter as adminAuth.
    if grep -qE '^[[:space:]]*httpNodeAuth:' "$SETTINGS_JS"; then
        log "  httpNodeAuth already present in settings.js — not touching."
    else
        HTTP_PW_HASH="$(hash_pw "$NODERED_HTTP_PW")"
        HTTP_BLOCK="    httpNodeAuth: { user: \"${NODERED_HTTP_USER}\", pass: \"${HTTP_PW_HASH}\" },"
        awk -v block="$HTTP_BLOCK" '
            /^module\.exports/ {in_block=1}
            in_block && /^};?$/ && !inserted { print block; inserted=1 }
            { print }
        ' "$SETTINGS_JS" > "${SETTINGS_JS}.tmp" && mv "${SETTINGS_JS}.tmp" "$SETTINGS_JS"
        log "  httpNodeAuth block inserted."
    fi

    log "  Projects enabled, credential secret set, adminAuth + httpNodeAuth configured."
else
    log "  WARN: settings.js not found — Node-RED will generate it on first start."
    log "  Re-run install.sh after first start to configure Projects + auth."
fi

chown -R "${DHC_USER}:${DHC_USER}" "${NODE_RED_USER_DIR}"

# ── 10. systemd units ─────────────────────────────────────────────────────────

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

if [[ "$INSTALL_MODE" == "prod" ]]; then
    log "Prod mode: enabling and starting services..."
    systemctl enable nodered mcp-server
    systemctl restart nodered mcp-server
else
    log "Stage mode: services installed but NOT started."
    log "  Use 'dhcedge start' to bring them up when needed."
    systemctl disable nodered mcp-server 2>/dev/null || true
    systemctl stop nodered mcp-server 2>/dev/null || true
fi

# ── 11. dhcedge CLI utility ───────────────────────────────────────────────────

log "Installing dhcedge utility..."
SCRIPT_SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_SOURCE_DIR}/bin/dhcedge" ]]; then
    cp "${SCRIPT_SOURCE_DIR}/bin/dhcedge" /usr/local/bin/dhcedge
elif [[ -f "${REPO_DIR}/bin/dhcedge" ]]; then
    cp "${REPO_DIR}/bin/dhcedge" /usr/local/bin/dhcedge
else
    die "Cannot find bin/dhcedge in source or cloned repo."
fi
chmod +x /usr/local/bin/dhcedge

# persist the install mode so dhcedge can read it
echo "${INSTALL_MODE}" > "${DHC_HOME}/.dhcedge-mode"
chown "${DHC_USER}:${DHC_USER}" "${DHC_HOME}/.dhcedge-mode"
chmod 644 "${DHC_HOME}/.dhcedge-mode"

# ── 12. /etc/hosts DNS entries ────────────────────────────────────────────────

log "Updating /etc/hosts with device hostnames..."
/usr/local/bin/dhcedge update-hosts

# ── 13. firewall ─────────────────────────────────────────────────────────────

log "Configuring firewall (ufw)..."
ufw --force enable
ufw allow 22/tcp   comment 'SSH'
ufw allow 1880/tcp comment 'Node-RED'
ufw allow 8000/tcp comment 'MCP server'

# ── done ──────────────────────────────────────────────────────────────────────

log ""
log "Installation complete (mode: ${INSTALL_MODE})."
log ""
log "Next steps:"
log "  1. Edit ${CONFIG_CACHE}"
log "     - Set cloud.api_key"
log "     - Set instance.id and instance.name"
log "  2. Register Hue API key:"
log "     http://192.168.1.15/debug/clip.html"
log "  3. Install Node-RED Dashboard v2 in the Node-RED editor:"
log "     http://<server-ip>:1880  → Manage palette → @flowfuse/node-red-dashboard"
log "     (log in with the admin credentials below)"
log "  4. Create your first Node-RED project:"
log "     http://<server-ip>:1880 → Name it 'digitalhome-flows'"
log "  5. Connect Claude to the MCP server (Authorization header required):"
log "     url:     http://<server-ip>:8000/sse"
log "     header:  Authorization: Bearer ${MCP_AUTH_TOKEN}"
log ""
log "Credentials (also stored in ${CONFIG_CACHE}, mode 0600):"
log "  Node-RED editor login  ${NODERED_ADMIN_USER} / ${NODERED_ADMIN_PW}"
log "  Node-RED /api/* login  ${NODERED_HTTP_USER} / ${NODERED_HTTP_PW}"
log "  MCP bearer token       ${MCP_AUTH_TOKEN}"
log ""
log "Save these somewhere safe. Retrieve later with:"
log "  sudo dhcedge show-secrets"
log ""
if [[ "$INSTALL_MODE" == "stage" ]]; then
    log "Stage mode — services are DOWN. Use 'dhcedge start' to bring them up."
else
    log "Services:"
    systemctl is-active --quiet nodered    && log "  nodered     running" || log "  nodered     FAILED"
    systemctl is-active --quiet mcp-server && log "  mcp-server  running" || log "  mcp-server  FAILED"
fi
log ""
log "Use 'dhcedge status' to check service state at any time."
