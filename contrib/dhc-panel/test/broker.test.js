// The engine and the phone page's own MQTT client against a real Mosquitto
// with Dynamic Security: what a code may read and write is the broker's job,
// so only a real broker can prove it.
//
// Runs when MOSQUITTO_BIN names the broker (and MOSQUITTO_CTRL, MOSQUITTO_PLUGIN
// its tools); skipped otherwise. See README.md.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import mqtt from "mqtt";
import engineLib from "../lib/engine.js";
import fixture from "./fixture.js";
import tinymqtt from "../../../webapp/static/panel/tinymqtt.js";

const BIN = process.env.MOSQUITTO_BIN;
const TCP = 18830 + Math.floor(Math.random() * 500), WS = TCP + 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (test, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (test()) return true; await sleep(25); } return false; };

/** A phone: the page's client, keeping what it received. */
function phone(id, secret) {
    const got = [], p = { got, up: false, down: null };
    p.link = tinymqtt({
        url: "ws://127.0.0.1:" + WS, username: id, password: secret,
        will: { topic: "dhc/panel/" + id + "/status", payload: '{"state":"offline"}', retain: true },
        onUp: () => { p.up = true; p.link.publish("dhc/panel/" + id + "/status", '{"state":"online"}', true); },
        onDown: (why) => { p.up = false; p.down = why; },
        onMessage: (topic, text) => got.push({ topic, body: text ? JSON.parse(text) : null }),
    });
    p.last = (leaf) => { const m = got.filter((g) => g.topic.endsWith("/" + leaf)); return m.length ? m[m.length - 1].body : undefined; };
    p.events = () => got.filter((g) => g.topic.endsWith("/event")).map((g) => g.body);
    p.send = (leaf, body) => p.link.publish("dhc/panel/" + id + "/" + leaf, JSON.stringify(body || {}));
    return p;
}

describe.skipIf(!BIN)("the panel on a real broker", () => {
    let dir, broker, engine, acts = [], rings = [];
    const phones = [];
    const start = () => {
        engine = new engineLib.Engine({ mqtt, brokerUrl: "mqtt://127.0.0.1:" + TCP, username: "dhe-nodered", password: "admin-pw", registryFile: path.join(dir, "codes.json"), cboxFile: path.join(dir, "cbox.jsonld") });
        engine.on("act", (a) => acts.push(a)); engine.on("ring", (r) => rings.push(r));
        engine.start();
    };
    const join = async (input) => { const { code, secret } = await engine.createCode(input); const p = phone(code.id, secret); p.id = code.id; p.secret = secret; p.link.subscribe("dhc/panel/" + code.id + "/#"); phones.push(p); expect(await until(() => p.up && p.last("scope"))).toBe(true); return p; };

    beforeAll(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-broker-"));
        fs.writeFileSync(path.join(dir, "cbox.jsonld"), JSON.stringify(fixture.cbox));
        execFileSync(process.env.MOSQUITTO_CTRL, ["dynsec", "init", path.join(dir, "dynsec.json"), "dhe-nodered", "admin-pw"]);
        fs.writeFileSync(path.join(dir, "m.conf"), ["allow_anonymous false", "plugin " + process.env.MOSQUITTO_PLUGIN, "plugin_opt_config_file " + path.join(dir, "dynsec.json"),
            "listener " + TCP + " 127.0.0.1", "listener " + WS + " 127.0.0.1", "protocol websockets", ""].join("\n"));
        broker = spawn(BIN, ["-c", path.join(dir, "m.conf")], { stdio: "ignore" });
        await sleep(600);
        start();
        // the first start adds Node-RED's own right to publish, which costs one reconnect
        expect(await until(() => engine.connected, 15000)).toBe(true);
    }, 30000);
    afterAll(async () => { phones.forEach((p) => p.link.close()); if (engine) await engine.stop(); if (broker) broker.kill(); });

    it("gives a phone its tiles and their state, and nothing of another code", async () => {
        const ground = await join({ name: "Ground floor", scope: { floors: [0] } });
        const upstairs = await join({ name: "Upstairs", scope: { floors: [1] } });
        expect(ground.last("scope")).toMatchObject({ name: "Ground floor", bell: "none" });
        expect(ground.last("scope").tiles.map((t) => t.label).sort()).toEqual(["Kitchen ceiling 1", "Kitchen ceiling 2", "Kitchen counter"]);
        // a phone asking for everything, or for another code's topics, gets only its own
        upstairs.link.subscribe("#"); upstairs.link.subscribe("dhc/panel/" + ground.id + "/#");
        engine.setValues("ccu", { "HmIP-BSM Kitchen counter:4/STATE": true });
        const bsm = ground.last("scope").tiles.find((t) => t.label === "Kitchen counter").id;
        expect(await until(() => ground.last("state")[bsm] && ground.last("state")[bsm].on === true)).toBe(true);
        await sleep(200);
        expect(upstairs.got.every((g) => g.topic.startsWith("dhc/panel/" + upstairs.id + "/"))).toBe(true);
    });

    it("turns a tap into a checked device command and shows the new state at once", async () => {
        const p = phones[0], tile = p.last("scope").tiles.find((t) => t.label === "Kitchen ceiling 2");
        acts.length = 0;
        p.send("act", { tile: tile.id, action: "on" });
        expect(await until(() => acts.length === 1)).toBe(true);
        expect(acts[0]).toMatchObject({ source: "ccu", ref: "HM-LC-Sw2-FM Kitchen ceiling:2/STATE", set: "on", value: true, name: "Ground floor" });
        expect(await until(() => p.last("state")[tile.id].on === true)).toBe(true);
    });

    it("refuses a tile outside the scope, a wrong action, and writing as another code", async () => {
        const [ground, upstairs] = phones;
        const foreign = upstairs.last("scope").tiles[0];
        acts.length = 0;
        ground.send("act", { tile: foreign.id, action: "on" });
        expect(await until(() => ground.events().some((e) => e.t === "refused" && /scope/.test(e.why)))).toBe(true);
        ground.send("act", { tile: ground.last("scope").tiles[0].id, action: "setpoint", value: 30 });
        expect(await until(() => ground.events().some((e) => e.t === "refused" && /cannot/.test(e.why)))).toBe(true);
        // the broker drops what a code publishes outside its own topics
        ground.link.publish("dhc/panel/" + upstairs.id + "/act", JSON.stringify({ tile: foreign.id, action: "on" }));
        ground.link.publish("dhc/panel/" + ground.id + "/scope", "{}", true);
        ground.link.publish("dhc/panel/" + ground.id + "/ring", "{}");
        await sleep(300);
        expect(acts).toHaveLength(0);
        expect(rings).toHaveLength(0);
        expect(ground.last("scope").name).toBe("Ground floor");
    });

    it("rings the listening phones and carries the answer back to the door", async () => {
        const door = await join({ name: "Front door", bell: "ring", scope: { floors: [0] } });
        const room = await join({ name: "My room", bell: "listen", scope: { floors: [1] } });
        await until(() => engine.online.get(room.id));
        expect(door.last("scope").tiles).toHaveLength(0);
        // the house's own bell: one Hue lamp blinks, the chime sounds
        const lamp = engine.catalog.tiles.find((t) => t.label === "Lounge lamp"), gong = engine.catalog.chimes.find((c) => c.ref.endsWith(":2/STATE"));
        engine.registry.setBell({ lights: [lamp.id, engine.catalog.tiles.find((t) => t.source === "ccu").id], chimes: [gong.id] });
        expect(engine.bellSettings().options.lights.map((l) => l.label)).toEqual(["Lounge lamp", "Lounge plug"]);
        acts.length = 0;
        door.send("ring");
        expect(await until(() => acts.length === 2)).toBe(true);
        expect(acts.map((a) => a.source + " " + a.set + " " + a.ref)).toEqual(["hue alert 00:17:88:01:aa-0b", "ccu on HM-OU-CF-Pl Chime:2/STATE"]);
        expect(rings[0].targets).toBe(2);
        expect(await until(() => room.events().some((e) => e.t === "ring" && e.from === "Front door"))).toBe(true);
        expect(await until(() => door.events().some((e) => e.t === "rung" && e.listeners === 1))).toBe(true);
        door.send("ring");                                    // a second ring at once is dropped
        await sleep(200);
        expect(rings).toHaveLength(1);
        room.send("answer", { answer: "coming" });
        expect(await until(() => door.events().some((e) => e.t === "answer" && e.answer === "coming" && e.by === "My room"))).toBe(true);
        expect(phones[0].events().some((e) => e.t === "ring")).toBe(false);   // a code that does not listen hears nothing
        door.send("answer", { answer: "leave" });             // the door may not answer
        await sleep(200);
        expect(door.events().filter((e) => e.t === "answer")).toHaveLength(1);
    });

    it("knows which phones are there", async () => {
        const p = phones[1];
        expect(engine.list().codes.find((c) => c.id === p.id).online).toBe(true);
        p.link.close();
        expect(await until(() => engine.list().codes.find((c) => c.id === p.id).online === false)).toBe(true);
    });

    it("keeps the codes working when Node-RED restarts", async () => {
        const p = phones[0];
        await engine.stop();
        start();
        expect(await until(() => engine.connected)).toBe(true);
        acts.length = 0;
        p.send("act", { tile: p.last("scope").tiles[0].id, action: "off" });
        expect(await until(() => acts.length === 1)).toBe(true);
    });

    it("shuts a revoked code out for good", async () => {
        const p = phones[0];
        expect(await engine.revokeCode(p.id)).toBe(true);
        expect(await until(() => !p.up)).toBe(true);
        expect(await until(() => p.down === "refused", 20000)).toBe(true);
        expect(engine.list().codes.some((c) => c.id === p.id)).toBe(false);
        expect(await engine.revokeCode(p.id)).toBe(false);
        const stranger = phone("nobody", "guess"); phones.push(stranger);
        expect(await until(() => stranger.down === "refused")).toBe(true);
    }, 30000);
});
