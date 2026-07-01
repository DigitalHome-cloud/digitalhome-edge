// mcp-response.js
//
// Outbound node — terminates a tool/resource flow. Reads msg.payload as
// the result to return, and msg.mcp.callId (which must round-trip from the
// paired -in node) as the correlation id.

"use strict";

module.exports = function (RED) {
    function McpResponseNode(cfg) {
        RED.nodes.createNode(this, cfg);

        this.serverCfg = RED.nodes.getNode(cfg.server);
        this.errorFlag = cfg.errorFlag || false;

        const node = this;

        if (!node.serverCfg) {
            node.status({ fill: "red", shape: "ring", text: "no config" });
            return;
        }

        node.on("input", (msg, send, done) => {
            const callId = msg?.mcp?.callId;
            if (!callId) {
                node.warn("mcp-response: msg.mcp.callId missing — dropping");
                done && done();
                return;
            }
            node.serverCfg.sendResponse(callId, {
                payload:  msg.payload,
                isError:  msg?.mcp?.isError ?? node.errorFlag ?? false
            });
            done && done();
        });
    }

    RED.nodes.registerType("mcp-response", McpResponseNode);
};
