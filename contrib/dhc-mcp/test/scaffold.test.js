// Placeholder — real tests land alongside the real protocol implementation.
// For now, assert the four node files can be required without crashing so
// CI catches syntax regressions before a full Node-RED spin-up.

import { describe, it, expect } from "vitest";

describe("dhc-mcp scaffold", () => {
    it("all four node modules load", () => {
        const files = [
            "../nodes/mcp-server-config.js",
            "../nodes/mcp-tool-in.js",
            "../nodes/mcp-resource-in.js",
            "../nodes/mcp-response.js"
        ];
        for (const f of files) {
            const mod = require(f);
            expect(typeof mod).toBe("function");
        }
    });
});
