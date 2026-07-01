// dhc-sync-config.js
//
// Configuration node — one per Node-RED instance. Owns:
//   - state machine (BOOT / UNLINKED / AWAITING_APPROVAL / LINKED / DENIED / ERROR)
//   - reads /secrets on startup; token present → LINKED, absent → UNLINKED
//   - drives the OAuth device flow (TODO in follow-up)
//   - drives the telemetry loop when linked (TODO in follow-up)
//   - emits transitions to subscribers (dhc-sync-status nodes, dashboard flows)
//
// Scaffold: state machine + secret reads are real. Network calls (device
// authorization, token polling, telemetry POST) are stubbed to log-and-noop.

"use strict";

const fs   = require("fs");
const path = require("path");
const { DhcSyncStateMachine, STATES } = require("../lib/state-machine");

function readOrNull(file) {
    try { return fs.readFileSync(file, "utf8").trim(); }
    catch (_) { return null; }
}

module.exports = function (RED) {
    function DhcSyncConfigNode(cfg) {
        RED.nodes.createNode(this, cfg);

        this.cloudApiUrl  = cfg.cloudApiUrl  || "https://api.digitalhome.cloud/edge/v1";
        this.clientId     = cfg.clientId     || "digitalhome-edge";
        this.scope        = cfg.scope        || "edge.link edge.telemetry edge.cbox edge.lake";
        this.secretsDir   = cfg.secretsDir   || "/secrets";
        this.configDir    = cfg.configDir    || "/config";

        this.fsm = new DhcSyncStateMachine(STATES.BOOT);

        const node = this;

        node._readSecret = (name) => readOrNull(path.join(node.secretsDir, name));

        // Boot: determine initial state from secrets on disk.
        const deviceToken = node._readSecret("device-token");
        const edgeId      = node._readSecret("edge-id");
        const homeIdStub  = node._readSecret("home-id");

        if (deviceToken && edgeId) {
            node.fsm.to(STATES.LINKED, {
                edge_id: edgeId,
                home_id: homeIdStub
            });
        } else {
            node.fsm.to(STATES.UNLINKED);
        }

        node.log(`dhc-sync boot state: ${node.fsm.state}`);

        // ── stub timers — the real OAuth + telemetry loops land in a follow-up ─
        // At scaffold stage we just log the intent so consumers can wire dashboards.
        node._loop = setInterval(() => {
            if (node.fsm.state === STATES.UNLINKED) {
                node.log("dhc-sync: would POST /device_authorization here (stub)");
            } else if (node.fsm.state === STATES.LINKED) {
                node.log("dhc-sync: would POST /telemetry here (stub)");
            }
        }, 60_000);

        // ── expose the state machine for the -status and -cbox-out nodes ────
        node.subscribe = (onTransition, onContextPatch) => {
            if (onTransition)   node.fsm.on("transition",   onTransition);
            if (onContextPatch) node.fsm.on("contextPatch", onContextPatch);
            // Immediately fire a "current state" snapshot so late subscribers
            // see the world.
            if (onTransition) {
                onTransition({
                    from: null,
                    to:   node.fsm.state,
                    context: node.fsm.context
                });
            }
        };

        node.on("close", (done) => {
            clearInterval(node._loop);
            node.fsm.removeAllListeners();
            done();
        });
    }

    RED.nodes.registerType("dhc-sync-config", DhcSyncConfigNode);
};
