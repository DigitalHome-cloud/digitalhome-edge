// dhc-sync-status.js
//
// Inbound node — fires on every state machine transition and once at startup
// with a snapshot. Wire into `function` / `ui-template` to render the pairing
// UI on the Node-RED Dashboard.

"use strict";

module.exports = function (RED) {
    function DhcSyncStatusNode(cfg) {
        RED.nodes.createNode(this, cfg);

        this.syncCfg = RED.nodes.getNode(cfg.sync);

        const node = this;

        if (!node.syncCfg) {
            node.status({ fill: "red", shape: "ring", text: "no config" });
            return;
        }

        const onTransition = (evt) => {
            node.status({
                fill:  evt.to === "linked" ? "green"
                     : evt.to === "denied" || evt.to === "error" ? "red"
                     : "yellow",
                shape: "dot",
                text:  evt.to
            });
            node.send({
                payload: {
                    state:                     evt.to,
                    prev_state:                evt.from,
                    edge_id:                   evt.context.edge_id,
                    home_id:                   evt.context.home_id,
                    user_code:                 evt.context.user_code,
                    verification_uri:          evt.context.verification_uri,
                    verification_uri_complete: evt.context.verification_uri_complete,
                    expires_at:                evt.context.expires_at,
                    error:                     evt.context.error
                }
            });
        };
        const onContextPatch = (evt) => {
            node.send({
                payload: {
                    state: node.syncCfg.fsm.state,
                    ...evt.context
                }
            });
        };

        node.syncCfg.subscribe(onTransition, onContextPatch);

        node.on("close", (done) => done());
    }

    RED.nodes.registerType("dhc-sync-status", DhcSyncStatusNode);
};
