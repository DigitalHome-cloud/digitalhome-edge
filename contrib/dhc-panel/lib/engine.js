// engine.js — the panel's brain, between the broker and the flow.
//
// It keeps the codes, tells the broker what each may do, publishes each
// code's tiles and their state, and checks every action a phone sends against
// that code's scope before handing it to the flow as a device command.
// It never talks to a device: the flow does (the edge's golden rule).
//
// Topics, all under dhc/panel/<code id>/:
//   scope   edge -> phone, retained   { name, lang, bell, tiles: [{ id, kind, func, label, room }] }
//   state   edge -> phone, retained   { <tile id>: { on, level, setpoint, temp, reachable } }
//   event   edge -> phone             { t: "ring" | "rung" | "answer" | "answered" | "refused", ... }
//   act     phone -> edge             { tile, action: "on"|"off"|"level"|"setpoint", value }
//   status  phone -> edge, retained   { state: "online" | "offline" } (offline is the last will)
//   ring    phone -> edge             {}            only a code with bell "ring"
//   answer  phone -> edge             { answer }    only a code with bell "listen"

"use strict";

const fs = require("fs");
const { EventEmitter } = require("events");
const tiles = require("./tiles");
const dynsec = require("./dynsec");
const { Registry } = require("./registry");
const { Labels } = require("./labels");

const ANSWERS = ["coming", "wait", "leave"];
const MAX_PAYLOAD = 512;
const ACTS_PER_10S = 30;
const RING_EVERY_MS = 5000;
const ANSWER_WITHIN_MS = 120000;
const DYNSEC_TIMEOUT_MS = 5000;

class Engine extends EventEmitter {
    /**
     * @param {object} o
     * @param {object} o.mqtt        the `mqtt` module
     * @param {string} o.brokerUrl   e.g. mqtt://127.0.0.1:1883
     * @param {string} o.username    the broker's admin client (Node-RED)
     * @param {string} o.password
     * @param {string} o.registryFile
     * @param {string} o.cboxFile
     * @param {string} [o.labelsFile]  the home's words in EN/DE/FR (lib/labels.js)
     * @param {function} [o.log]     (level, text)
     */
    constructor(o) {
        super();
        this.o = o;
        this.log = o.log || (() => {});
        this.registry = new Registry(o.registryFile);
        this.labels = new Labels(o.labelsFile || require("path").join(require("path").dirname(o.registryFile), "labels.json"));
        if (this.labels.error) this.log("error", "cannot read the labels: " + this.labels.error);
        this.catalog = { rooms: [], floors: [], tiles: [], kinds: tiles.KINDS };
        this.cboxStamp = 0;
        this.values = { ccu: new Map(), hue: new Map() };
        this.online = new Map();      // code id -> true
        this.sent = new Map();        // topic -> last retained payload, to publish changes only
        this.acts = new Map();        // code id -> [timestamps]
        this.lastRing = null;         // { ringId, from, ts }
        this.client = null;
        this.connected = false;
        this.queue = Promise.resolve();
        this.waiting = null;          // the dynsec request in flight
        this.timer = null;
    }

    // ── life ────────────────────────────────────────────────────────────────

    start() {
        this.loadCatalog();
        this.client = this.o.mqtt.connect(this.o.brokerUrl, {
            username: this.o.username, password: this.o.password,
            clientId: "dhe-nodered-panel", clean: true, reconnectPeriod: 5000, connectTimeout: 10000,
        });
        this.client.on("connect", () => this.onConnect());
        this.client.on("close", () => { if (this.connected) this.log("warn", "broker link lost"); this.connected = false; this.emit("link", false); });
        this.client.on("error", (err) => this.log("warn", "broker: " + err.message));
        this.client.on("message", (topic, payload) => {
            try { this.onMessage(topic, payload); } catch (err) { this.log("error", "message on " + topic + ": " + err.message); }
        });
        this.timer = setInterval(() => {
            let changed = this.loadCatalog();
            try { changed = this.labels.reload() || changed; } catch (err) { this.log("error", "cannot read the labels: " + err.message); }
            if (changed && this.connected) this.publishAll();
        }, 30000);
        if (this.timer.unref) this.timer.unref();
    }

    stop() {
        clearInterval(this.timer);
        return new Promise((resolve) => { if (!this.client) return resolve(); this.client.end(true, {}, () => resolve()); });
    }

    onConnect() {
        this.sent.clear();
        const topics = [dynsec.RESPONSE].concat(["act", "ring", "answer", "status"].map((t) => dynsec.BASE + "/+/" + t));
        this.client.subscribe(topics, (err) => {
            if (err) return this.log("error", "broker: cannot subscribe: " + err.message);
            this.syncRules().then((ready) => {
                if (!ready) return;               // the broker drops this link to apply our own new rule; we come back
                this.connected = true;
                this.emit("link", true);
                this.publishAll();
            }, (err) => this.log("error", "broker access rules: " + err.message));
        });
    }

    /**
     * Make the broker's rules match the codes. The broker disconnects every
     * client whose role changes, so only roles that really differ are touched:
     * a Node-RED restart must not throw the phones out.
     */
    async syncRules() {
        const res = await this.control([{ command: "listRoles", verbose: true, count: -1, offset: 0 }]);
        const roles = new Map((((res[0] || {}).data || {}).roles || []).map((r) => [r.rolename, r.acls || []]));
        const key = (acls) => acls.map((a) => a.acltype + " " + a.topic + " " + (a.allow !== false)).sort().join("|");
        const mine = dynsec.selfCommands()[0];
        if (!(roles.get(mine.rolename) || []).some((a) => a.acltype === mine.acltype && a.topic === mine.topic)) {
            this.log("info", "broker: adding Node-RED's right to publish (one reconnect follows)");
            this.client.publish(dynsec.CONTROL, JSON.stringify({ commands: [mine] }), { qos: 1 });
            return false;
        }
        for (const code of this.registry.codes) {
            const have = roles.get(dynsec.roleName(code.id));
            if (!have) { this.log("warn", "code " + code.id + " (" + code.name + ") is unknown to the broker: revoke it and make a new one"); continue; }
            if (key(have) !== key(dynsec.aclsFor(code))) await this.control(dynsec.refreshCommands(code), true);
        }
        return true;
    }

    // ── the twin ────────────────────────────────────────────────────────────

    /** Read the twin again when its file changed. True when it did. */
    loadCatalog() {
        let stamp = 0;
        try { stamp = fs.statSync(this.o.cboxFile).mtimeMs; } catch (_) { /* no twin yet */ }
        if (stamp === this.cboxStamp) return false;
        this.cboxStamp = stamp;
        try {
            const doc = stamp ? JSON.parse(fs.readFileSync(this.o.cboxFile, "utf8")) : {};
            this.catalog = tiles.buildCatalog(doc["@graph"] || []);
            this.log("info", "twin: " + this.catalog.tiles.length + " tiles in " + this.catalog.rooms.length + " rooms");
        } catch (err) {
            this.log("error", "cannot read the twin: " + err.message);
        }
        return true;
    }

    scopeTiles(code) { return tiles.tilesForScope(this.catalog, code.scope); }

    tileState(tile) {
        if (tile.source === "hue") {
            const v = this.values.hue.get(tile.ref);
            if (!v) return {};
            const s = { on: !!v.on, reachable: v.reachable !== false };
            if (tile.kind === "dimmer" && v.bri != null) s.level = Math.round(v.bri / 2.54);
            return s;
        }
        const v = this.values.ccu.get(tile.ref);
        if (v === undefined) return {};
        if (tile.kind === "switch") return { on: v === true || v === "true" || v === 1 };
        if (tile.kind === "dimmer") { const level = Math.round(Number(v) * 100); return { on: level > 0, level }; }
        if (tile.kind === "blind") return { level: Math.round(Number(v) * 100) };
        const s = { setpoint: Number(v) };
        const t = tile.tempRef ? this.values.ccu.get(tile.tempRef) : undefined;
        if (t !== undefined) s.temp = Number(t);
        return s;
    }

    /** Values as the devices report them, from the flow: ccu { ref: value }, hue { uniqueid: { on, bri, reachable } }. */
    setValues(source, values) {
        const map = this.values[source];
        if (!map || !values || typeof values !== "object") return;
        for (const key of Object.keys(values)) map.set(key, values[key]);
        if (this.connected) for (const code of this.registry.codes) this.publishState(code);
    }

    // ── publishing ──────────────────────────────────────────────────────────

    retained(topic, object) {
        const text = object == null ? "" : JSON.stringify(object);
        if (this.sent.get(topic) === text) return;
        this.sent.set(topic, text);
        this.client.publish(topic, text, { retain: true, qos: 1 });
    }

    event(id, object) { this.client.publish(dynsec.topicOf(id, "event"), JSON.stringify(object), { qos: 1 }); }

    publishScope(code) {
        const list = this.scopeTiles(code);
        this.retained(dynsec.topicOf(code.id, "scope"), { name: code.name, lang: code.lang, bell: code.bell, tiles: tiles.publicTiles(this.catalog, list, (w) => this.labels.tr(w, code.lang)) });
        this.publishState(code, list);
    }

    publishState(code, list) {
        const state = {};
        for (const t of list || this.scopeTiles(code)) state[t.id] = this.tileState(t);
        this.retained(dynsec.topicOf(code.id, "state"), state);
    }

    publishAll() { for (const code of this.registry.codes) this.publishScope(code); }

    // ── what phones send ────────────────────────────────────────────────────

    onMessage(topic, payload) {
        if (topic === dynsec.RESPONSE) return this.onControlResponse(payload);
        const m = /^dhc\/panel\/([a-z0-9]+)\/(act|ring|answer|status)$/.exec(topic);
        if (!m) return;
        const code = this.registry.get(m[1]);
        if (!code || payload.length > MAX_PAYLOAD) return;
        let body = {};
        if (payload.length) { try { body = JSON.parse(payload.toString("utf8")); } catch (_) { return; } }
        if (!body || typeof body !== "object") return;
        if (m[2] === "status") return this.onStatus(code, body);
        if (m[2] === "act") return this.onAct(code, body);
        if (m[2] === "ring") return this.onRing(code);
        return this.onAnswer(code, body);
    }

    onStatus(code, body) {
        const now = body.state === "online";
        if (now === !!this.online.get(code.id)) return;
        this.online.set(code.id, now);
        this.emit("status", { code: code.id, name: code.name, online: now });
    }

    allowed(id) {
        const now = Date.now();
        const recent = (this.acts.get(id) || []).filter((t) => now - t < 10000);
        if (recent.length >= ACTS_PER_10S) { this.acts.set(id, recent); return false; }
        recent.push(now); this.acts.set(id, recent);
        return true;
    }

    onAct(code, body) {
        const refuse = (why) => { this.event(code.id, { t: "refused", tile: body.tile, why }); this.log("warn", "refused " + code.id + " (" + code.name + "): " + why); };
        if (!this.allowed(code.id)) return refuse("too fast");
        const tile = this.scopeTiles(code).find((t) => t.id === body.tile);
        if (!tile) return refuse("not in this code's scope");
        const cmd = tiles.commandFor(tile, body.action, body.value);
        if (!cmd) return refuse("this tile cannot do that");
        this.assume(tile, cmd);
        this.emit("act", { code: code.id, name: code.name, tile: tile.id, label: tile.label, kind: tile.kind, source: tile.source, ref: tile.ref, set: cmd.set, value: cmd.value });
    }

    /** Show the new value at once; the next reading from the device corrects it. */
    assume(tile, cmd) {
        if (tile.source === "hue") {
            const v = Object.assign({ on: false, reachable: true }, this.values.hue.get(tile.ref));
            if (cmd.set === "on") v.on = cmd.value;
            if (cmd.set === "level") { v.bri = Math.round(cmd.value * 2.54); v.on = cmd.value > 0; }
            this.values.hue.set(tile.ref, v);
        } else {
            this.values.ccu.set(tile.ref, cmd.set === "level" ? cmd.value / 100 : cmd.value);
        }
        for (const code of this.registry.codes) this.publishState(code);
    }

    onRing(code) {
        if (code.bell !== "ring") return;
        const now = Date.now();
        if (this.lastRing && this.lastRing.from === code.id && now - this.lastRing.ts < RING_EVERY_MS) return;
        const ringId = now.toString(36);
        this.lastRing = { ringId, from: code.id, ts: now };
        const listeners = this.registry.codes.filter((c) => c.bell === "listen");
        for (const l of listeners) this.event(l.id, { t: "ring", ringId, from: code.name, ts: now });
        const hearing = listeners.filter((l) => this.online.get(l.id)).length;
        this.event(code.id, { t: "rung", ringId, listeners: hearing });
        const targets = this.setOffBell(code.name);
        this.emit("ring", { ringId, code: code.id, name: code.name, listeners: hearing, targets });
    }

    /** The house's own bell: the chosen Hue lights blink, the chosen chimes sound. Returns how many. */
    setOffBell(name) {
        const bell = this.registry.bell;
        const cmds = [];
        for (const t of this.catalog.tiles) if (t.source === "hue" && bell.lights.includes(t.id)) cmds.push({ source: "hue", ref: t.ref, kind: "bell", set: "alert", value: true, label: t.label });
        for (const c of this.catalog.chimes) if (bell.chimes.includes(c.id)) cmds.push({ source: "ccu", ref: c.ref, kind: "bell", set: "on", value: true, label: c.label });
        for (const cmd of cmds) this.emit("act", Object.assign({ name }, cmd));
        return cmds.length;
    }

    bellSettings() {
        const label = new Map(this.catalog.rooms.map((r) => [r.id, r.label]));
        return {
            bell: this.registry.bell,
            options: {
                lights: this.catalog.tiles.filter((t) => t.source === "hue").map((t) => ({ id: t.id, label: t.label, room: t.room ? label.get(t.room) : "" })),
                chimes: this.catalog.chimes.map((c) => ({ id: c.id, label: c.label })),
            },
        };
    }

    onAnswer(code, body) {
        if (code.bell !== "listen" || !ANSWERS.includes(body.answer)) return;
        const ring = this.lastRing;
        if (!ring || Date.now() - ring.ts > ANSWER_WITHIN_MS) return;
        this.event(ring.from, { t: "answer", ringId: ring.ringId, answer: body.answer, by: code.name });
        for (const l of this.registry.codes) if (l.bell === "listen") this.event(l.id, { t: "answered", ringId: ring.ringId, answer: body.answer, by: code.name });
        this.emit("answer", { ringId: ring.ringId, answer: body.answer, code: code.id, name: code.name });
    }

    // ── the broker's access rules ───────────────────────────────────────────

    /** Send commands to the broker and wait for its verdict. `lenient`: an error on a command is logged, not thrown. */
    control(commands, lenient) {
        const run = () => new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.waiting = null; reject(new Error("the broker did not answer")); }, DYNSEC_TIMEOUT_MS);
            this.waiting = (responses) => {
                clearTimeout(timer); this.waiting = null;
                const bad = responses.filter((r) => r.error);
                if (bad.length && !lenient) return reject(new Error(bad.map((r) => r.command + ": " + r.error).join("; ")));
                for (const r of bad) if (!/already/i.test(r.error)) this.log("warn", "broker: " + r.command + ": " + r.error);
                resolve(responses);
            };
            this.client.publish(dynsec.CONTROL, JSON.stringify({ commands }), { qos: 1 });
        });
        const next = this.queue.then(run, run);
        this.queue = next.catch(() => {});
        return next;
    }

    onControlResponse(payload) {
        let body; try { body = JSON.parse(payload.toString("utf8")); } catch (_) { return; }
        if (this.waiting) this.waiting(Array.isArray(body.responses) ? body.responses : []);
    }

    // ── the admin's side ────────────────────────────────────────────────────

    list() {
        return {
            broker: { connected: this.connected },
            codes: this.registry.codes.map((c) => Object.assign({}, c, { online: !!this.online.get(c.id), tiles: this.scopeTiles(c).length })),
            catalog: { floors: this.catalog.floors, kinds: this.catalog.kinds, rooms: this.catalog.rooms.map((r) => ({ id: r.id, label: r.label, name: tiles.plainRoom(r.label), floor: r.floor, source: r.source })), tiles: this.catalog.tiles.length },
        };
    }

    /** The label dictionary: every word the home shows, and its translations. */
    labelEntries() {
        return { langs: ["en", "de", "fr"], entries: this.labels.entries(tiles.homeWords(this.catalog)) };
    }

    /** Change translations ({ original: { en, de, fr } }); the phones get the new words at once. */
    setLabels(changes) {
        const n = this.labels.set(changes);
        if (n && this.connected) this.publishAll();
        return n;
    }

    async createCode(input) {
        if (!this.connected) throw new Error("the broker is not connected");
        const { code, secret } = this.registry.create(input, this.catalog);
        try {
            await this.control(dynsec.createCommands(code, secret));
        } catch (err) {
            this.registry.remove(code.id);
            throw err;
        }
        this.publishScope(code);
        this.log("info", "code made: " + code.id + " (" + code.name + ")");
        return { code, secret };
    }

    async revokeCode(id) {
        if (!this.connected) throw new Error("the broker is not connected");
        if (!this.registry.get(id)) return false;
        await this.control(dynsec.deleteCommands(id), true);
        this.registry.remove(id);
        this.online.delete(id);
        for (const leaf of ["scope", "state", "status"]) { this.sent.delete(dynsec.topicOf(id, leaf)); this.retained(dynsec.topicOf(id, leaf), null); }
        this.log("info", "code revoked: " + id);
        return true;
    }
}

module.exports = { Engine, ANSWERS };
