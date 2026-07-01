# Edge ↔ Cloud API — OAuth Device Flow + Telemetry

**Status:** Draft v0.2 (rewritten around RFC 8628 device authorization grant)
**Owner (cloud side):** dark factory team (`digitalhome-cloud-darkfactory/`)
**Owner (edge side):** `digitalhome-edge`
**Date:** 2026-07-01

## Change log

- **v0.2 — 2026-07-01** — Replaced unauthenticated register/welcome POST with RFC 8628 OAuth 2.0 Device Authorization Grant. Trust anchor is the user's Cognito login + `user_code` confirmation. Welcome payload moves from public → authenticated telemetry. Dashboard hosts the pairing UI (QR code + waiting-for-approval state) via `@flowfuse/node-red-dashboard`. Rationale: eliminate the unauthenticated payload injection surface v0.1 had.
- **v0.1 — 2026-07-01** — Superseded. Unauthenticated welcome POST with pairing code + admin visual confirmation.

## 1. Goals

- Every edge box registers itself with the cloud without any pre-shared identity.
- Registration is **authenticated by the user, not by the edge** — the trust anchor is the user's existing Cognito account, not any secret baked into the edge image.
- The cloud never persists attacker-controlled data. Any anonymous edge → cloud call is either transient (short-lived device codes) or carries no useful payload beyond identifying the OAuth session.
- Once linked, the edge holds a `device_token` used for authenticated telemetry, heartbeat, catalog fetch, and lake ingest.
- No secret material in the edge image or the git repo; everything minted per-box after user consent.

Non-goals for v0.2:
- Hardware root-of-trust (TPM, secure element).
- Mutual TLS with per-device certificates issued at manufacture.
- Multi-cloud federation.

---

## 2. Actors and flow

Standard OAuth 2.0 Device Authorization Grant (RFC 8628), with the twist that
the authorization endpoint is the Portal app already backed by Cognito.

```
       ┌───────────────────────────┐
       │        edge box            │
       │  (node-red-contrib-dhc-sync)│
       └─────────────┬──────────────┘
                     │
                     │  1. POST /device_authorization
                     │     body: { client_id, minimal device_info }
                     │  ← 200: user_code (ABCD-1234)
                     │        device_code (dc_v1_… — secret)
                     │        verification_uri (https://portal.digitalhome.cloud/link)
                     │        verification_uri_complete (?user_code=ABCD-1234)
                     │        expires_in = 600, interval = 5
                     │
                     ├─ 2. dashboard shows QR + user_code + status
                     │
                     │  3. poll every `interval` seconds:
                     │     POST /token
                     │     body: { device_code, grant_type }
                     │  ← 400 { error: "authorization_pending" }  ← until approved
                     ▼
                                        (out of band)
                                                 │
                                                 ▼
       ┌───────────────────────────┐
       │           user            │
       │   (phone or laptop)       │
       └─────────────┬──────────────┘
                     │
                     │  a. opens verification_uri_complete on phone
                     │     (QR code from the edge dashboard)
                     │  b. Cognito Hosted UI → user logs in
                     │  c. Portal /link page:
                     │       "Approve this device? Link to which SmartHome?"
                     │        [dropdown of user's homes | create new]
                     │        [Approve]  [Deny]
                     │  d. Approve → Portal calls:
                     │       PATCH /device_codes/{device_code}
                     │       Cognito-authenticated, sets approved=true,
                     │       stores home_id + cognito_sub against the code.
                     ▼
       ┌───────────────────────────┐
       │      digitalhome.cloud    │
       │  Amplify Gen2 (Cognito +  │
       │  API GW + Lambdas + DDB)  │
       └─────────────┬──────────────┘
                     │
                     │  edge polls again:
                     │  4. POST /token
                     │  ← 200 { access_token = device_token,
                     │           home_id, expires_in }
                     │
                     │  5. edge persists device_token,
                     │     posts full welcome as authenticated telemetry:
                     │     POST /telemetry  (Bearer device_token)
                     │     body: { welcome payload }
                     ▼
```

Only steps 1 and 3 are unauthenticated. Both carry either transient
identifiers (`device_code`, `user_code`) or minimal device info used only
for the user to recognize their box. **The persisted linkage requires a
valid Cognito login.** Everything after step 4 uses `Authorization:
Bearer {device_token}`.

---

## 3. Endpoints

Base URL: `https://api.digitalhome.cloud/edge/v1`
Content-Type: `application/json`
Timestamps: RFC 3339 UTC.

### 3.1 `POST /device_authorization` (unauth)

RFC 8628 device authorization request. Called by the edge on **first boot**
or whenever `/opt/dhe/secrets/device-token` is missing.

**Auth:** none.

**Request body:**
```json
{
  "client_id": "digitalhome-edge",
  "scope":     "edge.link edge.telemetry edge.cbox edge.lake",
  "device_info": {
    "machine_id":  "d41f7c2ae4e343e6a1f0b58e5c8a9d21",
    "hostname":    "DLAB5-W541-01",
    "lan_ip":      "192.168.1.10",
    "dhe_version": "0.3.0"
  }
}
```

**Response 200 OK:**
```json
{
  "device_code":               "dc_v1_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
  "user_code":                 "ABCD-1234",
  "verification_uri":          "https://portal.digitalhome.cloud/link",
  "verification_uri_complete": "https://portal.digitalhome.cloud/link?user_code=ABCD-1234",
  "expires_in":                600,
  "interval":                  5
}
```

- `device_code` — 128-bit secret. Only the edge sees this. Persisted in
  DDB (see §5).
- `user_code` — short human-typeable (8 chars, hyphenated). Displayed on
  the edge's dashboard + shown in the URL query so the user doesn't have
  to retype.
- `interval` — minimum seconds between `/token` polls. Enforced server-side.

**`device_info`** is metadata for the user's approval screen ("this box
calls itself DLAB5-W541-01 at 192.168.1.10 — is this yours?"). Cloud
stores it only against the transient `device_code` row. If the code
expires or is denied, the row is deleted → nothing persisted.

**Response 400** — malformed request. **Response 429** — rate-limited.

### 3.2 `POST /token` (unauth for device_code grant)

RFC 8628 token endpoint. Called by the edge in a polling loop after
`/device_authorization`.

**Auth:** none. Identity proven by possession of `device_code`.

**Request body:**
```json
{
  "grant_type":  "urn:ietf:params:oauth:grant-type:device_code",
  "device_code": "dc_v1_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
  "client_id":   "digitalhome-edge"
}
```

**Response 400 `{"error": "authorization_pending"}`** — user has not yet
approved. Edge continues polling at `interval` seconds.

**Response 400 `{"error": "slow_down"}`** — edge polling too fast.
Increase `interval` by 5 seconds.

**Response 400 `{"error": "access_denied"}`** — user clicked Deny. Edge
should stop, display a "denied" state on the dashboard, and require a
manual restart to try again.

**Response 400 `{"error": "expired_token"}`** — device_code expired.
Edge should restart at `POST /device_authorization`.

**Response 200 OK** — approved:
```json
{
  "access_token": "dt_v1_a0b1c2d3e4f5g6h7i8j9k0l1m2n3o4p5q6r7s8t9u0v1w2x3y4z5",
  "token_type":   "Bearer",
  "expires_in":   31536000,
  "edge_id":      "e-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
  "home_id":      "DE-80331-MAR12-01",
  "scope":        "edge.link edge.telemetry edge.cbox edge.lake",
  "cloud_endpoints": {
    "telemetry":      "https://api.digitalhome.cloud/edge/v1/telemetry",
    "cbox_pull":      "https://api.digitalhome.cloud/edge/v1/homes/{home_id}/cbox",
    "flow_push":      "https://api.digitalhome.cloud/edge/v1/homes/{home_id}/flows",
    "lake_ingest":    "https://api.digitalhome.cloud/edge/v1/homes/{home_id}/lake",
    "deploy_channel": "wss://push.digitalhome.cloud/edge/v1/{edge_id}"
  }
}
```

`access_token` is the `device_token`. Edge writes it to
`/opt/dhe/secrets/device-token` (mode 0600 uid 1000) atomically before
using it.

`expires_in` — 12 months by default. Rotation happens via
`POST /token` with a `refresh_token` grant (§3.4) or, if the edge missed
rotation, by re-running the device flow (dashboard prompts the user
again — annoying but safe).

### 3.3 `POST /telemetry` (auth)

Authenticated call carrying the full welcome/heartbeat payload from §4.
Called immediately after `POST /token` succeeds, and periodically
thereafter.

**Auth:** `Authorization: Bearer {device_token}`.

**Request body:** the welcome / heartbeat schema (§4).

**Response 200 OK:**
```json
{
  "poll_after_s": 60,
  "cbox_version": "v2026-06-30T09:00Z",
  "cbox_updated": false,
  "server_timestamp": "2026-07-01T15:31:00Z"
}
```

If `cbox_updated: true`, the sync agent triggers a `cbox_pull` on the
returned `cbox_version`.

**Response 401** — invalid/expired token. Edge attempts `token/rotate`
(§3.4); if that fails, edge re-runs `device_authorization` (which will
prompt the user to re-approve).
**Response 410 Gone** — box was revoked by the admin. Edge deletes all
local secrets and falls back to `device_authorization`.

### 3.4 `POST /token/rotate` (auth)

Refresh the current token before expiry. Called by the edge when
`token_expires - now < 30d`, or when a heartbeat response sets
`token_rotate_required: true`.

**Auth:** `Authorization: Bearer {current_device_token}`.

**Response 200 OK:** same shape as §3.2 success.

Old token remains valid for 60s to cover races.

### 3.5 Admin-facing endpoints (out of scope here)

- Portal's `/link` page uses AppSync GraphQL to `approveDeviceCode(user_code, home_id)` and `denyDeviceCode(user_code)`.
- The admin UI lists linked edges via `listEdges(home_id)` and revokes with `revokeEdge(edge_id, reason)`.

Neither talks to the edge directly.

---

## 4. Telemetry payload

Sent as the `POST /telemetry` body — this is what v0.1 called the
"welcome message." Full initial payload on the first call after
linkage; subsequent calls are `delta` only (see §4.3).

```json
{
  "protocol_version": 1,
  "kind":             "full",

  "edge": {
    "machine_id":       "d41f7c2ae4e343e6a1f0b58e5c8a9d21",
    "hostname":         "DLAB5-W541-01",
    "mac_primary":      "aa:bb:cc:dd:ee:ff",
    "lan_ip":           "192.168.1.10",
    "timezone":         "Europe/Brussels",
    "locale":           "en_US.UTF-8"
  },
  "software": {
    "dhe_version":      "0.3.0",
    "dhe_image":        "digitalhome/dhe:0.3.0",
    "git_sha":          "3777fa2",
    "node_red_version": "4.0.9",
    "os":               "Ubuntu 24.04.2 LTS",
    "kernel":           "6.8.0-106-generic",
    "arch":             "x86_64"
  },
  "capabilities": {
    "protocols":        ["homematic", "hue"],
    "palettes":         [
      {"name": "node-red-contrib-ccu",         "version": "3.4.2"},
      {"name": "node-red-contrib-huemagic",    "version": "4.2.2"},
      {"name": "@flowfuse/node-red-dashboard", "version": "1.30.2"},
      {"name": "node-red-contrib-dhc-mcp",     "version": "0.1.0"},
      {"name": "node-red-contrib-dhc-sync",    "version": "0.1.0"}
    ],
    "mcp":              {"enabled": true, "transports": ["sse"]},
    "tier":             "advanced",
    "features":         ["dashboard-v2", "projects", "matter-mdns"]
  },
  "hardware": {
    "cpu_model":        "Intel(R) Core(TM) i7-4600M CPU @ 2.90GHz",
    "cpu_cores":        4,
    "memory_mb":        16384,
    "disk_free_gb":     120
  },
  "runtime": {
    "boot_id":          "e6a3f240-3c4e-4d8b-9a2e-1c7f8b2a3d4e",
    "boot_time_epoch":  1751371200,
    "config_cache_version": 3,
    "cbox_version":     "v2026-06-28T10:00Z"
  },

  "client_timestamp":   "2026-07-01T14:30:00Z",
  "nonce":              "3f8a52c1b7d9e4f6a2c8b0d3e5f7a9c1"
}
```

### 4.1 Field constraints

Same as v0.1 §4.1 — see git history for the table. Cloud validates
strictly and rejects malformed payloads (400). Since the caller is
authenticated by device_token, a rejected payload does *not* increment
any anonymous-attacker counter.

### 4.2 What is NOT in the telemetry

- **`home_id`** — the cloud already knows it from the token binding.
  Sending it would be redundant and confusing if the two disagreed.
- **Device tokens, API keys, MCP bearer, Node-RED passwords** — all live
  on the edge only. Cloud never sees them.
- **Device inventory** (CCU / Hue / Matter devices) — sent on a separate
  endpoint `POST /edge/v1/inventory` (out of scope here) once the C-BOX
  designer needs it.

### 4.3 Delta heartbeats

After the first `kind: "full"` telemetry, subsequent calls use
`kind: "delta"` with only changed fields:

```json
{
  "protocol_version": 1,
  "kind":             "delta",
  "edge":     { "lan_ip": "192.168.1.11" },
  "runtime":  { "cbox_version": "v2026-06-30T09:00Z" },
  "client_timestamp": "2026-07-01T15:30:00Z"
}
```

Cloud merges into the stored row. Empty delta = liveness ping.

---

## 5. DynamoDB schema

Two tables to keep OAuth device state cleanly separate from the durable
edge registry.

### 5.1 `DeviceCodes` (short-lived)

Holds pending device_authorization requests. TTL 10 min.

```
PK: device_code                "dc_v1_..."
SK: "META"

Attributes:
  user_code            "ABCD-1234"          (indexed as GSI1_PK)
  status               pending | approved | denied | expired
  device_info          { machine_id, hostname, lan_ip, dhe_version }
  approved_by_sub      cognito user sub | null    ← set on approval
  home_id              string | null              ← set on approval
  created_at           iso8601
  approved_at          iso8601 | null
  expires_at           TTL-controlled auto-delete (10 min from created_at)
  poll_count           int   ← rate-limit metric
  last_poll_at         iso8601
```

**GSI1**: PK = `user_code`, SK = `META` — Portal's `/link` page looks up
by code the user typed. TTL applies.

### 5.2 `EdgeRegistry` (durable)

Rows land here only after successful token exchange (§3.2). Nothing
attacker-controlled without a Cognito login upstream.

```
PK: edge_id                    "e-1a2b3c4d-..."
SK: "META"

Attributes:
  machine_id                   (indexed for dedup on re-link)
  home_id
  linked_by_cognito_sub
  device_token_hash            sha256(current device_token)
  device_token_expires         iso8601
  previous_token_hash          sha256(previous, valid 60s post-rotate)
  previous_token_expires       iso8601 | null
  status                       linked | revoked
  first_seen_at
  last_telemetry_at
  last_heartbeat_at
  telemetry_snapshot           map — latest full welcome
  delta_history                list — last 20 deltas
  linked_at
  revoked_at                   iso8601 | null
  revoked_reason               string | null
```

**GSI1**: PK = `machine_id`, SK = `META` — dedup during re-link.
**GSI2**: PK = `home_id`, SK = `edge_id` — admin UI lists per-home edges.

**Encryption:** table encrypted at rest with an AWS KMS CMK. PITR
enabled, 30-day backups.

---

## 6. Lifecycle

```
              ┌─────────────────────────────────────┐
              │                                     │
              │  edge has no device_token           │
              │  (first boot OR /opt/dhe/secrets    │
              │   was wiped)                        │
              │                                     │
              └───────────────┬─────────────────────┘
                              │
                              │  POST /device_authorization
                              ▼
                     ┌──────────────────┐
                     │  DeviceCodes row │
                     │  pending         │
                     │  TTL 10min       │
                     └────────┬─────────┘
                              │
                    ┌─────────┴─────────┐
                    │                   │
                    ▼                   ▼
             User approves       User denies OR 10min elapses
                    │                   │
                    ▼                   ▼
           ┌──────────────────┐  ┌──────────────────┐
           │ DeviceCodes:     │  │ DeviceCodes:     │
           │ approved         │  │ denied / expired │
           └────────┬─────────┘  │ (auto-deleted)   │
                    │            └──────────────────┘
                    │
                    │  edge POST /token succeeds
                    │  → EdgeRegistry row created
                    │  → device_token minted, hash stored
                    │
                    ▼
           ┌──────────────────┐
           │ EdgeRegistry:    │
           │ linked           │◄─── heartbeats every 60s
           └────────┬─────────┘
                    │
                    │  admin clicks Revoke
                    ▼
           ┌──────────────────┐
           │ EdgeRegistry:    │
           │ revoked          │
           └──────────────────┘
                    │
                    │  edge sees 410 Gone
                    ▼
           ┌──────────────────┐
           │ edge wipes local │
           │ secrets, restarts│
           │ device_authz     │
           └──────────────────┘
```

---

## 7. Security

### 7.1 Attack surface reduction vs v0.1

| Surface | v0.1 | v0.2 |
|---|---|---|
| Anon endpoints | `POST /register` (large body) + `POST /heartbeat` | `POST /device_authorization` (tiny body) + `POST /token` (tiny body) |
| Anon-controlled persisted data | Full welcome payload in DDB, indexed by attacker-chosen `machine_id` | Tiny `device_info` in DeviceCodes with TTL 10 min |
| Trust anchor | Admin visual confirm of pairing_code | User Cognito login + `user_code` confirm |
| Fake-registration DoS payoff | Row in EdgeRegistry until admin cleans up | Row auto-deleted in 10 min |
| Attacker gets telemetry-endpoint access | Impossible (register→link→cognito) | Impossible (needs user Cognito + approval) |

### 7.2 Rate limits

- `POST /device_authorization`: 10 requests/hour/IP. WAF + API Gateway
  usage plan. 4 KB body cap → 413 above.
- `POST /token`: 12 requests/min/`device_code` (enforced via
  `poll_count` + `last_poll_at`); wider IP limit at API Gateway.
- Authenticated calls (telemetry, rotate, cbox_pull, etc): 1 req/sec
  per `edge_id`; burst allowed for reasonable client behaviour.

### 7.3 `device_token`

- 256-bit random, `dt_v1_` prefix for versioning.
- Stored server-side as `sha256(token)`, plaintext returned exactly once
  from `POST /token`.
- Default lifetime 12 months; rotation 30d before expiry.
- Stored on edge under `/opt/dhe/secrets/device-token` (0600, uid 1000).
- Never sent to Node-RED editor or Dashboard. Only the sync process
  reads it.

### 7.4 `user_code` and `device_code`

- `user_code` — 8 alphanumeric chars, hyphenated as XXXX-XXXX. Avoid
  ambiguous chars (no O/0, I/1, L/l). Case-insensitive matching. Cloud
  regenerates on collision.
- `device_code` — 128-bit random, `dc_v1_` prefix. Never displayed to
  user. Sent only in HTTPS body over TLS 1.2+.

### 7.5 CSRF on the approval endpoint

The `/link` page in Portal must:
- Require Cognito authentication (Amplify Auth middleware).
- Include a CSRF token in the form (Cognito idToken as double-submit).
- Reject GET-based approval (mutations only via POST + form token).

### 7.6 Transport

TLS 1.2+ everywhere. Cert from ACM. Edge validates chain against system
CA bundle; no custom trust.

---

## 8. Amplify Gen2 implementation sketch

For the dark factory team:

- **HTTP API** at `api.digitalhome.cloud/edge/v1/*`.
- **Lambdas:**
  - `edge-device-authz` — `POST /device_authorization`. Generates codes,
    writes DeviceCodes row.
  - `edge-token` — `POST /token`. Reads DeviceCodes, on `approved`
    creates EdgeRegistry row, mints token, returns.
  - `edge-telemetry` — `POST /telemetry`. Verifies bearer, updates
    EdgeRegistry.
  - `edge-token-rotate` — `POST /token/rotate`. Verifies bearer, issues
    new token, keeps old valid 60s.
- **DDB:** `DeviceCodes` (TTL) + `EdgeRegistry` (durable) as §5.
- **Portal `/link` page:**
  - Route `portal.digitalhome.cloud/link?user_code=...`.
  - Cognito Hosted UI redirect if not authenticated.
  - After login: display device_info, dropdown of user's SmartHomes,
    Approve/Deny buttons.
  - `Approve` calls `approveDeviceCode(user_code, home_id)` AppSync
    mutation → writes to DeviceCodes.
  - `Deny` calls `denyDeviceCode(user_code)` → writes `denied` status
    → row deleted at next TTL sweep.
- **Push channel** (deploy-triggered cbox updates): API Gateway v2
  WebSocket at `wss://push.digitalhome.cloud/edge/v1/{edge_id}`.
  Authenticated on connect with the same device_token. Alternative:
  MQTT via IoT Core — decision item.
- **CloudWatch:** structured logs with `device_code_hash`, `edge_id`,
  IP, latency. Metric filters on 4xx and abuse patterns.

### 8.1 IAM scoping

- `edge-device-authz-role`: DDB `PutItem` on DeviceCodes only.
- `edge-token-role`: DDB `GetItem/UpdateItem/DeleteItem` on DeviceCodes,
  `PutItem` on EdgeRegistry, KMS `Encrypt` for token hash.
- `edge-telemetry-role`: `GetItem/UpdateItem` on EdgeRegistry.
- Portal `approve/deny` Lambdas: `GetItem/UpdateItem` on DeviceCodes,
  scoped by the caller's cognito_sub matching a valid SmartHome
  membership.

### 8.2 Multi-region

- Primary: eu-central-1.
- DDB global tables → eu-west-1 passive replica.
- Route 53 health-check flip on failure.
- RPO ≤ 5min, RTO ≤ 30min.

---

## 9. Edge-side (this repo)

Implementation lives in `contrib/dhc-sync/` (Node-RED palette). Behaviour:

### 9.1 State machine

```
[BOOT]
   │  is /opt/dhe/secrets/device-token present?
   ├── yes ──→ [LINKED] (skip to telemetry loop)
   └── no  ──→ [UNLINKED]

[UNLINKED]
   │  POST /device_authorization
   │  ← user_code, device_code, verification_uri, expires_in, interval
   ▼
[AWAITING_APPROVAL]
   │  render dashboard: QR + user_code + status
   │  poll POST /token every `interval` seconds
   │  ├── authorization_pending → loop
   │  ├── slow_down → increase interval by 5, loop
   │  ├── access_denied → [DENIED]
   │  ├── expired_token → [UNLINKED] (restart)
   │  └── 200 { access_token, home_id } → [LINKED]

[LINKED]
   │  persist device_token to /opt/dhe/secrets/device-token
   │  render dashboard: "linked to {home_id} ✓"
   │  POST /telemetry (kind: full) once
   │  every 60s: POST /telemetry (kind: delta) — driven by server's poll_after_s
   │  every ~11 months: POST /token/rotate
   │  on 410 Gone → wipe secrets → [UNLINKED]

[DENIED]
   │  dashboard: "Device was denied. Restart to try again."
   │  → sits in this state until operator restarts Node-RED or clicks Retry
```

### 9.2 Dashboard flow

Hosted by `@flowfuse/node-red-dashboard` v2. Auto-added to the Node-RED
project by `dhc-sync` on install.

- **Setup tab** (visible only while `status != linked`):
  - Big card: "Not linked. Approve on your phone."
  - QR code encoding `verification_uri_complete` (generated inline by
    `qrcode-svg` library packaged with `dhc-sync`).
  - Big `user_code` text as fallback.
  - Live status: "Waiting for approval…" → "Approved!" → "Linked to
    DE-80331-MAR12-01 ✓" (tab disappears from menu once linked).
  - "Restart pairing" button (calls `POST /device_authorization` again).

- **Status tab** (visible only while `status == linked`):
  - Home ID, edge ID, token expiry, last telemetry timestamp.
  - "Unlink this edge" button (calls a local disable + wipes local token;
    admin must still Revoke on the cloud side for full removal).

### 9.3 Files on the edge

- `/opt/dhe/secrets/device-token` — plaintext token, 0600 uid 1000.
- `/opt/dhe/secrets/edge-id` — cloud-issued edge_id, 0600.
- `/opt/dhe/config/dhe.config.cache` — includes `cloud.api_url` and the
  discovered `cloud_endpoints` object from the token response.

The initial `machine_id` reads from `/etc/machine-id`. If unreadable
(container can't see it), the sync palette generates a persistent
UUIDv7 into `/opt/dhe/secrets/machine-id` on first boot and uses that
instead. Documented on the box for the operator.

---

## 10. Versioning + compatibility

- Every request and response carries `protocol_version` where
  applicable. RFC 8628 endpoints use OAuth's own extension mechanism
  (unknown fields ignored).
- Bumps to `protocol_version` mean incompatible schema change.
- Server maintains N-1 support 12 months post-bump.
- Additive changes (new optional field, new endpoint) don't bump.

---

## 11. Open items for the dark factory team

- [ ] Confirm base URL: `api.digitalhome.cloud/edge/v1` — or `edge.digitalhome.cloud`?
- [ ] Portal `/link` page: new page in the Portal repo? Or under Modeler?
- [ ] Push-channel transport: API Gateway v2 WebSocket vs. IoT Core MQTT.
- [ ] `expires_in` for `device_token` — 12 months proposed.
- [ ] `device_code` and `user_code` character sets, lengths, collision
      strategy.
- [ ] Rate limits: confirm 10/hour/IP for `/device_authorization`,
      12/min/`device_code` for `/token`.
- [ ] Region + DR: eu-central-1 + eu-west-1 replica.
- [ ] Response caching for `cbox_pull` (separate spec).
- [ ] Approval UX in Portal `/link`: dropdown of user's SmartHomes vs.
      always-create-new; policy on multi-home users.

Once settled, this doc moves to v1.0 and freezes.
