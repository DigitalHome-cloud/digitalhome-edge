#!/usr/bin/env node
// dhc-door — the door station adapter: an old analog outdoor station as an MQTT device of the edge.
//
// Runs on a small computer at the station's cable (a Raspberry Pi). It holds one code of kind
// "door" (made in the edge portal: Scan and control → Codes) and speaks MQTT over WebSocket to
// the edge's broker, like a phone:
//
//   the station's button      → ring                           (a line from ring_cmd, e.g. gpiomon)
//   event { t: "watch", s }   → JPEG frames on frame for s seconds (from video_cmd, e.g. ffmpeg)
//   event { t: "answer", a }  → a voice clip on the station's speaker (play_cmd, e.g. aplay)
//
// The edge decides who hears the ring and sees the pictures; this side keeps nothing.
// No door opener: the lock is not wired (docs/specs/panel-scan-and-control.md → Door station).
//
//   node index.js [--config /etc/dhc-door/config.json] [--fake]
//
// --fake: a test picture instead of the camera, Enter rings, clips are printed instead of played.
// SIGUSR2 rings too (kill -USR2 <pid>): a test of the whole chain without touching the button.

"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const mqtt = require("mqtt");

const ANSWERS = ["coming", "wait", "leave"];
const DEBOUNCE_MS = 1500;

const args = process.argv.slice(2);
const fake = args.includes("--fake");
const at = args.indexOf("--config");
const configFile = at >= 0 && args[at + 1] ? args[at + 1] : "/etc/dhc-door/config.json";

// ── config ──────────────────────────────────────────────────────────────────

const DEFAULTS = {
    // the link the portal shows for this code: http://<edge>:1880/app/panel/#c=<id>.<secret>&l=fr
    link: "",
    // one line on stdout per button press (libgpiod 1.x; BCM 17, opto pulls it low)
    ring_cmd: "gpiomon --falling-edge gpiochip0 17",
    // a stream of JPEGs on stdout
    video_cmd: "ffmpeg -loglevel error -f v4l2 -i /dev/video0 -vf scale=640:-2,fps=3 -q:v 7 -f image2pipe -c:v mjpeg -",
    // {file} is replaced by the clip
    play_cmd: "aplay -q {file}",
    // Optional: switch the station's camera power (e.g. a MOSFET on BCM 27: "pinctrl set 27 op dh" / "… dl").
    // Empty: the camera stays powered. Only set them if the button still rings with the camera off
    // (README → Camera power): otherwise switching it off silences the bell too.
    camera_on_cmd: "",
    camera_off_cmd: "",
    camera_warmup_ms: 1500,
    clips: path.join(__dirname, "clips"),
};
const FAKE = {
    video_cmd: "ffmpeg -loglevel error -re -f lavfi -i testsrc=size=640x360:rate=3 -vf drawtext=text='%{localtime}':fontsize=28:x=20:y=20:fontcolor=white -q:v 7 -f image2pipe -c:v mjpeg -",
};

function readConfig() {
    let file = {};
    try { file = JSON.parse(fs.readFileSync(configFile, "utf8")); } catch (err) { if (!fake || process.env.DHC_DOOR_LINK == null) die("cannot read " + configFile + ": " + err.message); }
    const c = Object.assign({}, DEFAULTS, fake ? FAKE : {}, file);
    if (process.env.DHC_DOOR_LINK) c.link = process.env.DHC_DOOR_LINK;
    const m = /^https?:\/\/([^/:#]+)(?::\d+)?\/.*#(.*)$/.exec(c.link || "");
    if (!m) die("config: link must be the link the portal shows for the door code (http://<edge>:1880/app/panel/#c=…)");
    const q = {};
    for (const kv of m[2].split("&")) { const i = kv.indexOf("="); if (i > 0) q[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); }
    const [id, secret] = String(q.c || "").split(".");
    if (!/^p[0-9a-f]{12}$/.test(id || "") || !/^[0-9a-f]{32}$/.test(secret || "")) die("config: the link carries no valid code");
    return Object.assign(c, { host: m[1], port: parseInt(q.p || "9001", 10), id, secret, lang: ["en", "de", "fr"].includes(q.l) ? q.l : "en" });
}

function die(text) { console.error("dhc-door: " + text); process.exit(2); }
const log = (text) => console.log(new Date().toISOString() + " " + text);   // never the secret

const cfg = readConfig();
const topic = (leaf) => "dhc/panel/" + cfg.id + "/" + leaf;

// ── the link to the edge ────────────────────────────────────────────────────

const link = mqtt.connect("ws://" + cfg.host + ":" + cfg.port, {
    username: cfg.id, password: cfg.secret, clientId: "dhc-door-" + cfg.id, clean: true,
    reconnectPeriod: 5000, connectTimeout: 10000, protocolVersion: 4,
    will: { topic: topic("status"), payload: JSON.stringify({ state: "offline" }), retain: true, qos: 0 },
});
let refused = false;
link.on("connect", () => {
    log("linked to " + cfg.host + ":" + cfg.port + " as " + cfg.id);
    link.subscribe(topic("event"));
    link.publish(topic("status"), JSON.stringify({ state: "online", kind: "door" }), { retain: true });
});
let stopping = false;
link.on("close", () => { if (!refused && !stopping) log("link lost, trying again"); });
link.on("error", (err) => {
    if (/Not authorized|Bad username/i.test(err.message)) { refused = true; log("the edge refused this code (revoked?): stopping"); link.end(true); process.exit(3); }
    log("link: " + err.message);
});
link.on("message", (t, payload) => {
    let e; try { e = JSON.parse(payload.toString("utf8")); } catch (_) { return; }
    if (e.t === "watch") watch(Number(e.seconds) || 0);
    else if (e.t === "answer" && ANSWERS.includes(e.answer)) say(e.answer, e.by);
    else if (e.t === "rung") log("rung: " + e.listeners + " phone(s) listening");
});

// ── the button ──────────────────────────────────────────────────────────────

let lastRing = 0;
function ring(why) {
    const now = Date.now();
    if (now - lastRing < DEBOUNCE_MS) return;
    lastRing = now;
    log("ring (" + why + ")");
    if (link.connected) link.publish(topic("ring"), "{}");
    else log("not linked: the ring is lost");
}

function startButton() {
    if (fake) {
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", () => ring("Enter"));
        log("fake: press Enter to ring");
        return;
    }
    const child = run(cfg.ring_cmd);
    child.stdout.setEncoding("utf8");
    let rest = "";
    child.stdout.on("data", (d) => { rest += d; const lines = rest.split("\n"); rest = lines.pop(); if (lines.some((l) => l.trim())) ring("button"); });
    child.on("exit", (code) => { log("ring_cmd ended (" + code + "), starting it again in 5 s"); setTimeout(startButton, 5000); });
}

// ── the camera ──────────────────────────────────────────────────────────────

let video = null, warming = null, stopAt = 0, stopTimer = null, sent = 0;
function watch(seconds) {
    clearTimeout(stopTimer);
    if (seconds <= 0) return stopVideo("asked to stop");
    stopAt = Date.now() + seconds * 1000;
    stopTimer = setTimeout(() => stopVideo("window over"), seconds * 1000);
    if (video || warming) return log("watch: " + seconds + " s more");
    log("watch: pictures for " + seconds + " s");
    sent = 0;
    if (!cfg.camera_on_cmd) return startVideo();
    run(cfg.camera_on_cmd);
    warming = setTimeout(() => { warming = null; if (Date.now() < stopAt) startVideo(); }, Number(cfg.camera_warmup_ms) || 0);
}

function startVideo() {
    video = run(cfg.video_cmd);
    let buf = Buffer.alloc(0);
    video.stdout.on("data", (d) => {
        buf = buf.length ? Buffer.concat([buf, d]) : d;
        // ffmpeg's mjpeg: whole JPEGs one after the other, each from FF D8 to FF D9
        for (;;) {
            const start = buf.indexOf(SOI);
            if (start < 0) { buf = Buffer.alloc(0); break; }
            const end = buf.indexOf(EOI, start + 2);
            if (end < 0) { if (start > 0) buf = buf.subarray(start); break; }
            const jpeg = buf.subarray(start, end + 2);
            buf = buf.subarray(end + 2);
            if (link.connected && Date.now() < stopAt && jpeg.length <= 150000) { link.publish(topic("frame"), Buffer.from(jpeg)); sent++; }
        }
    });
    video.on("exit", () => { video = null; });
}
const SOI = Buffer.from([0xff, 0xd8]), EOI = Buffer.from([0xff, 0xd9]);

function stopVideo(why) {
    if (warming) { clearTimeout(warming); warming = null; }
    if (video) {
        log("pictures stopped (" + why + "), " + sent + " sent");
        video.kill("SIGTERM");
        video = null;
    }
    if (cfg.camera_off_cmd) run(cfg.camera_off_cmd);
}

// ── the voice ───────────────────────────────────────────────────────────────

function say(answer, by) {
    const file = path.join(cfg.clips, cfg.lang, answer + ".wav");
    log("answer from " + (by || "?") + ": " + answer);
    if (fake) return log("fake: would play " + file);
    if (!fs.existsSync(file)) return log("no clip " + file + " (run make-clips.sh)");
    run(cfg.play_cmd.replace("{file}", file));
}

// ── helpers ─────────────────────────────────────────────────────────────────

function run(cmd) {
    const child = spawn("/bin/sh", ["-c", "exec " + cmd], { stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { const t = d.trim(); if (t) log("[" + cmd.split(" ")[0] + "] " + t.slice(0, 300)); });
    child.on("error", (err) => log("cannot start " + cmd.split(" ")[0] + ": " + err.message));
    return child;
}

function shutdown() {
    stopping = true;
    stopVideo("shutting down");
    if (link.connected) link.publish(topic("status"), JSON.stringify({ state: "offline" }), { retain: true }, () => link.end(false, {}, () => process.exit(0)));
    else process.exit(0);
    setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGUSR2", () => ring("signal"));

if (cfg.camera_off_cmd) run(cfg.camera_off_cmd);   // at rest the camera is off
startButton();
