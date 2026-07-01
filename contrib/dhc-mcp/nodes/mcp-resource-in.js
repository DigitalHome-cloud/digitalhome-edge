// mcp-resource-in.js — analogous to mcp-tool-in but for MCP resources.

"use strict";

module.exports = function (RED) {
    function McpResourceInNode(cfg) {
        RED.nodes.createNode(this, cfg);

        this.serverCfg = RED.nodes.getNode(cfg.server);
        this.uri       = cfg.uri;
        this.name_     = cfg.resName || "";
        this.mimeType  = cfg.mimeType || "application/json";

        const node = this;

        if (!node.serverCfg) {
            node.status({ fill: "red", shape: "ring", text: "no config" });
            return;
        }
        if (!node.uri) {
            node.status({ fill: "red", shape: "ring", text: "uri required" });
            return;
        }

        node.status({ fill: "green", shape: "dot", text: node.uri });

        node.serverCfg.registerResource(node.uri, (mcpMeta) => {
            node.send({
                payload: null,
                mcp:     { ...mcpMeta, uri: node.uri, mimeType: node.mimeType }
            });
        });

        node.on("close", (done) => done());
    }

    RED.nodes.registerType("mcp-resource-in", McpResourceInNode);
};
