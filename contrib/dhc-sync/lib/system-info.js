// system-info.js
//
// Gathers the fields needed for the /telemetry payload described in
// docs/specs/edge-cloud-api.md §4. Reads what's readable inside the
// container; falls back to sane defaults when a file isn't mountable.

"use strict";

const fs   = require("fs");
const os   = require("os");
const path = require("path");

/**
 * Read /etc/machine-id if available, otherwise fall back to a persistent
 * UUID stored under the secrets dir. If neither works, return null and let
 * the caller decide what to do.
 */
function readMachineId(secretsDir) {
    try {
        return fs.readFileSync("/etc/machine-id", "utf8").trim();
    } catch (_) { /* fall through */ }

    const fallback = path.join(secretsDir || "/secrets", "machine-id");
    try {
        return fs.readFileSync(fallback, "utf8").trim();
    } catch (_) { /* fall through */ }

    // Generate and persist a UUIDv4-ish 32-char hex string
    try {
        const id = require("crypto").randomBytes(16).toString("hex");
        fs.mkdirSync(path.dirname(fallback), { recursive: true });
        fs.writeFileSync(fallback, id, { mode: 0o600 });
        return id;
    } catch (_) {
        return null;
    }
}

/**
 * Best-effort read of /proc/sys/kernel/random/boot_id — changes every boot.
 */
function readBootId() {
    try {
        return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch (_) {
        return null;
    }
}

/**
 * Read /etc/os-release into a plain object.
 */
function readOsRelease() {
    try {
        const src = fs.readFileSync("/etc/os-release", "utf8");
        const out = {};
        for (const line of src.split("\n")) {
            const m = line.match(/^([A-Z_]+)=(.*)$/);
            if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
        }
        return out;
    } catch (_) {
        return {};
    }
}

/**
 * Primary NIC — the interface with a non-loopback IPv4 address.
 */
function readPrimaryNic() {
    const ifaces = os.networkInterfaces();
    for (const [name, addrs] of Object.entries(ifaces || {})) {
        for (const a of addrs || []) {
            if (a.family === "IPv4" && !a.internal) {
                return { name, mac: a.mac, ip: a.address };
            }
        }
    }
    return { name: null, mac: null, ip: null };
}

/**
 * Read the dhe image version + git sha from files written at build time
 * (Dockerfile ARGs mapped into /etc/dhe-version if present).
 */
function readDheBuildInfo() {
    const out = { dhe_version: "0.0.0-dev", git_sha: null, dhe_image: null };
    try {
        const src = fs.readFileSync("/etc/dhe-version", "utf8");
        for (const line of src.split("\n")) {
            const m = line.match(/^([A-Za-z_]+)=(.*)$/);
            if (m) out[m[1].toLowerCase()] = m[2].trim();
        }
    } catch (_) { /* defaults */ }
    return out;
}

/**
 * Assemble the "full" telemetry payload per spec §4.
 * Callers add `client_timestamp`, `nonce`, and `kind` at send time.
 */
function collectFullTelemetry({ secretsDir, tier = "advanced" } = {}) {
    const nic = readPrimaryNic();
    const osRel = readOsRelease();
    const dhe = readDheBuildInfo();

    return {
        protocol_version: 1,
        edge: {
            machine_id:  readMachineId(secretsDir),
            hostname:    os.hostname(),
            mac_primary: nic.mac,
            lan_ip:      nic.ip,
            timezone:    Intl.DateTimeFormat().resolvedOptions().timeZone,
            locale:      process.env.LC_ALL || process.env.LANG || "C"
        },
        software: {
            dhe_version:      dhe.dhe_version,
            dhe_image:        dhe.dhe_image,
            git_sha:          dhe.git_sha,
            node_red_version: null,       // dhc-sync-config fills this from Node-RED's own version
            os:               osRel.PRETTY_NAME || `${osRel.NAME} ${osRel.VERSION_ID}`.trim(),
            kernel:           os.release(),
            arch:             os.arch()
        },
        capabilities: {
            protocols:  [],               // populated by dhc-sync-config from palette manifest
            palettes:   [],               // ditto
            mcp:        { enabled: false, transports: [] },
            tier,
            features:   []
        },
        hardware: {
            cpu_model:    os.cpus()?.[0]?.model || null,
            cpu_cores:    os.cpus()?.length || null,
            memory_mb:    Math.round(os.totalmem() / (1024 * 1024)),
            disk_free_gb: null            // best-effort; caller can fill via statfs
        },
        runtime: {
            boot_id:                readBootId(),
            boot_time_epoch:        Math.floor(Date.now() / 1000 - os.uptime()),
            config_cache_version:   3,
            cbox_version:           null
        }
    };
}

module.exports = {
    readMachineId,
    readBootId,
    readOsRelease,
    readPrimaryNic,
    readDheBuildInfo,
    collectFullTelemetry
};
