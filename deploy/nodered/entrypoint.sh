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

# httpNodeAuth
HTTP_USER=$(read_secret nodered-http-user dhcedge)
HTTP_PW=$(read_secret nodered-http-password "")
if [ -n "$HTTP_PW" ] && ! grep -qE '^[[:space:]]*httpNodeAuth:' "$SETTINGS"; then
    log "inserting httpNodeAuth for user '$HTTP_USER'"
    HTTP_HASH=$(hash_pw "$HTTP_PW")
    HTTP_BLOCK="    httpNodeAuth: { user: \"$HTTP_USER\", pass: \"$HTTP_HASH\" },"
    awk -v block="$HTTP_BLOCK" '
        /module\.exports[[:space:]]*=[[:space:]]*\{/ && !inserted { print; print block; inserted=1; next }
        { print }
    ' "$SETTINGS" > "${SETTINGS}.tmp" && mv "${SETTINGS}.tmp" "$SETTINGS"
fi

# Enable Projects — the default has `enabled: false` under editorTheme.projects
sed -i -E "0,/enabled: false,/{s/enabled: false,/enabled: true,/}" "$SETTINGS"

log "settings.js ready — starting node-red"

exec "$@"
