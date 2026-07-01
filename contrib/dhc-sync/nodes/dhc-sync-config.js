// dhc-sync-config.js
//
// Configuration node — one per Node-RED instance. Drives the OAuth device
// flow, persists tokens, and runs the telemetry loop. Exposes the state
// machine to -status and -cbox-out nodes.
//
// State transitions here map exactly to the spec (docs/specs/edge-cloud-api.md
// §9.1). Any deviation goes through the state machine's transition table
// (contrib/dhc-sync/lib/state-machine.js) which throws on illegal moves —
// bugs surface loudly rather than silently corrupting the FSM.

"use strict";

const crypto = require("crypto");
const qrcode = require("qrcode");

const { DhcSyncStateMachine, STATES } = require("../lib/state-machine");
const { DhcOAuthClient }              = require("../lib/oauth-device-flow");
const secretsLib                      = require("../lib/secrets");
const sysinfo                         = require("../lib/system-info");

const MIN_POLL_INTERVAL_S = 5;
const DEFAULT_HEARTBEAT_S = 60;
const NETWORK_BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000, 16000, 32000, 60000];

module.exports = function (RED) {
    function DhcSyncConfigNode(cfg) {
        RED.nodes.createNode(this, cfg);

        const node = this;

        node.cloudApiUrl = cfg.cloudApiUrl || "https://api.digitalhome.cloud/edge/v1";
        node.clientId    = cfg.clientId    || "digitalhome-edge";
        node.scope       = cfg.scope       || "edge.link edge.telemetry edge.cbox edge.lake";
        node.secretsDir  = cfg.secretsDir  || "/secrets";
        node.configDir   = cfg.configDir   || "/config";

        node.fsm    = new DhcSyncStateMachine(STATES.BOOT);
        node.oauth  = new DhcOAuthClient({
            baseUrl:  node.cloudApiUrl,
            clientId: node.clientId,
            scope:    node.scope,
        });

        // Runtime state private to this node instance.
        node._pollTimer      = null;
        node._telemetryTimer = null;
        node._abort          = null;
        node._backoffIdx     = 0;

        // ── helpers ────────────────────────────────────────────────────────
        const backoffMs = () => NETWORK_BACKOFF_STEPS_MS[Math.min(
            node._backoffIdx, NETWORK_BACKOFF_STEPS_MS.length - 1
        )];
        const resetBackoff = () => { node._backoffIdx = 0; };
        const bumpBackoff  = () => { node._backoffIdx++; };
        const sleep = (ms) => new Promise((res) => {
            const t = setTimeout(res, ms);
            if (node._abort) node._abort.signal.addEventListener("abort", () => {
                clearTimeout(t); res();
            }, { once: true });
        });

        const stopTimers = () => {
            if (node._pollTimer)      { clearTimeout(node._pollTimer);      node._pollTimer = null; }
            if (node._telemetryTimer) { clearTimeout(node._telemetryTimer); node._telemetryTimer = null; }
            if (node._abort)          { node._abort.abort();                node._abort = null; }
        };

        // ── device authorization flow ──────────────────────────────────────
        async function runDeviceFlow() {
            try {
                const deviceInfo = {
                    machine_id:  sysinfo.readMachineId(node.secretsDir),
                    hostname:    require("os").hostname(),
                    lan_ip:      sysinfo.readPrimaryNic().ip,
                    dhe_version: sysinfo.readDheBuildInfo().dhe_version
                };
                const res = await node.oauth.requestDeviceAuthorization(deviceInfo);
                if (res.kind !== "ok") {
                    node.warn(`device_authorization failed: ${res.status} ${JSON.stringify(res.body)}`);
                    bumpBackoff();
                    node.fsm.patchContext({ error: `authorization request failed (${res.status})` });
                    node._pollTimer = setTimeout(runDeviceFlow, backoffMs());
                    return;
                }
                resetBackoff();
                const qrSvg = await qrcode.toString(res.data.verification_uri_complete, {
                    type: "svg", margin: 1, width: 300
                });
                node.fsm.to(STATES.AWAITING_APPROVAL, {
                    user_code:                 res.data.user_code,
                    device_code:               res.data.device_code,
                    verification_uri:          res.data.verification_uri,
                    verification_uri_complete: res.data.verification_uri_complete,
                    expires_at:                Date.now() + (res.data.expires_in * 1000),
                    qr_svg:                    qrSvg,
                    error:                     null
                });
                node.log(`Awaiting user approval — code ${res.data.user_code} at ${res.data.verification_uri}`);
                pollForApproval(res.data.device_code, Math.max(res.data.interval, MIN_POLL_INTERVAL_S));
            } catch (err) {
                node.error(`device flow error: ${err.message}`);
                bumpBackoff();
                node._pollTimer = setTimeout(runDeviceFlow, backoffMs());
            }
        }

        function pollForApproval(deviceCode, intervalS) {
            const tick = async () => {
                if (node.fsm.state !== STATES.AWAITING_APPROVAL) return;
                try {
                    const res = await node.oauth.pollToken(deviceCode);
                    if (res.kind === "ok") {
                        await onLinked(res.data);
                        return;
                    }
                    if (res.kind === "pending") {
                        node._pollTimer = setTimeout(tick, intervalS * 1000);
                        return;
                    }
                    if (res.kind === "slow_down") {
                        intervalS += 5;
                        node._pollTimer = setTimeout(tick, intervalS * 1000);
                        return;
                    }
                    if (res.kind === "denied") {
                        node.fsm.to(STATES.DENIED, { error: "user denied the pairing request" });
                        return;
                    }
                    if (res.kind === "expired") {
                        node.log("device_code expired — restarting device flow");
                        node.fsm.to(STATES.UNLINKED, { error: null });
                        setImmediate(runDeviceFlow);
                        return;
                    }
                    // "error" or unknown — treat as transient
                    node.warn(`token poll error: ${res.status} ${JSON.stringify(res.body)}`);
                    bumpBackoff();
                    node._pollTimer = setTimeout(tick, backoffMs());
                } catch (err) {
                    node.error(`token poll exception: ${err.message}`);
                    bumpBackoff();
                    node._pollTimer = setTimeout(tick, backoffMs());
                }
            };
            node._pollTimer = setTimeout(tick, intervalS * 1000);
        }

        async function onLinked(tokenResp) {
            try {
                await secretsLib.writeSecret(node.secretsDir, "device-token", tokenResp.access_token);
                await secretsLib.writeSecret(node.secretsDir, "edge-id",     tokenResp.edge_id);
                await secretsLib.writeSecret(node.secretsDir, "home-id",     tokenResp.home_id);
            } catch (err) {
                node.error(`failed to persist secrets: ${err.message}`);
                node.fsm.to(STATES.ERROR, { error: "secret persistence failed" });
                return;
            }
            node.fsm.to(STATES.LINKED, {
                edge_id:          tokenResp.edge_id,
                home_id:          tokenResp.home_id,
                token_expires_at: Date.now() + (tokenResp.expires_in * 1000),
                error:            null
            });
            node.log(`Linked to ${tokenResp.home_id} as ${tokenResp.edge_id}`);
            resetBackoff();
            scheduleTelemetry(0, /* sendFull */ true);
        }

        // ── telemetry loop ─────────────────────────────────────────────────
        let _telemetryFirstRun = true;
        function scheduleTelemetry(delayS, sendFull) {
            node._telemetryTimer = setTimeout(() => {
                telemetryTick(sendFull).catch((err) => {
                    node.error(`telemetry loop error: ${err.message}`);
                    bumpBackoff();
                    scheduleTelemetry(backoffMs() / 1000, false);
                });
            }, delayS * 1000);
        }

        async function telemetryTick(sendFull) {
            if (node.fsm.state !== STATES.LINKED) return;
            const token = await secretsLib.readSecret(node.secretsDir, "device-token");
            if (!token) {
                node.warn("device-token missing — dropping to UNLINKED");
                node.fsm.to(STATES.UNLINKED, { error: "token file missing" });
                setImmediate(runDeviceFlow);
                return;
            }
            const payload = sendFull || _telemetryFirstRun
                ? { ...sysinfo.collectFullTelemetry({ secretsDir: node.secretsDir }),
                    kind: "full",
                    client_timestamp: new Date().toISOString(),
                    nonce: crypto.randomBytes(16).toString("hex") }
                : { protocol_version: 1,
                    kind: "delta",
                    client_timestamp: new Date().toISOString() };

            _telemetryFirstRun = false;

            const res = await node.oauth.postTelemetry(token, payload);
            if (res.kind === "ok") {
                resetBackoff();
                node.fsm.patchContext({ last_telemetry_at: new Date().toISOString() });
                if (res.data?.cbox_updated) {
                    // TODO: emit to dhc-sync-cbox-out subscribers
                    node.log(`cbox_updated → ${res.data.cbox_version}`);
                }
                const nextInS = res.data?.poll_after_s || DEFAULT_HEARTBEAT_S;
                scheduleTelemetry(nextInS, false);
                return;
            }
            if (res.kind === "gone") {
                node.warn("cloud returned 410 Gone — wiping secrets and re-registering");
                await secretsLib.wipeLinkageSecrets(node.secretsDir);
                node.fsm.to(STATES.UNLINKED, { error: "revoked by cloud", edge_id: null, home_id: null });
                _telemetryFirstRun = true;
                setImmediate(runDeviceFlow);
                return;
            }
            if (res.kind === "unauthorized") {
                // TODO: token rotate. For now, treat as revoked.
                node.warn("cloud returned 401 — wiping secrets and re-registering");
                await secretsLib.wipeLinkageSecrets(node.secretsDir);
                node.fsm.to(STATES.UNLINKED, { error: "token rejected", edge_id: null, home_id: null });
                _telemetryFirstRun = true;
                setImmediate(runDeviceFlow);
                return;
            }
            node.warn(`telemetry post error: ${res.status} ${JSON.stringify(res.body)}`);
            bumpBackoff();
            scheduleTelemetry(backoffMs() / 1000, false);
        }

        // ── command endpoint (dashboard "Restart pairing" button) ──────────
        RED.httpAdmin.post("/dhc-sync/command", (req, res) => {
            const { action } = req.body || {};
            if (action === "restart") {
                node.log("restart requested via /dhc-sync/command");
                stopTimers();
                if (node.fsm.state === STATES.LINKED) {
                    // Refuse — operator must revoke on the cloud side.
                    res.status(409).json({ error: "already linked; revoke on cloud first" });
                    return;
                }
                // Force back to UNLINKED regardless of DENIED / AWAITING_APPROVAL.
                if (node.fsm.state !== STATES.UNLINKED) {
                    try { node.fsm.to(STATES.UNLINKED, { error: null }); }
                    catch (_) { /* already there or state transition rejected */ }
                }
                setImmediate(runDeviceFlow);
                res.json({ ok: true, state: node.fsm.state });
                return;
            }
            res.status(400).json({ error: "unknown action" });
        });

        // ── subscribe API for -status / -cbox-out nodes ────────────────────
        node.subscribe = (onTransition, onContextPatch) => {
            if (onTransition)   node.fsm.on("transition",   onTransition);
            if (onContextPatch) node.fsm.on("contextPatch", onContextPatch);
            if (onTransition) {
                onTransition({
                    from: null,
                    to:   node.fsm.state,
                    context: node.fsm.context
                });
            }
        };

        // ── boot: decide initial state from secrets ────────────────────────
        (async () => {
            try {
                const deviceToken = await secretsLib.readSecret(node.secretsDir, "device-token");
                const edgeId      = await secretsLib.readSecret(node.secretsDir, "edge-id");
                const homeId      = await secretsLib.readSecret(node.secretsDir, "home-id");

                if (deviceToken && edgeId) {
                    node.fsm.to(STATES.LINKED, { edge_id: edgeId, home_id: homeId, error: null });
                    node.log(`boot: linked to ${homeId} as ${edgeId}`);
                    scheduleTelemetry(0, true);
                } else {
                    node.fsm.to(STATES.UNLINKED, { error: null });
                    node.log("boot: no token, starting device flow");
                    setImmediate(runDeviceFlow);
                }
            } catch (err) {
                node.error(`boot failure: ${err.message}`);
                node.fsm.to(STATES.ERROR, { error: `boot: ${err.message}` });
            }
        })();

        node.on("close", (done) => {
            stopTimers();
            node.fsm.removeAllListeners();
            done();
        });
    }

    RED.nodes.registerType("dhc-sync-config", DhcSyncConfigNode);
};
