// tiles.js — what a phone may show and switch, read from the twin (cbox.jsonld).
//
// The twin lists every point a device reports. Only a few of them are things
// a person switches, and some must never be on a phone (sirens, contacts).
// So this is a whitelist: a device type that is not named here gives no tile.

"use strict";

const crypto = require("crypto");

// Homematic: device type (the first word of the CCU device name) -> the
// channels a person switches. `channels: null` takes every channel that has
// the datapoint (multi-channel actuators); a list names the real output
// channel of HmIP devices, whose other STATE channels are status or virtual.
const CCU_RULES = [
    { match: /^HM-LC-Sw/,                     kind: "switch",     dp: "STATE", channels: null },
    { match: /^HM-ES-PMSw/,                   kind: "switch",     dp: "STATE", channels: ["1"] },
    { match: /^HmIP-(BSM|BSL)$/,              kind: "switch",     dp: "STATE", channels: ["4"] },
    { match: /^HmIP-FSM/,                     kind: "switch",     dp: "STATE", channels: ["2"] },
    { match: /^HmIP-(PS|PSM)/,                kind: "switch",     dp: "STATE", channels: ["3"] },
    { match: /^HM-LC-Dim/,                    kind: "dimmer",     dp: "LEVEL", channels: null },
    { match: /^HM-LC-Bl/,                     kind: "blind",      dp: "LEVEL", channels: null },
    { match: /^HM-CC-RT-DN/,                  kind: "thermostat", dp: "SET_TEMPERATURE",       channels: ["4"], temp: "ACTUAL_TEMPERATURE" },
    { match: /^HmIP-(STHD?|eTRV|WTH)/,        kind: "thermostat", dp: "SET_POINT_TEMPERATURE", channels: ["1"], temp: "ACTUAL_TEMPERATURE" },
];

// Bell targets, never tiles: a Homematic chime. Each channel is offered by itself
// (HM-OU-CF-Pl: 1 is its light, 2 its sound); setting STATE plays what the CCU has configured.
const CHIME_RULES = [
    { match: /^HM-OU-CF-Pl/, dp: "STATE", channels: ["1", "2"] },
    { match: /^HmIP-MP3P/, dp: "STATE", channels: ["2"] },
];

// The function a tile belongs to, for scopes "by function".
const KINDS = ["light", "switch", "blind", "heating"];
const KIND_OF = { dimmer: "light", switch: "switch", blind: "blind", thermostat: "heating" };

function shortId(text) {
    return crypto.createHash("sha1").update(String(text)).digest("hex").slice(0, 10);
}

// "HmIP-BSM Kitchen counter" -> "Kitchen counter": CCU names often start with the device type.
function plainName(name, type) {
    const n = String(name || "");
    const rest = type && n.startsWith(type) ? n.slice(type.length).replace(/^[\s:_-]+/, "") : n;
    return rest || n;
}

// "0.Kitchen" -> "Kitchen": the floor number some homes put before a room's name.
function plainRoom(label) { return String(label || "").replace(/^\d+\.\s*/, "") || String(label || ""); }

function asList(v) { return v == null ? [] : (Array.isArray(v) ? v : [v]); }

// "ccu:<device name>:<channel>/<DATAPOINT>" -> { name, channel, dp }
function parseCcuRef(ref) {
    const m = /^ccu:(.*):(\d+)\/([A-Z_]+)$/.exec(ref || "");
    return m ? { name: m[1], channel: m[2], dp: m[3] } : null;
}

/**
 * Read the twin's graph into rooms and tiles.
 * A tile: { id, kind, func, label, room, floor, source, ref, tempRef? }
 *   ref (ccu): "<device name>:<channel>/<DATAPOINT>"; ref (hue): the light's uniqueid.
 */
function buildCatalog(graph) {
    const nodes = Array.isArray(graph) ? graph : [];
    const byId = new Map(nodes.map((n) => [n["@id"], n]));
    const rooms = [];
    for (const n of nodes) {
        if (n["@type"] !== "rec:Room") continue;
        const source = String(n["@id"]).split(":")[3] || "";
        rooms.push({ id: shortId(n["@id"]), uri: n["@id"], label: n["rec:label"] || "?", floor: n["dhc:floor"] != null ? n["dhc:floor"] : null, source });
    }
    const roomByUri = new Map(rooms.map((r) => [r.uri, r]));

    const tiles = [], chimes = [];
    for (const dev of nodes) {
        const points = asList(dev["brick:hasPoint"]).map((p) => byId.get(typeof p === "string" ? p : p && p["@id"])).filter(Boolean);
        if (!points.length) continue;
        const room = roomByUri.get(dev["rec:isLocatedIn"]) || null;
        const base = { room: room ? room.id : null, floor: room ? room.floor : null };

        if (dev["dhc:source"] === "hue") {
            const caps = new Set(points.map((p) => String(p["dhc:capability"] || "").split("/").pop()));
            if (!caps.has("on")) continue;
            const uid = String(dev["dhc:sourceRef"] || "").replace(/^hue:/, "");
            const isLight = dev["@type"] === "brick:Luminaire";
            const kind = caps.has("brightness") ? "dimmer" : "switch";
            tiles.push(Object.assign({ id: shortId(dev["@id"]), kind, func: isLight ? "light" : "switch", label: dev["rec:label"] || "?", source: "hue", ref: uid }, base));
            continue;
        }
        if (dev["dhc:source"] !== "ccu") continue;
        const refs = points.map((p) => parseCcuRef(p["dhc:sourceRef"])).filter(Boolean);
        const chime = CHIME_RULES.find((r) => r.match.test(dev["dhc:deviceType"] || ""));
        if (chime) {
            for (const hit of refs.filter((r) => r.dp === chime.dp && chime.channels.includes(r.channel))) {
                const ref = hit.name + ":" + hit.channel + "/" + hit.dp;
                chimes.push({ id: shortId("ccu:" + ref), label: plainName(dev["rec:label"] || hit.name, dev["dhc:deviceType"]) + " " + hit.channel, source: "ccu", ref });
            }
            continue;
        }
        const rule = CCU_RULES.find((r) => r.match.test(dev["dhc:deviceType"] || ""));
        if (!rule) continue;
        const hits = refs.filter((r) => r.dp === rule.dp && (!rule.channels || rule.channels.includes(r.channel)));
        const temp = rule.temp ? refs.find((r) => r.dp === rule.temp) : null;
        for (const hit of hits) {
            const ref = hit.name + ":" + hit.channel + "/" + hit.dp;
            const tile = Object.assign({
                id: shortId("ccu:" + ref), kind: rule.kind, func: KIND_OF[rule.kind],
                label: plainName(dev["rec:label"] || hit.name, dev["dhc:deviceType"]) + (hits.length > 1 ? " " + hit.channel : ""),
                source: "ccu", ref,
            }, base);
            if (temp) tile.tempRef = temp.name + ":" + temp.channel + "/" + temp.dp;
            tiles.push(tile);
        }
    }
    const floors = Array.from(new Set(rooms.map((r) => r.floor).filter((f) => f != null))).sort((a, b) => a - b);
    return { rooms, floors, tiles, chimes, kinds: KINDS };
}

/**
 * The tiles of one scope: { none, floors: [n], rooms: [roomId], kinds: [func] }.
 * none: no tiles at all (a bell only). No floors and no rooms: the whole house.
 * No kinds: every function.
 * A tile without a room belongs only to the whole house.
 */
function tilesForScope(catalog, scope) {
    const s = scope || {};
    if (s.none) return [];
    const floors = asList(s.floors), rooms = asList(s.rooms), kinds = asList(s.kinds);
    const everywhere = !floors.length && !rooms.length;
    return catalog.tiles.filter((t) => {
        if (kinds.length && !kinds.includes(t.func)) return false;
        if (everywhere) return true;
        return (t.room != null && rooms.includes(t.room)) || (t.floor != null && floors.includes(t.floor));
    });
}

/** What the phone gets: no device references, the room as a word, both in the phone's language (`tr`). */
function publicTiles(catalog, tiles, tr) {
    const say = tr || ((s) => s);
    const label = new Map(catalog.rooms.map((r) => [r.id, plainRoom(r.label)]));
    return tiles.map((t) => ({ id: t.id, kind: t.kind, func: t.func, label: say(t.label), room: t.room ? say(label.get(t.room)) : "" }));
}

/**
 * Check an action against its tile; returns the command for the device
 * writer, or null when the action does not fit the tile.
 */
function commandFor(tile, action, value) {
    const num = Number(value);
    if (action === "on" || action === "off") {
        if (tile.kind !== "switch" && tile.kind !== "dimmer") return null;
        return { set: "on", value: action === "on" };
    }
    if (action === "level") {
        if (tile.kind !== "dimmer" && tile.kind !== "blind") return null;
        if (!isFinite(num)) return null;
        return { set: "level", value: Math.round(Math.min(100, Math.max(0, num))) };
    }
    if (action === "setpoint") {
        if (tile.kind !== "thermostat" || !isFinite(num)) return null;
        return { set: "setpoint", value: Math.round(Math.min(28, Math.max(5, num)) * 2) / 2 };
    }
    return null;
}

/** Every word the home shows, as it is called in the CCU or the Hue app: the keys of the label dictionary. */
function homeWords(catalog) {
    const roomName = new Map(catalog.rooms.map((r) => [r.id, plainRoom(r.label)]));
    return [
        ...catalog.rooms.map((r) => ({ original: plainRoom(r.label), where: "room" })),
        ...catalog.tiles.map((t) => ({ original: t.label, where: "tile", room: t.room ? roomName.get(t.room) : "" })),
        ...(catalog.chimes || []).map((c) => ({ original: c.label, where: "chime" })),
    ];
}

module.exports = { buildCatalog, tilesForScope, publicTiles, homeWords, plainRoom, commandFor, parseCcuRef, shortId, KINDS, CCU_RULES };
