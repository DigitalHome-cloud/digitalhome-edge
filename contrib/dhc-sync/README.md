# node-red-contrib-dhc-sync

Edge-side of the digitalhome.edge ↔ digitalhome.cloud contract described
in [`docs/specs/edge-cloud-api.md`](../../docs/specs/edge-cloud-api.md).

Implements RFC 8628 OAuth 2.0 Device Authorization Grant to link the edge
box to a SmartHome via user consent, then handles authenticated telemetry
and (Phase 5+) cloud C-BOX pull, deploy-push subscription, and Parquet
lake ingest.

Companion to `node-red-contrib-dhc-mcp` — dhc-mcp handles Claude ↔ edge
(MCP protocol), dhc-sync handles edge ↔ cloud (device auth + control plane).

## Nodes

### `dhc-sync-config` (configuration node)

Singleton per Node-RED instance. Owns the state machine that drives the
edge through:

```
BOOT
 └─ token present?
      ├── yes → LINKED (skip to telemetry loop)
      └── no  → UNLINKED
                 └─ POST /device_authorization → AWAITING_APPROVAL
                          ├─ user approves → LINKED
                          ├─ user denies   → DENIED
                          └─ expires       → UNLINKED (retry)
LINKED
 ├─ steady state: POST /telemetry every poll_after_s
 ├─ token rotation ~30d before expiry
 └─ 410 Gone → wipe secrets → UNLINKED
```

Reads secrets from `/opt/dhe/secrets/*` (path configurable). Emits state
transitions on an internal EventEmitter — subscribed to by
`dhc-sync-status` nodes and dashboard templates.

### `dhc-sync-status` (inbound)

Fires on every state machine transition and once at startup. Emits
`msg.payload` = `{ state, edge_id, home_id, user_code,
verification_uri, verification_uri_complete, expires_at, error }`.

Wire into a `function` → `ui-template` pair to render the pairing UI on
the Node-RED Dashboard.

### `dhc-sync-cbox-out` (inbound)

Fires when a telemetry response signals a new C-BOX is available for
this home. Emits `msg.payload` = `{ cbox_version, cbox_pull_url,
prev_version }`. Downstream flows use this to fetch and apply the new
twin.

## Companion dashboard flow

`examples/pairing-flow.json` — importable Node-RED flow that renders:

- A "Setup" dashboard tab (visible only while unlinked)
  - QR code encoding `verification_uri_complete`
  - Big user_code text as fallback
  - Live status text ("Waiting for approval…" → "Approved!" → "Linked ✓")
  - Restart pairing button

- A "Status" dashboard tab (visible only while linked)
  - Home ID, edge ID, token expiry, last telemetry timestamp
  - Unlink button (local; admin must Revoke on the cloud side)

Import via Node-RED menu → Import → Clipboard → paste the JSON, then
select the target flow.

## Configuration

The config node reads a JSON blob at startup (path defaults to
`/config/dhe.config.cache`, overridable via env
`DHC_SYNC_CONFIG`). Expected fields:

```json
{
  "cloud": {
    "api_url": "https://api.digitalhome.cloud/edge/v1",
    "client_id": "digitalhome-edge",
    "scope": "edge.link edge.telemetry edge.cbox edge.lake"
  },
  "dhe": {
    "secrets_dir": "/secrets",
    "config_dir":  "/config"
  }
}
```

Secret files the config node reads / writes:

- `/secrets/device-token` — read on boot; written after successful
  `POST /token`. Absent → triggers device auth flow.
- `/secrets/edge-id` — written after link.
- `/secrets/machine-id` — fallback for boxes where `/etc/machine-id`
  isn't readable inside the container.

## Development

```bash
cd contrib/dhc-sync
npm install
npm test
```

To install into a local Node-RED for manual testing:

```bash
cd ~/.node-red
npm install <path-to>/contrib/dhc-sync
```

## Status

Scaffold. State machine + system-info helpers are real; the OAuth device
flow client, telemetry poster, and dashboard example flow land in
follow-up commits per Phase 5 of the edge migration plan.
