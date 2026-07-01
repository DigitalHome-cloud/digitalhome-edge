// mcp-tool-in.js
//
// Inbound node — fires when the MCP server receives a `tools/call` request
// for the tool name configured on this node. Emits msg = {
//   payload: <tool arguments>,
//   mcp: { callId, sessionId, toolName }
// }.
//
// Scaffold: registers with the config node's tool dispatcher; noop today.

"use strict";

module.exports = function (RED) {
    function McpToolInNode(cfg) {
        RED.nodes.createNode(this, cfg);

        this.serverCfg  = RED.nodes.getNode(cfg.server);
        this.toolName   = cfg.toolName;
        this.description = cfg.description || "";
        this.inputSchema = cfg.inputSchema || "{}";

        const node = this;

        if (!node.serverCfg) {
            node.status({ fill: "red", shape: "ring", text: "no config" });
            return;
        }
        if (!node.toolName) {
            node.status({ fill: "red", shape: "ring", text: "tool name required" });
            return;
        }

        node.status({ fill: "green", shape: "dot", text: node.toolName });

        let inputSchema;
        try {
            inputSchema = JSON.parse(node.inputSchema || "{}");
        } catch (err) {
            node.warn(`invalid inputSchema JSON for ${node.toolName}: ${err.message}`);
            inputSchema = { type: "object", properties: {} };
        }

        node.serverCfg.registerTool(
            { name: node.toolName, description: node.description, inputSchema },
            (args, mcpMeta) => {
                node.send({
                    payload: args,
                    mcp:     { ...mcpMeta, toolName: node.toolName }
                });
            }
        );

        node.on("close", (done) => {
            node.serverCfg.unregisterTool(node.toolName);
            done();
        });
    }

    RED.nodes.registerType("mcp-tool-in", McpToolInNode);
};
