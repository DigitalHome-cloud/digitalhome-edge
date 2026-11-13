import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import tiles from "../lib/tiles.js";
import labelsLib from "../lib/labels.js";
import fixture from "./fixture.js";

const { Labels } = labelsLib;
const catalog = tiles.buildCatalog(fixture.graph);
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dhc-labels-")), "labels.json");

describe("the label dictionary", () => {
    it("keys on the name the home shows and falls back to it", () => {
        const l = new Labels(tmp());
        expect(l.tr("Kitchen counter", "fr")).toBe("Kitchen counter");
        expect(l.set({ "Kitchen counter": { fr: " Plan de travail ", de: "Arbeitsplatte" } })).toBe(1);
        expect(l.tr("Kitchen counter", "fr")).toBe("Plan de travail");
        expect(l.tr("Kitchen counter", "en")).toBe("Kitchen counter");
    });
    it("is kept 0600, sorted, and read back", () => {
        const file = tmp();
        new Labels(file).set({ Lounge: { de: "Wohnzimmer" }, Bedroom: { fr: "Chambre" } });
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).labels)).toEqual(["Bedroom", "Lounge"]);
        expect(new Labels(file).tr("Lounge", "de")).toBe("Wohnzimmer");
    });
    it("removes a language with an empty string and the entry with the last one; a same value is no change", () => {
        const l = new Labels(tmp());
        l.set({ Lounge: { de: "Wohnzimmer", fr: "Salon" } });
        expect(l.set({ Lounge: { de: "Wohnzimmer" } })).toBe(0);
        l.set({ Lounge: { de: "" } });
        expect(l.labels.Lounge).toEqual({ fr: "Salon" });
        l.set({ Lounge: { fr: "" } });
        expect(l.labels.Lounge).toBeUndefined();
    });
    it("refuses what is not a dictionary and survives a broken file", () => {
        expect(() => new Labels(tmp()).set(["x"])).toThrow();
        const file = tmp(); fs.writeFileSync(file, "{ not json");
        const l = new Labels(file);
        expect(l.error).toBeTruthy();
        expect(l.tr("Lounge", "de")).toBe("Lounge");
    });
    it("lists every word of the home once, translated words that left the twin last", () => {
        const l = new Labels(tmp());
        l.set({ "Old room": { de: "Alter Raum" }, Bedroom: { fr: "Chambre" } });
        const e = l.entries(tiles.homeWords(catalog));
        const bedroom = e.find((x) => x.original === "Bedroom");
        expect(bedroom.where).toEqual(["room"]);
        expect(bedroom.fr).toBe("Chambre");
        expect(e.find((x) => x.original === "Kitchen counter").rooms).toEqual(["Kitchen"]);
        expect(e[e.length - 1]).toMatchObject({ original: "Old room", where: [], de: "Alter Raum" });
        expect(new Set(e.map((x) => x.original)).size).toBe(e.length);
    });
    it("shows each word with its name in the CCU or Hue, and lists the devices that are no tiles", () => {
        const e = new Labels(tmp()).entries(tiles.homeWords(catalog));
        expect(e.find((x) => x.original === "Kitchen counter").names).toEqual(["HmIP-BSM Kitchen counter:4"]);
        expect(e.find((x) => x.original === "Kitchen").names).toEqual(["0.Kitchen"]);
        const other = e.filter((x) => x.where.includes("other"));
        expect(other.length).toBeGreaterThan(0);
        expect(other.some((x) => x.names.some((n) => /^VIR-/.test(n)))).toBe(false);
        expect(tiles.publicTiles(catalog, catalog.tiles).some((t) => "name" in t)).toBe(false);
    });
    it("gives a phone its tiles and rooms in its language", () => {
        const l = new Labels(tmp());
        l.set({ Kitchen: { fr: "Cuisine" }, "Kitchen counter": { fr: "Plan de travail" } });
        const pub = tiles.publicTiles(catalog, catalog.tiles, (w) => l.tr(w, "fr"));
        expect(pub.find((t) => t.label === "Plan de travail").room).toBe("Cuisine");
        expect(tiles.publicTiles(catalog, catalog.tiles).some((t) => t.label === "Kitchen counter")).toBe(true);
    });
});
