// labels.js — the home's own words in EN, DE and FR.
//
// A room or a device keeps the name it has in the CCU or the Hue app: that
// name is the key. A translation is looked up by it, and a missing one falls
// back to the name itself, so nothing ever shows blank. One file per edge:
//
//   /cbox/labels.json   { version: 1, labels: { "<original>": { en, de, fr } } }
//
// It holds room and device names (personal data), so it is runtime only,
// written 0600, never committed.

"use strict";

const fs = require("fs");
const path = require("path");

const LANGS = ["en", "de", "fr"];
const MAX = 80;   // the longest translation kept

class Labels {
    constructor(file) {
        this.file = file;
        this.labels = {};
        this.stamp = -1;
        this.error = null;
        try { this.reload(); } catch (err) { this.error = err.message; }   // a broken file: names shown as they are
    }

    /** Read the file again when it changed on disk. True when it did. */
    reload() {
        let stamp = 0;
        try { stamp = fs.statSync(this.file).mtimeMs; } catch (_) { /* none yet */ }
        if (stamp === this.stamp) return false;
        this.stamp = stamp;
        this.labels = {};
        if (!stamp) return true;
        const doc = JSON.parse(fs.readFileSync(this.file, "utf8"));
        const src = (doc && doc.labels) || {};
        for (const key of Object.keys(src)) {
            const entry = clean(src[key]);
            if (entry) this.labels[key] = entry;
        }
        return true;
    }

    /** The word for `original` in `lang`, or `original` itself. */
    tr(original, lang) {
        const entry = this.labels[original];
        return (entry && entry[lang]) || original;
    }

    /**
     * Change several at once: { "<original>": { en, de, fr } }. An empty string
     * removes that language, an entry with none left goes. Returns the count changed.
     */
    set(changes) {
        if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new Error("expected { original: { en, de, fr } }");
        let n = 0;
        for (const original of Object.keys(changes)) {
            if (!original || original.length > 200) throw new Error("a label must be 1 to 200 characters");
            const next = Object.assign({}, this.labels[original], pick(changes[original]));
            for (const l of LANGS) if (!next[l]) delete next[l];
            const before = JSON.stringify(this.labels[original] || {});
            if (Object.keys(next).length) this.labels[original] = next; else delete this.labels[original];
            if (JSON.stringify(this.labels[original] || {}) !== before) n++;
        }
        if (n) this.save();
        return n;
    }

    save() {
        const sorted = {};
        for (const k of Object.keys(this.labels).sort()) sorted[k] = this.labels[k];
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = this.file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, labels: sorted }, null, 2) + "\n", { mode: 0o600 });
        fs.renameSync(tmp, this.file);
        try { this.stamp = fs.statSync(this.file).mtimeMs; } catch (_) { /* ignore */ }
    }

    /**
     * Every word the home shows, with what is known for it:
     * [{ original, names: [as in the CCU or Hue], where: ["room"|"tile"|"chime"|"other"], rooms: [room], en, de, fr }].
     * Words no longer in the twin but still translated come last (where: []).
     */
    entries(words) {
        const out = new Map();
        for (const w of words) {
            const e = out.get(w.original) || { original: w.original, names: [], where: [], rooms: [] };
            if (!e.where.includes(w.where)) e.where.push(w.where);
            if (w.name && !e.names.includes(w.name)) e.names.push(w.name);
            if (w.room && !e.rooms.includes(w.room)) e.rooms.push(w.room);
            out.set(w.original, e);
        }
        for (const k of Object.keys(this.labels)) if (!out.has(k)) out.set(k, { original: k, names: [], where: [], rooms: [] });
        return [...out.values()].map((e) => Object.assign(e, this.labels[e.original] || {}));
    }
}

function pick(v) {
    const out = {};
    if (!v || typeof v !== "object") return out;
    for (const l of LANGS) if (typeof v[l] === "string") out[l] = v[l].trim().slice(0, MAX);
    return out;
}

function clean(v) {
    const out = {};
    const p = pick(v);
    for (const l of LANGS) if (p[l]) out[l] = p[l];
    return Object.keys(out).length ? out : null;
}

module.exports = { Labels, LANGS };
