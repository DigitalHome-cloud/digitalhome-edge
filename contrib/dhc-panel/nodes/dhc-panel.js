// dhc-panel.js — the panel engine as a Node-RED node.
//
// One node per Node-RED instance.
//   in:    { topic: "values", payload: { source: "ccu" | "hue", values: {...} } }   what the devices report
//   out 1: { topic: "act",  payload: { source, ref, kind, set, value, ... } }       a checked device command
//          (a tap on a tile, or kind "bell": a light to blink, a chime to sound, when the bell rings)
//   out 2: { topic: "ring" | "answer" | "status", payload: {...} }                  bell and phone events
//
// The codes are managed over HTTP under /api/panel/*, which sits behind the
// edge's basic-auth middleware like every other /api/* route.

"use strict";

const fs = require("fs");
const os = require("os");
const mqtt = require("mqtt");
const { Engine } = require("../lib/engine");

module.exports = function (RED) {
    let engine = null;   // the running node's engine; the HTTP routes below use it

    function DhcPanelNode(cfg) {
        RED.nodes.createNode(this, cfg);
        const node = this;
        let password = "";
        try { password = fs.readFileSync(cfg.passwordFile || "/secrets/mqtt-nodered-password", "utf8").trim(); } catch (_) { /* reported below */ }
        if (!password) {
            node.status({ fill: "red", shape: "ring", text: "no broker password" });
            node.error("dhc-panel: cannot read " + (cfg.passwordFile || "/secrets/mqtt-nodered-password") + " (run deploy/bootstrap.sh)");
            return;
        }
        const mine = new Engine({
            mqtt,
            brokerUrl: cfg.brokerUrl || "mqtt://127.0.0.1:1883",
            username: cfg.username || "dhe-nodered",
            password,
            registryFile: cfg.registryFile || "/cbox/panel-codes.json",
            cboxFile: cfg.cboxFile || "/cbox/cbox.jsonld",
            log: (level, text) => (level === "error" ? node.error(text) : level === "warn" ? node.warn(text) : node.log(text)),
        });
        mine.wsPort = parseInt(cfg.wsPort || "9001", 10);
        const show = () => node.status(mine.connected
            ? { fill: "green", shape: "dot", text: mine.registry.codes.length + " codes, " + mine.catalog.tiles.length + " tiles" }
            : { fill: "yellow", shape: "ring", text: "no broker" });
        mine.on("link", show);
        mine.on("act", (payload) => node.send([{ topic: "act", payload }, null]));
        for (const kind of ["ring", "answer", "status"]) mine.on(kind, (payload) => { node.send([null, { topic: kind, payload }]); show(); });
        try { mine.start(); } catch (err) { node.error("dhc-panel: " + err.message); return; }
        engine = mine;
        show();

        node.on("input", (msg, send, done) => {
            if (msg.topic === "values" && msg.payload) mine.setValues(msg.payload.source, msg.payload.values);
            done();
        });
        node.on("close", (removed, done) => {
            if (engine === mine) engine = null;
            mine.stop().then(() => done(), () => done());
        });
    }
    RED.nodes.registerType("dhc-panel", DhcPanelNode);

    // ── /api/panel/* (behind the edge's basic auth) ─────────────────────────
    // Node-RED runs httpNodeMiddleware only for HTTP In nodes, not for routes a
    // palette adds to RED.httpNode. So these routes call it themselves; with no
    // middleware configured they answer this computer only.
    const guard = (req, res, next) => {
        const mw = RED.settings.httpNodeMiddleware;
        const chain = (Array.isArray(mw) ? mw : [mw]).filter((f) => typeof f === "function");
        if (!chain.length) {
            const ip = (req.socket && req.socket.remoteAddress) || "";
            return /^(::1|127\.|::ffff:127\.)/.test(ip) ? next() : res.status(403).json({ error: "no password is set up on this edge: local access only" });
        }
        let i = 0;
        const step = (err) => (err ? next(err) : i < chain.length ? chain[i++](req, res, step) : next());
        step();
    };
    RED.httpNode.use("/api/panel", guard);
    // A small JSON body reader (at most 20 kB), so the palette needs no web framework of its own.
    const json = (req, res, next) => {
        if (req.body && typeof req.body === "object") return next();
        let size = 0; const parts = [];
        req.on("data", (d) => { size += d.length; if (size <= 20000) parts.push(d); });
        req.on("end", () => {
            if (size > 20000) return res.status(413).json({ error: "too large" });
            try { req.body = parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {}; } catch (_) { return res.status(400).json({ error: "not JSON" }); }
            next();
        });
    };
    // The edge's own addresses on the home network, so a QR code made from
    // http://localhost still points the phones at something they can reach.
    // (Node-RED runs with the host's network; Docker's bridges are left out.)
    const lanAddresses = () => {
        const out = [];
        for (const [name, list] of Object.entries(os.networkInterfaces())) {
            if (/^(docker|br-|veth|virbr|lo)/.test(name)) continue;
            for (const a of list || []) {
                if (a.family === "IPv4" && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) out.push(a.address);
            }
        }
        return out;
    };
    const need = (res) => { if (engine) return true; res.status(503).json({ error: "the panel node is not running" }); return false; };

    RED.httpNode.get("/api/panel/codes", (req, res) => {
        if (!need(res)) return;
        res.json(Object.assign({ ws_port: engine.wsPort, lan: lanAddresses() }, engine.list()));
    });
    RED.httpNode.post("/api/panel/codes", json, (req, res) => {
        if (!need(res)) return;
        engine.createCode(req.body || {}).then(
            (made) => res.json({ code: made.code, secret: made.secret, ws_port: engine.wsPort }),
            (err) => res.status(400).json({ error: err.message }));
    });
    RED.httpNode.get("/api/panel/bell", (req, res) => { if (need(res)) res.json(engine.bellSettings()); });
    RED.httpNode.put("/api/panel/bell", json, (req, res) => {
        if (!need(res)) return;
        try { engine.registry.setBell(req.body || {}); res.json(engine.bellSettings()); } catch (err) { res.status(400).json({ error: err.message }); }
    });
    RED.httpNode.post("/api/panel/bell/test", (req, res) => { if (need(res)) res.json({ targets: engine.setOffBell("test") }); });
    RED.httpNode.delete("/api/panel/codes/:id", (req, res) => {
        if (!need(res)) return;
        engine.revokeCode(req.params.id).then(
            (found) => (found ? res.json({ status: "ok" }) : res.status(404).json({ error: "no such code" })),
            (err) => res.status(400).json({ error: err.message }));
    });
};
