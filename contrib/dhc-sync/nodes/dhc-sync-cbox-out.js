// dhc-sync-cbox-out.js
//
// Inbound node — fires when a telemetry response signals a new C-BOX is
// available for this home. Downstream flows fetch + apply the new twin.
//
// Scaffold: registration hook wired; the config node's telemetry loop
// will call node.emitCboxUpdate() when it lands.

"use strict";

module.exports = function (RED) {
    function DhcSyncCboxOutNode(cfg) {
        RED.nodes.createNode(this, cfg);

        this.syncCfg = RED.nodes.getNode(cfg.sync);

        const node = this;

        if (!node.syncCfg) {
            node.status({ fill: "red", shape: "ring", text: "no config" });
            return;
        }

        // Exposed to the config node's telemetry handler
        node.emitCboxUpdate = ({ cbox_version, cbox_pull_url, prev_version }) => {
            node.send({
                payload: { cbox_version, cbox_pull_url, prev_version }
            });
            node.status({
                fill:  "green",
                shape: "dot",
                text:  `cbox → ${cbox_version}`
            });
        };

        // TODO: register with syncCfg so its telemetry loop calls emitCboxUpdate

        node.on("close", (done) => done());
    }

    RED.nodes.registerType("dhc-sync-cbox-out", DhcSyncCboxOutNode);
};
