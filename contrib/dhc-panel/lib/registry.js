// registry.js — the codes: who may show and switch what.
//
// A code is an MQTT client of the broker. This file keeps only its id, its
// name and its scope: the secret is the client's password and lives in the
// broker alone (hashed), so reading this file gives nobody access.

"use strict";

const fs = require("fs");
const crypto = require("crypto");

const BELL = ["none", "listen", "ring"];
const KIND = ["panel", "phone"];
const LANG = ["en", "de", "fr"];
const MAX_CODES = 200;

function cleanScope(scope, catalog) {
    const s = scope || {};
    const list = (v) => (Array.isArray(v) ? v : []);
    const out = {
        none: !!s.none,
        floors: list(s.floors).map(Number).filter((n) => Number.isInteger(n) && n >= -5 && n <= 50),
        rooms: list(s.rooms).map(String).filter((r) => /^[0-9a-f]{10}$/.test(r)),
        kinds: list(s.kinds).map(String),
    };
    if (catalog) {
        const rooms = new Set(catalog.rooms.map((r) => r.id));
        out.rooms = out.rooms.filter((r) => rooms.has(r));
        out.kinds = out.kinds.filter((k) => catalog.kinds.includes(k));
    }
    return out;
}

function cleanBell(bell) {
    const ids = (v) => (Array.isArray(v) ? v : []).map(String).filter((x) => /^[0-9a-f]{10}$/.test(x)).slice(0, 50);
    const b = bell || {};
    return { lights: ids(b.lights), chimes: ids(b.chimes) };
}

class Registry {
    constructor(file) {
        this.file = file;
        this.codes = [];
        this.bell = cleanBell();      // what a ring sets off in the house: { lights: [tile id], chimes: [chime id] }
        this.load();
    }

    load() {
        try {
            const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
            this.codes = Array.isArray(data.codes) ? data.codes : [];
            this.bell = cleanBell(data.bell);
        } catch (err) {
            if (err.code !== "ENOENT") throw new Error("cannot read " + this.file + ": " + err.message);
            this.codes = [];
        }
    }

    save() {
        const tmp = this.file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, bell: this.bell, codes: this.codes }, null, 1), { mode: 0o600 });
        fs.renameSync(tmp, this.file);
    }

    setBell(input) { this.bell = cleanBell(input); this.save(); return this.bell; }

    get(id) { return this.codes.find((c) => c.id === id) || null; }

    /** A new code and its secret. The secret is returned once and not kept. */
    create(input, catalog) {
        const i = input || {};
        const name = String(i.name || "").trim().slice(0, 60);
        if (!name) throw new Error("a code needs a name");
        if (this.codes.length >= MAX_CODES) throw new Error("too many codes: revoke some first");
        const code = {
            id: "p" + crypto.randomBytes(6).toString("hex"),
            name,
            scope: cleanScope(i.scope, catalog),
            bell: BELL.includes(i.bell) ? i.bell : "none",
            kind: KIND.includes(i.kind) ? i.kind : "panel",
            lang: LANG.includes(i.lang) ? i.lang : "en",
            created: new Date().toISOString(),
        };
        // A code that rings is on a phone outside the door: it never gets house tiles.
        if (code.bell === "ring") code.scope = { none: true, floors: [], rooms: [], kinds: [] };
        this.codes.push(code);
        this.save();
        return { code, secret: crypto.randomBytes(16).toString("hex") };
    }

    remove(id) {
        const before = this.codes.length;
        this.codes = this.codes.filter((c) => c.id !== id);
        if (this.codes.length === before) return false;
        this.save();
        return true;
    }
}

module.exports = { Registry, cleanScope, cleanBell, BELL, KIND, LANG };
