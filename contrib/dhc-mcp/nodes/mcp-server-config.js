// mcp-server-config.js
//
// Configuration node — one per Node-RED instance. Owns the MCP endpoint
// registration on Node-RED's Express, the bearer auth check, the C-BOX
// loader + catalog, and the per-session callId registry.
//
// Scaffold: registers the node type, wires the endpoints, no protocol yet.
// Real implementation in a follow-up commit.

"use strict";

const path = require("path");

module.exports = function (RED) {
    const activeSessions = new Map();          // sessionId -> { send, closedAt }
    const pendingCalls   = new Map();          // callId    -> { resolve, reject, tOut }

    function readAuthToken(tokenFile) {
        try {
            return require("fs").readFileSync(tokenFile, "utf8").trim();
        } catch (e) {
            return "";
        }
    }

    function McpServerConfigNode(cfg) {
        RED.nodes.createNode(this, cfg);

        this.mcpPath      = cfg.mcpPath      || "/mcp";
        this.tokenFile    = cfg.tokenFile    || "/secrets/mcp-auth-token";
        this.cboxPath     = cfg.cboxPath     || "/cbox/cbox.jsonld";
        this.serverName   = cfg.serverName   || "digitalhome-edge";
        this.serverVer    = cfg.serverVer    || "0.1.0";

        this._authToken = readAuthToken(this.tokenFile);
        this._catalog   = { tools: [], resources: [] };  // populated by the loader (TODO)

        const node = this;

        // ── HTTP endpoint registration on Node-RED's Express ─────────────────
        const app = RED.httpNode;
        const authMiddleware = (req, res, next) => {
            const header = req.get("authorization") || "";
            const expected = `Bearer ${node._authToken}`;
            if (!node._authToken || header !== expected) {
                res.status(401).json({ error: "unauthorized" });
                return;
            }
            next();
        };

        // Health check — unauth
        app.get(`${node.mcpPath}/health`, (req, res) => {
            res.json({ ok: true, catalog: {
                tools:     node._catalog.tools.length,
                resources: node._catalog.resources.length
            }});
        });

        // SSE stream — one connection per client session
        app.get(`${node.mcpPath}/sse`, authMiddleware, (req, res) => {
            const sessionId = req.query.session_id
                || require("crypto").randomBytes(16).toString("hex");

            res.set({
                "Content-Type":      "text/event-stream",
                "Cache-Control":     "no-cache",
                "Connection":        "keep-alive",
                "X-Accel-Buffering": "no",
            });
            res.flushHeaders();

            const send = (event, data) => {
                res.write(`event: ${event}\n`);
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            };

            activeSessions.set(sessionId, { send, closedAt: null });
            node.log(`MCP SSE session opened: ${sessionId}`);

            // Announce the messages endpoint per MCP SSE transport
            send("endpoint", { uri: `${node.mcpPath}/messages/${sessionId}` });

            req.on("close", () => {
                activeSessions.set(sessionId, {
                    ...activeSessions.get(sessionId),
                    closedAt: Date.now()
                });
                node.log(`MCP SSE session closed: ${sessionId}`);
            });
        });

        // Client → server messages (JSON-RPC over POST)
        app.post(`${node.mcpPath}/messages/:sessionId`, authMiddleware,
            require("express").json(), (req, res) => {
            const sessionId = req.params.sessionId;
            const message   = req.body;

            // TODO: dispatch tools/call, resources/read, initialize, etc.
            // For scaffold: log and 202-accept everything.
            node.log(`MCP message on ${sessionId}: ${message.method || "?"}`);
            res.status(202).json({ ok: true });
        });

        // ── expose helpers to the -in / -out nodes ────────────────────────────
        node.registerTool = function (name, handler) {
            // handler(args, {callId, sessionId}) → invoked by dispatcher when a
            // matching tools/call arrives. TODO in follow-up commit.
        };
        node.registerResource = function (uri, handler) { /* TODO */ };
        node.sendResponse    = function (callId, payload) { /* TODO */ };

        node.on("close", (done) => {
            for (const [_, session] of activeSessions) {
                if (session.send) {
                    try { session.send("close", {}); } catch (_) {}
                }
            }
            activeSessions.clear();
            done();
        });
    }

    RED.nodes.registerType("mcp-server-config", McpServerConfigNode);
};
