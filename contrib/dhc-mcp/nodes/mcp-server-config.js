// mcp-server-config.js
//
// Configuration node — one per Node-RED instance. Runs the MCP server via
// @modelcontextprotocol/sdk on top of Node-RED's Express instance.
//
// Endpoints registered:
//   GET  {mcpPath}/health   unauthenticated health probe
//   GET  {mcpPath}/sse      bearer-authed SSE handshake
//   POST {mcpPath}/messages/:sessionId  bearer-authed JSON-RPC in
//
// Tools + resources register themselves via node.registerTool / node.registerResource
// (called from mcp-tool-in / mcp-resource-in). CallTool + ReadResource dispatch to
// registered handlers and return a Promise that resolves when the paired
// mcp-response node reports back with the same callId.

"use strict";

const fs     = require("fs");
const http   = require("http");
const crypto = require("crypto");
const express = require("express");

const { Server }             = require("@modelcontextprotocol/sdk/server/index.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const CALL_TIMEOUT_MS = 30_000;

function readAuthToken(tokenFile) {
    try { return fs.readFileSync(tokenFile, "utf8").trim(); }
    catch (_) { return ""; }
}

module.exports = function (RED) {
    function McpServerConfigNode(cfg) {
        RED.nodes.createNode(this, cfg);

        this.mcpPath    = cfg.mcpPath    || "/mcp";
        this.mcpHost    = cfg.mcpHost    || "0.0.0.0";
        this.mcpPort    = parseInt(cfg.mcpPort || "8443", 10);
        this.tokenFile  = cfg.tokenFile  || "/secrets/mcp-auth-token";
        this.cboxPath   = cfg.cboxPath   || "/cbox/cbox.jsonld";
        this.serverName = cfg.serverName || "digitalhome-edge";
        this.serverVer  = cfg.serverVer  || "0.1.0";

        const node = this;

        node._authToken     = readAuthToken(node.tokenFile);
        node._tools         = new Map();   // name -> { description, inputSchema, handler }
        node._resources     = new Map();   // uri  -> { name, mimeType, handler }
        node._pendingCalls  = new Map();   // callId -> { resolve, reject, timer, kind }
        node._transports    = new Map();   // sessionId -> SSEServerTransport

        // ── SDK Server + handlers (one Server instance across sessions) ────
        node._server = new Server(
            { name: node.serverName, version: node.serverVer },
            { capabilities: { tools: { listChanged: true }, resources: { listChanged: true } } }
        );

        node._server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: Array.from(node._tools.entries()).map(([name, t]) => ({
                name,
                description: t.description || "",
                inputSchema: t.inputSchema || { type: "object", properties: {} }
            }))
        }));

        node._server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
            const toolName = req.params.name;
            const args     = req.params.arguments || {};
            const tool     = node._tools.get(toolName);
            if (!tool) {
                return {
                    content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
                    isError: true
                };
            }
            return await callWithPromise("tool", (callId) => {
                tool.handler(args, { callId, sessionId: extra?.sessionId, toolName });
            });
        });

        node._server.setRequestHandler(ListResourcesRequestSchema, async () => ({
            resources: Array.from(node._resources.entries()).map(([uri, r]) => ({
                uri,
                name:     r.name || uri,
                mimeType: r.mimeType || "application/json"
            }))
        }));

        node._server.setRequestHandler(ReadResourceRequestSchema, async (req, extra) => {
            const uri      = req.params.uri;
            const resource = node._resources.get(uri);
            if (!resource) {
                return {
                    contents: [{ uri, mimeType: "text/plain", text: `Unknown resource: ${uri}` }]
                };
            }
            const result = await callWithPromise("resource", (callId) => {
                resource.handler({ callId, sessionId: extra?.sessionId, uri });
            });
            // sendResponse produced { content: [...], isError }; adapt to the
            // resources/read response shape.
            const first = result.content?.[0];
            return {
                contents: [{
                    uri,
                    mimeType: resource.mimeType || "application/json",
                    text:     first?.text ?? JSON.stringify(result)
                }]
            };
        });

        // ── callId ↔ Promise bridge ────────────────────────────────────────
        function callWithPromise(kind, dispatch) {
            const callId = crypto.randomUUID();
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    node._pendingCalls.delete(callId);
                    reject(new Error(`${kind} call ${callId} timed out after ${CALL_TIMEOUT_MS}ms`));
                }, CALL_TIMEOUT_MS);
                node._pendingCalls.set(callId, { resolve, reject, timer, kind });
                try {
                    dispatch(callId);
                } catch (err) {
                    clearTimeout(timer);
                    node._pendingCalls.delete(callId);
                    reject(err);
                }
            });
        }

        // Called by mcp-response node.
        node.sendResponse = function (callId, { payload, isError }) {
            const pending = node._pendingCalls.get(callId);
            if (!pending) {
                node.warn(`sendResponse: unknown or expired callId ${callId}`);
                return;
            }
            clearTimeout(pending.timer);
            node._pendingCalls.delete(callId);
            const text = typeof payload === "string"
                ? payload
                : JSON.stringify(payload ?? null);
            pending.resolve({
                content: [{ type: "text", text }],
                isError: Boolean(isError)
            });
        };

        // ── tool / resource registry ───────────────────────────────────────
        node.registerTool = function ({ name, description, inputSchema }, handler) {
            if (!name || typeof handler !== "function") return;
            if (node._tools.has(name)) {
                node.warn(`registerTool: overwriting existing tool "${name}"`);
            }
            node._tools.set(name, { description, inputSchema, handler });
            node._notifyToolsChanged();
        };

        node.unregisterTool = function (name) {
            if (node._tools.delete(name)) node._notifyToolsChanged();
        };

        node.registerResource = function ({ uri, name, mimeType }, handler) {
            if (!uri || typeof handler !== "function") return;
            if (node._resources.has(uri)) {
                node.warn(`registerResource: overwriting existing resource "${uri}"`);
            }
            node._resources.set(uri, { name, mimeType, handler });
            node._notifyResourcesChanged();
        };

        node.unregisterResource = function (uri) {
            if (node._resources.delete(uri)) node._notifyResourcesChanged();
        };

        node._notifyToolsChanged = function () {
            for (const t of node._transports.values()) {
                try {
                    node._server.notification({ method: "notifications/tools/list_changed" })
                        .catch((e) => node.warn(`tools/list_changed notify failed: ${e.message}`));
                } catch (_) { /* server may not be connected yet */ }
                break; // notification() broadcasts to all connected transports
            }
        };
        node._notifyResourcesChanged = function () {
            for (const t of node._transports.values()) {
                try {
                    node._server.notification({ method: "notifications/resources/list_changed" })
                        .catch((e) => node.warn(`resources/list_changed notify failed: ${e.message}`));
                } catch (_) { /* server may not be connected yet */ }
                break;
            }
        };

        // ── HTTP endpoints on our own Express + HTTP server ────────────────
        //
        // Cannot piggyback on RED.httpNode: it sits behind Node-RED's global
        // httpNodeAuth (Basic auth) which MCP clients (Claude Desktop et al.)
        // don't send. RED.httpAdmin is behind adminAuth (OAuth token) with the
        // same problem. Only clean fix is our own listener with bearer auth.
        //
        // Binds to `mcpHost:mcpPort` — the container uses network_mode: host so
        // the port is reachable on the LAN directly.
        const app = express();

        const authMw = (req, res, next) => {
            const header = req.get("authorization") || "";
            const expected = `Bearer ${node._authToken}`;
            if (!node._authToken || header !== expected) {
                res.status(401).json({ error: "unauthorized" });
                return;
            }
            next();
        };

        app.get(`${node.mcpPath}/health`, (req, res) => {
            res.json({
                ok:        true,
                server:    node.serverName,
                version:   node.serverVer,
                tools:     node._tools.size,
                resources: node._resources.size,
                sessions:  node._transports.size
            });
        });

        // GET /sse — establish SSE connection, SDK handles the handshake.
        app.get(`${node.mcpPath}/sse`, authMw, async (req, res) => {
            const transport = new SSEServerTransport(`${node.mcpPath}/messages`, res);
            const sessionId = transport.sessionId;
            node._transports.set(sessionId, transport);
            node.log(`MCP SSE session opened: ${sessionId}`);

            transport.onclose = () => {
                node._transports.delete(sessionId);
                node.log(`MCP SSE session closed: ${sessionId}`);
            };
            transport.onerror = (err) => {
                node.warn(`MCP SSE session error (${sessionId}): ${err?.message || err}`);
            };

            try {
                await node._server.connect(transport);
            } catch (err) {
                node.error(`server.connect failed: ${err.message}`);
                try { res.end(); } catch (_) {}
            }
        });

        // POST /messages?sessionId=... — client → server JSON-RPC message.
        // Note: SSEServerTransport advertises sessionId as a query parameter
        // (`?sessionId=…`) in the `endpoint` event. Route matches that shape.
        app.post(
            `${node.mcpPath}/messages`,
            authMw,
            express.json({ limit: "512kb" }),
            async (req, res) => {
                const sessionId = req.query.sessionId;
                const transport = node._transports.get(sessionId);
                if (!transport) {
                    res.status(404).json({ error: "session not found", sessionId });
                    return;
                }
                try {
                    // Pass the already-parsed body so the SDK doesn't re-parse
                    // the request stream (which would be empty after express.json).
                    await transport.handlePostMessage(req, res, req.body);
                } catch (err) {
                    node.error(`handlePostMessage failed: ${err.message}`);
                    if (!res.headersSent) res.status(500).json({ error: "internal" });
                }
            }
        );

        // Start listening.
        node._httpServer = http.createServer(app);
        node._httpServer.on("error", (err) => {
            node.error(`MCP HTTP listen failed on ${node.mcpHost}:${node.mcpPort}: ${err.message}`);
        });
        node._httpServer.listen(node.mcpPort, node.mcpHost, () => {
            node.log(`MCP server listening on ${node.mcpHost}:${node.mcpPort}${node.mcpPath}`);
        });

        // ── shutdown ───────────────────────────────────────────────────────
        node.on("close", async (done) => {
            for (const t of node._transports.values()) {
                try { await t.close(); } catch (_) {}
            }
            node._transports.clear();
            for (const { timer, reject } of node._pendingCalls.values()) {
                clearTimeout(timer);
                try { reject(new Error("shutdown")); } catch (_) {}
            }
            node._pendingCalls.clear();
            try { await node._server.close(); } catch (_) {}
            try {
                await new Promise((res) => node._httpServer?.close(() => res()));
            } catch (_) {}
            done();
        });
    }

    RED.nodes.registerType("mcp-server-config", McpServerConfigNode);
};
