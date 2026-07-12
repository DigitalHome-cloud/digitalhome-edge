#!/bin/sh
# dhe-entrypoint.sh — first-boot config for the digitalhome.edge Node-RED image.
#
# Runs before the base image's node-red command. Its job is limited:
#   1. If /data/settings.js doesn't exist, seed it from the base image default.
#   2. If the seeded settings.js has commented-out auth blocks (the default),
#      replace them with real adminAuth + httpNodeAuth blocks whose bcrypt
#      hashes are derived from /secrets/nodered-admin-password and
#      /secrets/nodered-http-password.
#   3. Set uiPort to the value in /secrets/nodered-port (default 1880).
#   4. Insert credentialSecret from /secrets/nodered-credential-secret.
#
# All operations are idempotent — re-running the container reads the current
# settings.js and only touches lines that still hold the default markers.
# Secrets live under /secrets (mode 0600, owned by uid 1000 to match the
# node-red user in the base image).

set -eu

SETTINGS=/data/settings.js
SECRETS=/secrets
BCRYPT="/usr/src/node-red/node_modules/bcryptjs"

log() { printf 'dhe-entrypoint: %s\n' "$*" >&2; }

# read_secret <file> <default>
read_secret() {
    if [ -r "$SECRETS/$1" ]; then
        tr -d '\r\n' < "$SECRETS/$1"
    else
        printf '%s' "${2:-}"
    fi
}

# hash a password via the bcryptjs shipped in Node-RED
hash_pw() {
    node -e "
        const bcrypt = require('$BCRYPT');
        let data = '';
        process.stdin.on('data', c => data += c);
        process.stdin.on('end', () => {
            bcrypt.hash(data.replace(/\r?\n\$/, ''), 8, (err, h) => {
                if (err) { console.error(err); process.exit(1); }
                process.stdout.write(h);
            });
        });
    " <<EOF
$1
EOF
}

if [ ! -f "$SETTINGS" ]; then
    log "seeding /data/settings.js from base image default"
    cp /usr/src/node-red/node_modules/node-red/settings.js "$SETTINGS"
fi

# uiPort
UI_PORT=$(read_secret nodered-port 1880)
if ! grep -qE '^[[:space:]]*uiPort:' "$SETTINGS"; then
    log "inserting uiPort=$UI_PORT"
    sed -i "s|^module\\.exports = {|module.exports = {\\n    uiPort: $UI_PORT,|" "$SETTINGS"
else
    sed -i -E "s|^([[:space:]]*)uiPort:[[:space:]]*[^,]*,|\\1uiPort: $UI_PORT,|" "$SETTINGS"
fi

# credentialSecret
CRED_SECRET=$(read_secret nodered-credential-secret "")
if [ -n "$CRED_SECRET" ]; then
    if grep -qE '^[[:space:]]*//credentialSecret:' "$SETTINGS"; then
        sed -i "s|^\\([[:space:]]*\\)//credentialSecret:.*|\\1credentialSecret: \"$CRED_SECRET\",|" "$SETTINGS"
        log "inserted credentialSecret"
    elif ! grep -qE '^[[:space:]]*credentialSecret:' "$SETTINGS"; then
        sed -i "s|^module\\.exports = {|module.exports = {\\n    credentialSecret: \"$CRED_SECRET\",|" "$SETTINGS"
        log "inserted credentialSecret at top"
    fi
fi

# adminAuth
ADMIN_USER=$(read_secret nodered-admin-user admin)
ADMIN_PW=$(read_secret nodered-admin-password "")
if [ -n "$ADMIN_PW" ] && ! grep -qE '^[[:space:]]*adminAuth:' "$SETTINGS"; then
    log "inserting adminAuth for user '$ADMIN_USER'"
    ADMIN_HASH=$(hash_pw "$ADMIN_PW")
    ADMIN_BLOCK="    adminAuth: {\n        type: \"credentials\",\n        users: [{ username: \"$ADMIN_USER\", password: \"$ADMIN_HASH\", permissions: \"*\" }]\n    },"
    awk -v block="$ADMIN_BLOCK" '
        /module\.exports[[:space:]]*=[[:space:]]*\{/ && !inserted { print; print block; inserted=1; next }
        { print }
    ' "$SETTINGS" > "${SETTINGS}.tmp" && mv "${SETTINGS}.tmp" "$SETTINGS"
fi

# httpNode auth — path-aware middleware.
# Runs Basic auth against /api/* and other httpNode routes but exempts
# /dashboard/* so the pairing UI works without credentials on the LAN.
# Replaces the earlier plain-httpNodeAuth insertion; we strip any leftover
# httpNodeAuth block from a prior boot to avoid double-walling.
HTTP_USER=$(read_secret nodered-http-user dhcedge)
HTTP_PW=$(read_secret nodered-http-password "")

if grep -qE '^[[:space:]]*httpNodeAuth:' "$SETTINGS"; then
    log "stripping legacy httpNodeAuth block (replaced by httpNodeMiddleware)"
    sed -i -E '/^[[:space:]]*httpNodeAuth:/d' "$SETTINGS"
fi

if [ -n "$HTTP_PW" ] && ! grep -qE '^[[:space:]]*httpNodeMiddleware:' "$SETTINGS"; then
    log "inserting httpNodeMiddleware (Basic auth, /dashboard exempt) for user '$HTTP_USER'"
    HTTP_HASH=$(hash_pw "$HTTP_PW")
    HTTP_BLOCK="    httpNodeMiddleware: require(\"/usr/local/share/dhe/http-auth-middleware.js\")({ user: \"$HTTP_USER\", hash: \"$HTTP_HASH\" }),"
    awk -v block="$HTTP_BLOCK" '
        /module\.exports[[:space:]]*=[[:space:]]*\{/ && !inserted { print; print block; inserted=1; next }
        { print }
    ' "$SETTINGS" > "${SETTINGS}.tmp" && mv "${SETTINGS}.tmp" "$SETTINGS"
fi

# httpStatic — serve the edge web app (Gatsby static build) at /app from the
# read-only /webapp mount. Idempotent: only insert if not already present.
if ! grep -qE '^[[:space:]]*httpStatic:' "$SETTINGS"; then
    log "inserting httpStatic (/webapp -> /app)"
    HS_BLOCK='    httpStatic: [{ path: "/webapp", root: "/app/" }],'
    awk -v block="$HS_BLOCK" '
        /module\.exports[[:space:]]*=[[:space:]]*\{/ && !ins { print; print block; ins=1; next }
        { print }
    ' "$SETTINGS" > "${SETTINGS}.tmp" && mv "${SETTINGS}.tmp" "$SETTINGS"
fi

# Enable Projects — the default has `enabled: false` under editorTheme.projects.
# The stock settings.js has several `enabled: false` blocks (runtimeState, projects,
# …); an unanchored "first match" sed flips the wrong one and leaves Projects off,
# so target the projects block specifically. Idempotent (no-op once true).
awk '
    /projects:[[:space:]]*\{/ { inproj=1 }
    inproj && /enabled:[[:space:]]*false/ { sub(/enabled:[[:space:]]*false/, "enabled: true"); inproj=0 }
    { print }
' "$SETTINGS" > "${SETTINGS}.tmp" && mv "${SETTINGS}.tmp" "$SETTINGS"

# Seed .config.projects.json so Node-RED boots directly into the flows project
# and skips the first-run wizard. Requires bootstrap.sh to have cloned the
# flows submodule into /data/projects/digitalhome-flows/ first. If the project
# isn't there we leave things alone — the operator will hit the wizard and can
# import the project by hand.
PROJECTS_CFG=/data/.config.projects.json
if [ ! -f "$PROJECTS_CFG" ] && [ -d /data/projects/digitalhome-flows/.git ]; then
    log "seeding .config.projects.json (active project = digitalhome-flows)"
    cat > "$PROJECTS_CFG" <<'EOF'
{
    "activeProject": "digitalhome-flows",
    "projects": {
        "digitalhome-flows": {}
    }
}
EOF
fi

# Seed the starter flow on very first boot as a fallback. If Projects mode is
# active with an activeProject, Node-RED reads from /data/projects/<name>/
# and this file is ignored. Kept around one release for boxes that couldn't
# seed the project (submodule not checked out, offline, etc.).
STARTER_FLOW=/usr/local/share/dhe/starter-flow.json
if [ ! -f /data/flows.json ] && [ -r "$STARTER_FLOW" ]; then
    log "seeding /data/flows.json from starter-flow.json (fallback)"
    cp "$STARTER_FLOW" /data/flows.json
fi

log "settings.js ready — starting node-red"

exec "$@"
