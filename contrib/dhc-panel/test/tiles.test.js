import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import tiles from "../lib/tiles.js";
import dynsec from "../lib/dynsec.js";
import registry from "../lib/registry.js";
import fixture from "./fixture.js";

const catalog = tiles.buildCatalog(fixture.graph);
const labels = (list) => list.map((t) => t.label).sort();

describe("the tiles read from the twin", () => {
    it("takes only what a person switches", () => {
        expect(labels(catalog.tiles)).toEqual([
            "Bedroom blind", "Bedroom heating", "Bedroom lamp",
            "Kitchen ceiling 1", "Kitchen ceiling 2", "Kitchen counter", "Lounge lamp", "Lounge plug",
        ]);
    });
    it("never offers a siren, a contact, a chime or the CCU's copy of a Hue light", () => {
        expect(catalog.tiles.some((t) => /ASIR|Sec-SC|OU-CF|VIR-/.test(t.ref))).toBe(false);
    });
    it("offers a chime to the bell, never as a tile", () => {
        expect(catalog.chimes.map((c) => c.label + " " + c.ref)).toEqual(["Chime 1 HM-OU-CF-Pl Chime:1/STATE", "Chime 2 HM-OU-CF-Pl Chime:2/STATE"]);
        expect(registry.cleanBell({ lights: ["0123456789", "x", 7], chimes: "no" })).toEqual({ lights: ["0123456789"], chimes: [] });
    });
    it("uses the real output channel of an HmIP switch", () => {
        expect(catalog.tiles.find((t) => t.label === "Kitchen counter").ref).toBe("HmIP-BSM Kitchen counter:4/STATE");
    });
    it("knows kinds, functions and the thermostat's temperature", () => {
        const by = (l) => catalog.tiles.find((t) => t.label === l);
        expect(by("Lounge lamp")).toMatchObject({ kind: "dimmer", func: "light", source: "hue", ref: "00:17:88:01:aa-0b" });
        expect(by("Lounge plug")).toMatchObject({ kind: "switch" });
        expect(by("Bedroom heating")).toMatchObject({ kind: "thermostat", func: "heating", tempRef: "HM-CC-RT-DN Bedroom heating:4/ACTUAL_TEMPERATURE" });
        expect(catalog.floors).toEqual([0, 1]);
    });
    it("drops the type from a name and the floor number from a room", () => {
        const pub = tiles.publicTiles(catalog, catalog.tiles);
        expect(pub.find((t) => t.label === "Kitchen counter").room).toBe("Kitchen");
        expect(pub.some((t) => /^Hm|^HM-/.test(t.label))).toBe(false);
    });
    it("gives the phone no device references", () => {
        const pub = tiles.publicTiles(catalog, catalog.tiles);
        expect(Object.keys(pub[0]).sort()).toEqual(["func", "id", "kind", "label", "room"]);
        expect(JSON.stringify(pub)).not.toMatch(/STATE|00:17:88/);
    });
});

describe("room names", () => {
    it("drops the CCU's sort numbers before the name, nothing else", () => {
        expect(tiles.plainRoom("0.Kitchen")).toBe("Kitchen");
        expect(tiles.plainRoom("1.6 Garden")).toBe("Garden");
        expect(tiles.plainRoom("2.3. Bath")).toBe("Bath");
        expect(tiles.plainRoom("Living room")).toBe("Living room");
        expect(tiles.plainRoom("3 Kings")).toBe("3 Kings");
        expect(tiles.plainRoom("12.")).toBe("12.");
    });
});

describe("scopes", () => {
    const room = (label) => catalog.rooms.find((r) => r.label === label).id;
    it("by floor", () => {
        expect(labels(tiles.tilesForScope(catalog, { floors: [0] }))).toEqual(["Kitchen ceiling 1", "Kitchen ceiling 2", "Kitchen counter"]);
    });
    it("by room, and a floor plus a room", () => {
        expect(labels(tiles.tilesForScope(catalog, { rooms: [room("Lounge")] }))).toEqual(["Lounge lamp", "Lounge plug"]);
        expect(tiles.tilesForScope(catalog, { floors: [0], rooms: [room("Lounge")] })).toHaveLength(5);
    });
    it("by function, alone and within a floor", () => {
        expect(labels(tiles.tilesForScope(catalog, { kinds: ["heating"] }))).toEqual(["Bedroom heating"]);
        expect(labels(tiles.tilesForScope(catalog, { floors: [1], kinds: ["light"] }))).toEqual(["Bedroom lamp"]);
    });
    it("an empty scope is the whole house", () => {
        expect(tiles.tilesForScope(catalog, {})).toHaveLength(catalog.tiles.length);
    });
});

describe("actions", () => {
    const by = (l) => catalog.tiles.find((t) => t.label === l);
    it("fits the action to the tile and clamps values", () => {
        expect(tiles.commandFor(by("Lounge plug"), "on")).toEqual({ set: "on", value: true });
        expect(tiles.commandFor(by("Lounge plug"), "level", 50)).toBeNull();
        expect(tiles.commandFor(by("Lounge lamp"), "level", 250)).toEqual({ set: "level", value: 100 });
        expect(tiles.commandFor(by("Bedroom blind"), "on")).toBeNull();
        expect(tiles.commandFor(by("Bedroom heating"), "setpoint", 21.3)).toEqual({ set: "setpoint", value: 21.5 });
        expect(tiles.commandFor(by("Bedroom heating"), "setpoint", 99)).toEqual({ set: "setpoint", value: 28 });
        expect(tiles.commandFor(by("Bedroom heating"), "setpoint", "x")).toBeNull();
        expect(tiles.commandFor(by("Lounge lamp"), "explode")).toBeNull();
    });
});

describe("the codes file and the broker's rules", () => {
    it("keeps no secret, cleans the scope, survives a reload", () => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "panel-")), "codes.json");
        const reg = new registry.Registry(file);
        const { code, secret } = reg.create({ name: " Ground floor ", scope: { floors: [0, "x"], rooms: ["nope"], kinds: ["light", "doors"] }, bell: "listen", lang: "de" }, catalog);
        expect(code).toMatchObject({ name: "Ground floor", scope: { none: false, floors: [0], rooms: [], kinds: ["light"] }, bell: "listen", kind: "panel", lang: "de" });
        expect(secret).toMatch(/^[0-9a-f]{32}$/);
        expect(fs.readFileSync(file, "utf8")).not.toContain(secret);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(new registry.Registry(file).get(code.id).name).toBe("Ground floor");
        expect(() => reg.create({ name: "" })).toThrow();
        // a code that rings sits outside the door: whatever was asked, it gets no tiles
        const door = reg.create({ name: "Door", bell: "ring", scope: { floors: [0] } }, catalog).code;
        expect(tiles.tilesForScope(catalog, door.scope)).toEqual([]);
        expect(tiles.tilesForScope(catalog, { none: true, floors: [0] })).toEqual([]);
        expect(reg.remove(code.id)).toBe(true);
        expect(reg.remove(code.id)).toBe(false);
    });
    it("lets a code write only what its role needs", () => {
        const sends = (code) => dynsec.aclsFor(Object.assign({ id: "pabc" }, code)).filter((a) => a.acltype === "publishClientSend").map((a) => a.topic.split("/").slice(3).join("/"));
        expect(sends({ bell: "none", kind: "panel" })).toEqual(["act", "status"]);
        expect(sends({ bell: "listen", kind: "panel" })).toEqual(["act", "status", "answer"]);
        expect(sends({ bell: "ring", kind: "phone" })).toEqual(["act", "status", "ring", "up/#"]);
        expect(dynsec.aclsFor({ id: "pabc" })[0]).toMatchObject({ acltype: "subscribePattern", topic: "dhc/panel/pabc/#" });
    });
});
