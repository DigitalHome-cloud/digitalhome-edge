# Edge ↔ Cloud API — Registration, Linkage, Heartbeat

**Status:** Draft v0.1
**Owner (cloud side):** dark factory team (`digitalhome-cloud-darkfactory/`)
**Owner (edge side):** `digitalhome-edge`
**Date:** 2026-07-01

This document is the **contract** between digitalhome.edge boxes and the
digitalhome.cloud control plane. Neither side may change the wire without
updating this file. Fields not listed here are reserved for future use — clients
should ignore unknown fields (forwards-compat) and servers should return only
listed fields (backwards-compat).

---

## 1. Goals

- Every edge box, on first boot, registers itself with the cloud without any pre-shared identity.
- The cloud issues a stable `edge_id` and a short human-typeable `pairing_code`.
- The operator/admin sees pending registrations, matches physical box to record via `pairing_code`, and links the edge to a SmartHome.
- Once linked, the edge gets a `device_token` used to authenticate every subsequent call.
- No secret material lives in the edge image or the git repo; everything is minted at first contact.

Non-goals for v0.1:
- End-to-end trust anchoring via hardware root-of-trust (TPM, secure element).
- Mutual TLS with per-device certificates.
- Federated multi-cloud (this spec targets AWS Amplify Gen2 exclusively).

---

## 2. Actors and flow

```
                     ┌───────────────────────┐
                     │    digitalhome.cloud  │
                     │  Amplify Gen2 (AWS)   │
   ┌─────────┐       │                       │       ┌──────────────┐
   │   edge  │       │  ┌────────────────┐   │       │  SmartHome   │
   │   box   │◄─────►│  │ Edge Reg API   │◄──┼──────►│  Admin UI    │
   └─────────┘       │  │ (this spec)    │   │       │ (Modeler/    │
        │            │  └───────┬────────┘   │       │  Portal)     │
        │            │          │            │       └──────────────┘
        │            │          ▼            │
        │            │    DynamoDB           │
        │            │    (EdgeRegistry)     │
        │            └───────────────────────┘
        │
        │  1. POST /edge/register             → returns edge_id + pairing_code
        │  2. displays pairing_code on dashboard
        │  3. admin sees pending row, links to homeId
        │  4. POST /edge/heartbeat            → returns status: "linked", homeId, device_token
        │  5. from here on: Authorization: Bearer {device_token}
```

Steps 1–2 are unauthenticated (see §7). Step 4 becomes authenticated once
`device_token` is minted.

---

## 3. Endpoints

Base URL: `https://api.digitalhome.cloud/edge/v1`
Content-Type: `application/json`
All timestamps: RFC 3339 UTC.

### 3.1 `POST /edge/register`

Called by the edge on **first boot** (`runtime.first_boot: true` in the
welcome), or when the edge has lost its `edge_id` and needs a new one.

Idempotency via `edge.machine_id`: if a row already exists for that
`machine_id` and `status ∈ {unlinked, linked}`, the cloud updates the row's
metadata (from the new welcome payload) and returns the existing
`edge_id` + `pairing_code` rather than creating a duplicate.

**Auth:** none. Rate-limited by client IP (see §7).

**Request body:** the *welcome message* (§4).

**Response 200 OK:**
```json
{
  "protocol_version": 1,
  "edge_id":       "e-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
  "pairing_code":  "ABCD-1234",
  "status":        "unlinked",
  "home_id":       null,
  "device_token":  null,
  "poll_after_s":  15,
  "cloud_endpoints": {
    "heartbeat":       "https://api.digitalhome.cloud/edge/v1/heartbeat",
    "cbox_pull":       "https://api.digitalhome.cloud/edge/v1/homes/{home_id}/cbox",
    "flow_push":       "https://api.digitalhome.cloud/edge/v1/homes/{home_id}/flows",
    "lake_ingest":     "https://api.digitalhome.cloud/edge/v1/homes/{home_id}/lake",
    "deploy_channel":  "wss://push.digitalhome.cloud/edge/v1/{edge_id}"
  },
  "server_timestamp": "2026-07-01T14:30:01Z"
}
```

**Response 400** — malformed welcome. Body: `{ "error": "...", "detail": "..." }`.
**Response 429** — rate-limited. Body includes `Retry-After` header.
**Response 5xx** — cloud failure. Edge retries with exponential backoff.

### 3.2 `POST /edge/heartbeat`

Called by the edge on a periodic interval (default 15s while unlinked, 60s
once linked — the server dictates via `poll_after_s` in each response).

**Auth (unlinked):** `edge_id` in body identifies the caller. Rate-limited
by IP + `edge_id`. This is safe because an attacker who knew `edge_id`
could only see the linkage status, not act on it.

**Auth (linked):** `Authorization: Bearer {device_token}` header. The
cloud verifies the token via the `device_token_hash` column in DynamoDB.
Missing or invalid → 401.

**Request body:**
```json
{
  "protocol_version": 1,
  "edge_id":       "e-1a2b3c4d-...",
  "boot_id":       "e6a3f240-...",
  "uptime_s":      3600,
  "client_timestamp": "2026-07-01T15:30:00Z",
  "nonce":         "9c1d3e5f7a2b4c6d8e0f1a3b5c7d9e2f",

  "delta": {
    "lan_ip":            "192.168.1.10",
    "cbox_version":      "v2026-06-28T10:00Z",
    "sw_version":        "0.3.0",
    "healthy":           true,
    "recent_errors":     []
  }
}
```

The `delta` block reports what may have changed since last heartbeat — the
cloud updates only the fields present. Small payload, frequent send.

**Response 200 OK — while unlinked:**
```json
{
  "protocol_version": 1,
  "status":        "unlinked",
  "pairing_code":  "ABCD-1234",
  "poll_after_s":  15,
  "server_timestamp": "2026-07-01T15:30:01Z"
}
```

**Response 200 OK — first linked heartbeat:** the cloud mints the device
token, stores its hash, returns the plaintext exactly once. The edge
persists it under `/opt/dhe/secrets/device-token` before the next call.
```json
{
  "protocol_version": 1,
  "status":         "linked",
  "home_id":        "DE-80331-MAR12-01",
  "device_token":   "dt_v1_a0b1c2d3e4f5...",
  "token_expires":  "2027-07-01T15:30:01Z",
  "poll_after_s":   60,
  "cbox_version":   "v2026-06-28T10:00Z",
  "server_timestamp": "2026-07-01T15:30:01Z"
}
```

**Response 200 OK — subsequent linked heartbeats:** `device_token` absent
(already issued). If the cloud wants the edge to rotate, it returns
`token_rotate_required: true` and the edge calls `POST /edge/rotate-token`.
```json
{
  "protocol_version": 1,
  "status":         "linked",
  "home_id":        "DE-80331-MAR12-01",
  "poll_after_s":   60,
  "cbox_version":   "v2026-06-30T09:00Z",
  "cbox_updated":   true,
  "server_timestamp": "2026-07-01T15:31:00Z"
}
```

**Response 401** — unlinked heartbeat with wrong `edge_id`, or linked
heartbeat with wrong/expired `device_token`. Edge should re-register.
**Response 410 Gone** — box has been `revoked` by the admin. Edge should
delete its local secrets and fall back to fresh `POST /edge/register`.

### 3.3 `POST /edge/rotate-token`

Called by the edge when the current token nears expiry, or when the cloud
sets `token_rotate_required: true` in a heartbeat.

**Auth:** `Authorization: Bearer {current_device_token}`.

**Request body:** empty.

**Response 200 OK:** new token, same shape as first linked heartbeat.
Old token remains valid for 60s to cover race conditions.

### 3.4 Admin-facing endpoints (out of scope for this spec)

Endpoints for listing pending edges, linking, revoking — served by the
Modeler/Portal SmartHome admin UI over AppSync GraphQL against the same
DynamoDB. Not part of the edge-facing wire. Reference here so the schema
supports them:

- `list unlinked edges filtered by cognitoSub of the admin's SmartHome`
- `link(edge_id, home_id)` — sets `status: linked`, writes `home_id`
- `revoke(edge_id)` — sets `status: revoked`

---

## 4. The welcome message (schema)

```json
{
  "protocol_version": 1,

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
    "git_sha":          "02a50f0",
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
    "mcp": {
      "enabled":        true,
      "transports":     ["sse"]
    },
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
    "first_boot":       true,
    "config_cache_version": 3
  },

  "client_timestamp":   "2026-07-01T14:30:00Z",
  "nonce":              "3f8a52c1b7d9e4f6a2c8b0d3e5f7a9c1"
}
```

### 4.1 Field constraints

| Field | Type | Validation | Notes |
|---|---|---|---|
| `edge.machine_id` | string | `[0-9a-f]{32}` | From `/etc/machine-id`. Primary dedup key. |
| `edge.hostname` | string | RFC 1123, ≤ 253 chars | For admin identification only. |
| `edge.mac_primary` | string | `xx:xx:xx:xx:xx:xx` | Physical NIC. For admin identification. |
| `edge.lan_ip` | string | IPv4/IPv6 | Self-reported; cloud logs source IP separately. |
| `edge.timezone` | string | IANA tz | e.g. `Europe/Brussels`. |
| `software.dhe_version` | string | semver | Image release version. |
| `software.git_sha` | string | `[0-9a-f]{7,40}` | Commit that built the image. |
| `capabilities.protocols` | array | ∈ `{homematic, hue, matter, mqtt, zwave, smartthings}` | Extend as protocols are added. |
| `capabilities.tier` | string | ∈ `{basic, advanced}` | Per SPEC.md tier definition. |
| `runtime.boot_id` | string | UUID | From `/proc/sys/kernel/random/boot_id`. |
| `runtime.first_boot` | bool | | `true` iff `/opt/dhe/secrets/device-token` doesn't exist. |
| `runtime.config_cache_version` | int | ≥ 1 | Bump when `dhe.config.cache` schema changes. |
| `client_timestamp` | string | RFC 3339, ±5min from server | Cloud logs skew; > 5min → 400. |
| `nonce` | string | `[0-9a-f]{32}` | Client-generated. Ignored today; signed handshake later. |

### 4.2 What is NOT in the welcome (and why)

- **`home_id`** — the edge doesn't know its home yet; that's what registration + linking is for.
- **Device tokens, API keys, credentials** — cloud has no need. Sending secrets to prove identity is worse than a signed handshake, which is Phase 2.
- **Device inventory** (CCU / Hue devices seen on the LAN) — too early. Push after linking, via a separate `POST /edge/v1/inventory` endpoint (out of scope here).
- **Anything about which admin/user should own this box** — the admin claims it by clicking `link` in the UI; edge has no user context.

---

## 5. DynamoDB schema (`EdgeRegistry`)

```
PK: edge_id                    "e-1a2b3c4d-..."
SK: "META"                     (single-item design; edges rarely need history in the hot path)

GSI1_PK: machine_id            (dedup lookup during register)
GSI1_SK: "META"

GSI2_PK: pairing_code          (admin looks up by code during link)
GSI2_SK: "META"                (TTL-scoped: 24h from creation while unlinked)

GSI3_PK: home_id               (admin lists all edges under their home)
GSI3_SK: edge_id

Attributes:
    machine_id                 (indexed)
    pairing_code               (indexed, TTL 24h if unlinked)
    status                     enum: unlinked | linked | revoked
    home_id                    string | null
    device_token_hash          sha256(device_token) | null    ← never store plaintext
    token_expires              iso8601 | null
    first_seen_at              iso8601
    last_welcome_at            iso8601
    last_heartbeat_at          iso8601
    welcome                    map — the full latest welcome
    delta_history              list — last 20 heartbeat deltas
    linked_at                  iso8601 | null
    linked_by_cognito_sub      string | null    ← audit trail
    revoked_at                 iso8601 | null
    revoked_reason             string | null
```

**TTL on pairing_code index** (GSI2): 24h. Unclaimed pairings expire; the
edge falls through to a new POST /edge/register and gets a fresh code.
Linked edges keep the `pairing_code` in the base row but drop from GSI2.

**Encryption:** table encrypted at rest with an AWS KMS CMK. Point-in-time
recovery enabled. Backups retained 30 days.

---

## 6. Lifecycle

```
[NEW]
  │
  │  POST /edge/register  ─→  row created in EdgeRegistry
  │                            status = unlinked
  │                            edge_id + pairing_code returned
  ▼
[UNLINKED]  ────────── admin does NOT link within 24h ─────────► [EXPIRED_UNLINKED]
  │                                                                   │
  │  admin clicks Link in UI                                           │
  │  → status = linked                                                 │
  │  → home_id set                                                     │
  ▼                                                                    │
[LINKED]                                                               │
  │                                                                    │
  │  edge does POST /edge/heartbeat                                    │
  │  → cloud mints device_token, stores hash                           │
  │  → returns plaintext once                                          │
  │  edge writes /opt/dhe/secrets/device-token                         │
  │                                                                    │
  │  ─── steady state: heartbeats every 60s ───                        │
  │                                                                    │
  │  admin clicks Revoke  ─→  status = revoked  ─→ [REVOKED]           │
  │                                                                    │
  ▼                                                                    ▼
[LINKED]                                                          [EXPIRED_UNLINKED]
                                                                       │
                                                                       ▼
                                                              cleaned up by TTL
```

**State transitions:**
- `unlinked → linked` — admin action via GraphQL mutation.
- `unlinked → expired` — TTL sweep (row deleted).
- `linked → revoked` — admin action.
- `revoked → *` — none. Edge must re-register (new `edge_id`) if it wants back in.

---

## 7. Security

### 7.1 Register endpoint (unauthenticated)

The register call is unauthenticated by design — the edge has no
credentials at first boot. Defences:

- **Rate limit:** API Gateway usage plan, 10 requests/hour/IP for
  `POST /edge/register`. WAF rule to reject when exceeded.
- **Body-size cap:** 4 KB max on the welcome; return 413 above.
- **TTL cleanup:** unlinked rows expire in 24h. A flood of registers
  auto-cleans.
- **Cost fuse:** CloudWatch alarm on DynamoDB write throttles → SNS to
  ops. Sustained abuse triggers a temporary API Gateway shutdown.

### 7.2 Trust anchoring

The trust anchor is the **admin's visual confirmation**: they see a
pending row with `pairing_code = ABCD-1234`, they look at the physical
box's dashboard which shows `ABCD-1234`, they click Link. No third party
can hijack this without physical access to the box.

An attacker who forges a welcome message gets an `edge_id` and
`pairing_code` for a fake box. Without admin action, the row expires
harmlessly. The attack yields nothing.

### 7.3 device_token

Minted server-side, returned in plaintext exactly once (first linked
heartbeat), stored server-side only as sha256. Client stores under
`/opt/dhe/secrets/device-token` mode 0600 uid 1000. Rotation every 12
months (or on demand via `token_rotate_required`).

If the edge loses its token (disk failure, image reset), it falls back
to `POST /edge/register` with the same `machine_id` — the cloud finds
the existing row, but requires the admin to re-confirm via the pairing
UI before minting a new token. This prevents token theft via disk copy.

### 7.4 Transport

TLS 1.2+ required. Cert from ACM, pinned to `*.digitalhome.cloud`.
Edge validates the cert chain against the system CA bundle
(no custom trust).

---

## 8. Amplify Gen2 implementation sketch

The dark factory team implements against Amplify Gen2:

- **API Gateway (HTTP API)** at `api.digitalhome.cloud/edge/v1/*`.
- **Lambda handlers:**
  - `edge-register` — handles `POST /register`. Reads welcome, dedupes
    by `machine_id`, mints `edge_id` + `pairing_code`, writes to DDB.
  - `edge-heartbeat` — handles `POST /heartbeat`. Validates token if
    linked, updates row, returns state.
  - `edge-rotate-token` — handles `POST /rotate-token`.
- **DynamoDB table:** `EdgeRegistry` with three GSIs as in §5.
- **Cognito** — not used on the edge-facing side. Used by the admin UI
  (Modeler/Portal) which queries the same table via AppSync.
- **CloudWatch** — every request logged with `edge_id`, `machine_id`, IP,
  latency. Metric filters on 4xx/5xx rates.

### 8.1 IAM notes

The Lambda handlers get scoped IAM roles:

- `edge-register-role`: DDB `PutItem` + `Query` on `EdgeRegistry` and its
  GSIs. Cannot read `device_token_hash` of other rows.
- `edge-heartbeat-role`: `GetItem`, `UpdateItem` on `EdgeRegistry`. Can
  write `device_token_hash`.
- `edge-rotate-token-role`: same as heartbeat.

Admin-facing Lambda (out of scope) uses a separate role with
`Query`/`UpdateItem` scoped by cognito-issued `home_id` claim.

### 8.2 Multi-region / disaster recovery

- Primary region: eu-central-1 (aligns with likely customer base and
  data-residency).
- DDB global tables to eu-west-1 as passive replica.
- Route 53 health checks flip API Gateway custom domain on region failure.
- Recovery objective: RPO ≤ 5min, RTO ≤ 30min.

---

## 9. Edge-side responsibilities

For clarity — this section describes what `node-red-contrib-dhc-sync`
does on the edge to consume this API. Owned by the edge team, listed
here for round-trip completeness.

1. **On boot,** read `/etc/machine-id`, gather system info, build the
   welcome payload.
2. **If `/opt/dhe/secrets/device-token` exists:** skip register, go to
   heartbeat.
3. **Otherwise:** `POST /edge/register`, persist returned `edge_id` and
   `pairing_code` under `/opt/dhe/secrets/`. Display `pairing_code` on
   the Node-RED Dashboard and print to logs.
4. **Loop:** `POST /edge/heartbeat` every `poll_after_s` seconds.
5. **On first `linked` response:** persist `device_token` to
   `/opt/dhe/secrets/device-token` (mode 0600), stop showing pairing UI.
6. **On `410 Gone`:** delete all local secrets, restart the sync flow
   from step 1.
7. **On repeated 401:** treat as token expired; call
   `POST /edge/rotate-token`; on repeated failure, re-register.

---

## 10. Versioning + compatibility

- Every request and response carries `protocol_version`.
- Bumps to `protocol_version` mean incompatible schema change.
- Server maintains N-1 support (accepts version N-1 clients for 12
  months after a bump).
- Adding new *optional* fields is a minor change, no version bump.
- Adding a new endpoint is a minor change.
- Removing a field or changing semantics of an existing field is a major
  change → version bump.

---

## 11. Open items for the dark factory team

- [ ] Confirm base URL: `api.digitalhome.cloud/edge/v1` — or a different
      subdomain like `edge.digitalhome.cloud`?
- [ ] Decide token TTL (12 months proposed above).
- [ ] Decide push channel: WebSocket (native to API Gateway v2 already),
      MQTT (needs IoT Core), or SSE from CloudFront?
- [ ] Rate limits — confirm 10/hour/IP for register, 60/hour/`edge_id`
      for heartbeat.
- [ ] Region choice — confirm eu-central-1 primary.
- [ ] DR strategy — confirm DDB global tables + Route 53 health checks.
- [ ] Whether to expose `edge_id` in URL paths (currently only in body).
- [ ] Response caching / conditional GET headers for `cbox_pull`
      (separate spec).

Once these are settled, this doc moves to `v1.0` and freezes.
