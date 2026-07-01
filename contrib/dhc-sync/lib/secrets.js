// secrets.js — atomic writes and reads for /opt/dhe/secrets/*.
//
// Every write goes to a .tmp sibling then rename() — no partial files on crash.
// Modes are always 0600; owner is whoever the process runs as (uid 1000 in the
// dhe Node-RED container).

"use strict";

const fs   = require("fs").promises;
const path = require("path");

async function readSecret(secretsDir, name) {
    try {
        const buf = await fs.readFile(path.join(secretsDir, name), "utf8");
        return buf.trim();
    } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
    }
}

async function writeSecret(secretsDir, name, value) {
    const target = path.join(secretsDir, name);
    const tmp    = `${target}.tmp`;
    await fs.mkdir(secretsDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(tmp, String(value), { mode: 0o600 });
    await fs.rename(tmp, target);
}

async function deleteSecret(secretsDir, name) {
    try {
        await fs.unlink(path.join(secretsDir, name));
    } catch (err) {
        if (err.code !== "ENOENT") throw err;
    }
}

/**
 * Wipe every secret related to a linked session — used when the cloud
 * returns 410 Gone or the operator hits "Unlink" locally.
 */
async function wipeLinkageSecrets(secretsDir) {
    for (const name of ["device-token", "edge-id", "home-id"]) {
        await deleteSecret(secretsDir, name);
    }
}

module.exports = { readSecret, writeSecret, deleteSecret, wipeLinkageSecrets };
