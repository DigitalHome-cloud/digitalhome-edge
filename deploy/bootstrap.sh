#!/usr/bin/env bash
# bootstrap.sh — seed /opt/dhe/ so the Docker Compose stack can run.
#
# Idempotent. Re-run safely to add missing pieces without disturbing what's
# already generated. Companion to install.sh (the old imperative installer);
# eventually this becomes the Phase 6 Claude Code Skill's job.
#
# Usage:
#   sudo bash deploy/bootstrap.sh [--nodered-port N] [--mcp-port N] [--home-id X]
#
# Defaults are set for side-by-side operation with the existing systemd
# stack: nodered on :1881 (existing on :1880), MCP on :8443 (existing on
# :8000). Change with the flags above once cutting over.

set -euo pipefail

log()  { echo "==> $*"; }
die()  { echo "ERROR: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run with sudo."

DHE_ROOT="/opt/dhe"
NODERED_PORT=1881
MCP_PORT=8443
HOME_ID="DE-DEMO"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --nodered-port) NODERED_PORT="$2"; shift 2 ;;
        --mcp-port)     MCP_PORT="$2"; shift 2 ;;
        --home-id)      HOME_ID="$2"; shift 2 ;;
        *) die "Unknown argument: $1" ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

log "Bootstrapping ${DHE_ROOT} (nodered=${NODERED_PORT}, mcp=${MCP_PORT}, homeId=${HOME_ID})"

# ── 1. directory skeleton ────────────────────────────────────────────────────

mkdir -p "${DHE_ROOT}"/{config,secrets,node-red-data,cbox,cbox/mappings,cbox.history,cache,timeseries,timeseries/cbox,timeseries/unmapped,timeseries/raw,timeseries/raw/solarman,db,logs}
chmod 700 "${DHE_ROOT}/secrets"
chmod 700 "${DHE_ROOT}/config"
# node-red-data must be readable+writable by uid 1000 (the node-red user
# inside the base image). If the host doesn't have that uid, we bind-mount
# and let the container's own user own the files at runtime.
chown -R 1000:1000 "${DHE_ROOT}/node-red-data" 2>/dev/null || true

# ── 2. copy repo assets in place ─────────────────────────────────────────────

cp "${SCRIPT_DIR}/docker-compose.yml" "${DHE_ROOT}/docker-compose.yml"
cat > "${DHE_ROOT}/.env" <<EOF
HOME_ID=${HOME_ID}
DHE_NODERED_PORT=${NODERED_PORT}
DHE_MCP_PORT=${MCP_PORT}
EOF
chmod 640 "${DHE_ROOT}/.env"

install -m 644 "${SCRIPT_DIR}/dhe.service" /etc/systemd/system/dhe.service

# Seed the starter A-Box vocabulary if the operator hasn't put one there.
# The A-Box is the shared REC+Brick vocabulary the data-pipeline filter maps
# incoming device fields against. Data, not code — edit /opt/dhe/cbox/abox.jsonld
# to add capabilities without a container rebuild.
if [[ -f "${SCRIPT_DIR}/cbox/abox.jsonld" && ! -f "${DHE_ROOT}/cbox/abox.jsonld" ]]; then
    install -m 644 "${SCRIPT_DIR}/cbox/abox.jsonld" "${DHE_ROOT}/cbox/abox.jsonld"
    log "  seeded cbox/abox.jsonld from repo starter"
fi

# Seed the source→T-BOX mapping files (mappings-manifest.json + *.map.json +
# extensions.ttl). The data pipeline builds global.aboxIndex from these; edit
# /opt/dhe/cbox/mappings/*.map.json to add device fields without a rebuild.
if [[ -d "${SCRIPT_DIR}/cbox/mappings" ]]; then
    for f in "${SCRIPT_DIR}"/cbox/mappings/*; do
        [[ -e "$f" ]] || continue
        dest="${DHE_ROOT}/cbox/mappings/$(basename "$f")"
        if [[ ! -f "$dest" ]]; then
            install -m 644 "$f" "$dest"
            log "  seeded cbox/mappings/$(basename "$f")"
        fi
    done
fi

# Seed the Node-RED Project by cloning the flows submodule into userDir/projects/.
# Uses a local clone from the check-out on disk so bootstrap works offline;
# origin is rewritten to the GitHub URL from .gitmodules for future pushes.
# If the submodule isn't checked out yet, warn — Node-RED will show the
# first-run wizard on start and the operator can import the project by hand.
NR_PROJECTS_DIR="${DHE_ROOT}/node-red-data/projects"
NR_PROJECT_DIR="${NR_PROJECTS_DIR}/digitalhome-flows"
NR_FLOWS_SRC="${REPO_DIR}/flows/digitalhome-flows"
NR_FLOWS_REMOTE="$(git -C "${REPO_DIR}" config --file .gitmodules submodule.flows/digitalhome-flows.url 2>/dev/null || true)"

if [[ ! -d "${NR_PROJECT_DIR}/.git" ]]; then
    if [[ -e "${NR_FLOWS_SRC}/.git" ]]; then
        mkdir -p "${NR_PROJECTS_DIR}"
        log "  cloning flows submodule into node-red-data/projects/digitalhome-flows"
        git clone -q "${NR_FLOWS_SRC}" "${NR_PROJECT_DIR}"
        if [[ -n "${NR_FLOWS_REMOTE}" ]]; then
            git -C "${NR_PROJECT_DIR}" remote set-url origin "${NR_FLOWS_REMOTE}"
        fi
    else
        log "  WARN: flows submodule not checked out at ${NR_FLOWS_SRC}"
        log "         run 'git submodule update --init --recursive' in the repo and re-run bootstrap"
        log "         (or use the Node-RED first-run wizard to import the project manually)"
    fi
fi

# ── 3. secrets: generate anything missing (idempotent) ───────────────────────

# gen_secret <filename> <length_bytes>
gen_secret() {
    local file="${DHE_ROOT}/secrets/$1"
    local bytes="$2"
    if [[ ! -s "$file" ]]; then
        # -n on printf: no trailing newline. Downstream code (entrypoint.sh
        # `tr -d` and server.py file reads) treats the file as raw bytes.
        printf '%s' "$(python3 -c "import secrets; print(secrets.token_hex($bytes))")" > "$file"
        chmod 600 "$file"
        log "  generated secrets/$1"
    fi
}

# writable_literal <filename> <value>
writable_literal() {
    local file="${DHE_ROOT}/secrets/$1"
    if [[ ! -s "$file" ]]; then
        printf '%s' "$2" > "$file"
        chmod 600 "$file"
        log "  wrote secrets/$1"
    fi
}

gen_secret nodered-credential-secret 32
gen_secret nodered-admin-password 24
gen_secret nodered-http-password 24
gen_secret mcp-auth-token 32
writable_literal nodered-admin-user admin
writable_literal nodered-http-user dhcedge
writable_literal nodered-port "${NODERED_PORT}"
writable_literal home-id "${HOME_ID}"

# placeholder_secret <filename> — create an empty 0600 file the operator fills in.
# Never bake real integration credentials into the repo (they'd be committed).
placeholder_secret() {
    local file="${DHE_ROOT}/secrets/$1"
    if [[ ! -e "$file" ]]; then
        : > "$file"
        chmod 600 "$file"
        log "  created empty secrets/$1 (fill in before enabling the integration)"
    fi
}

# Solarman PV integration secrets — app secret + SHA-256 hex of the account
# password (compute: printf '%s' 'ACCOUNT_PASSWORD' | sha256sum). Empty until set;
# the flow degrades gracefully (logs 'creds missing') while unset.
placeholder_secret solarman-app-secret
placeholder_secret solarman-password-hash

# ── 4. dhe.config.cache (server.py reads this) ───────────────────────────────

CONFIG_CACHE="${DHE_ROOT}/config/dhe.config.cache"
if [[ ! -f "$CONFIG_CACHE" ]]; then
    MCP_TOKEN=$(cat "${DHE_ROOT}/secrets/mcp-auth-token")
    NR_HTTP_PW=$(cat "${DHE_ROOT}/secrets/nodered-http-password")
    NR_ADMIN_PW=$(cat "${DHE_ROOT}/secrets/nodered-admin-password")
    NR_CRED_SECRET=$(cat "${DHE_ROOT}/secrets/nodered-credential-secret")
    python3 - <<PY > "$CONFIG_CACHE"
import json
cfg = {
    "version": 3,
    "instance": {"id": "dhe-01", "name": "digitalhome.edge", "location": "Home"},
    "mcp": {"auth_token": "${MCP_TOKEN}"},
    "nodered": {
        "url": "http://localhost:${NODERED_PORT}",
        "credential_secret": "${NR_CRED_SECRET}",
        "admin_user": "admin",
        "admin_password": "${NR_ADMIN_PW}",
        "http_user": "dhcedge",
        "http_password": "${NR_HTTP_PW}",
    },
    "cloud": {"api_url": "https://api.digitalhome.cloud", "api_key": ""},
    "db": {"path": "/data/db/digitalhome.db"},
    "devices": {
        "homematic-ccu": {"ip": "192.168.1.2"},
        "hue-bridge": {"ip": "192.168.1.15", "api_key": ""},
    },
    "solar": {
        "provider": "solarman",
        "base_url": "https://globalapi.solarmanpv.com",
        "app_id": "",
        "email": "",
        "poll_interval_s": 300,
        "station_ids": [],
    },
}
print(json.dumps(cfg, indent=2))
PY
    chmod 600 "$CONFIG_CACHE"
    log "  wrote config/dhe.config.cache (0600)"
else
    log "  config/dhe.config.cache exists — leaving alone"
fi

# ── 5. permissions ───────────────────────────────────────────────────────────

# All three containers run as uid 1000 (node-red base image default;
# mcp-server + sync-agent Dockerfiles create matching uid). Chown host paths
# so containers can read via owner and non-root host users can't (preserves
# audit finding H-3 posture — secrets are 0600 owned by 1000, dir is 0700).
chown -R 1000:1000 "${DHE_ROOT}/secrets" "${DHE_ROOT}/config"
chmod 700 "${DHE_ROOT}/secrets" "${DHE_ROOT}/config"
find "${DHE_ROOT}/secrets" -type f -exec chmod 600 {} \;
find "${DHE_ROOT}/config"  -type f -exec chmod 600 {} \;
# node-red-data must also be writable by the container (settings.js gets
# rewritten by the entrypoint on first start).
chown -R 1000:1000 "${DHE_ROOT}/node-red-data" "${DHE_ROOT}/cbox" "${DHE_ROOT}/cbox.history" "${DHE_ROOT}/cache" "${DHE_ROOT}/timeseries" "${DHE_ROOT}/db" "${DHE_ROOT}/logs"

# ── 6. done ──────────────────────────────────────────────────────────────────

systemctl daemon-reload

log ""
log "Bootstrap complete."
log ""
log "Next:"
log "  1. Build images (in the repo):"
log "     cd ${REPO_DIR} && sudo docker compose -f deploy/docker-compose.yml build"
log "  2. Bring the stack up:"
log "     sudo systemctl start dhe.service"
log "     (or: sudo docker compose -f ${DHE_ROOT}/docker-compose.yml up -d)"
log "  3. Verify:"
log "     curl -sS -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:${NODERED_PORT}/     # expect 401 (adminAuth)"
log "     curl -sS -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:${MCP_PORT}/sse       # expect 401 (bearer)"
log ""
log "Credentials (in ${DHE_ROOT}/secrets/, mode 0644 under 0700 dir):"
log "  MCP bearer:      $(cat "${DHE_ROOT}/secrets/mcp-auth-token")"
log "  Node-RED admin:  admin / $(cat "${DHE_ROOT}/secrets/nodered-admin-password")"
log "  Node-RED /api/*: dhcedge / $(cat "${DHE_ROOT}/secrets/nodered-http-password")"
