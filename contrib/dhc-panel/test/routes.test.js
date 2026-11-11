// The admin routes must sit behind the edge's password: Node-RED applies
// httpNodeMiddleware to HTTP In nodes only, so the palette has to call it.
import { describe, it, expect } from "vitest";
import palette from "../nodes/dhc-panel.js";

function load(settings) {
    const used = [], routes = [];
    const RED = { settings, nodes: { createNode() {}, registerType() {} },
        httpNode: { use: (path, fn) => used.push({ path, fn }), get: (p) => routes.push(p), post: (p) => routes.push(p), put: (p) => routes.push(p), delete: (p) => routes.push(p) } };
    palette(RED);
    return { used, routes };
}
function call(fn, ip) {
    const out = { passed: false, status: 0 };
    const res = { status(c) { out.status = c; return this; }, json() { return this; }, send() { return this; }, set() { return this; } };
    fn({ socket: { remoteAddress: ip }, headers: {}, path: "/codes" }, res, () => { out.passed = true; });
    return out;
}

describe("the admin routes", () => {
    it("are all under the one guarded prefix", () => {
        const { used, routes } = load({});
        expect(used.map((u) => u.path)).toEqual(["/api/panel"]);
        expect(routes.length).toBeGreaterThan(4);
        expect(routes.every((r) => r.startsWith("/api/panel/"))).toBe(true);
    });
    it("run the edge's auth middleware, which can refuse", () => {
        const deny = (req, res) => res.status(401).send();
        expect(call(load({ httpNodeMiddleware: deny }).used[0].fn, "192.168.1.50")).toEqual({ passed: false, status: 401 });
        expect(call(load({ httpNodeMiddleware: [(q, r, n) => n(), deny] }).used[0].fn, "127.0.0.1")).toEqual({ passed: false, status: 401 });
        expect(call(load({ httpNodeMiddleware: (q, r, n) => n() }).used[0].fn, "192.168.1.50").passed).toBe(true);
    });
    it("answer only this computer when no password is set up", () => {
        const guard = load({}).used[0].fn;
        expect(call(guard, "192.168.1.50")).toEqual({ passed: false, status: 403 });
        expect(call(guard, "127.0.0.1").passed).toBe(true);
        expect(call(guard, "::ffff:127.0.0.1").passed).toBe(true);
    });
});
