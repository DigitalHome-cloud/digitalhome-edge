# digitalhome-edge — Current-State Specification

> **This document describes what is running today.** For the *target*
> architecture the product is migrating toward, see
> [`docs/architecture.md`](docs/architecture.md) (SLAB5 spec). Deltas between
> the two, and the migration plan, are captured in ADR
> [`docs/adr/0001-dhe-alignment.md`](docs/adr/0001-dhe-alignment.md).

## Overview

**digitalhome.edge** is the local edge server for the digitalhome platform.
It bridges `digitalhome.cloud` with local smarthome hardware and hosts a
Node-RED–embedded MCP server that Claude connects to.

This repository contains the application layer. On a running box it
deploys as a Docker Compose stack under `/opt/dhe/`.

| Environment | Server | Branch |
|-------------|--------|--------|
| **Stage** | DLAB5-W541-01 (ThinkPad W541, Ubuntu 24.04) | `stage` |
| **Production** | DLAB5-M92P-01 (ThinkCentre M92p, Ubuntu 24.04 headless) | `main` |

Deploy: pipeline-based via GitHub — each server tracks its branch.

---

## Tiers

| Tier | Description |
|---|---|
| **Basic** | Node-RED bridge: routes data between digitalhome.cloud and local devices |
| **Advanced** | Basic + Claude agent: MCP tools + resources exposed on the same Node-RED, callable by Claude |

This deployment is **Advanced**.

---

## Architecture

One container, one runtime — Node-RED with a custom set of palettes:

```
digitalhome.cloud (AWS Amplify Gen2)
        │  HTTPS
        ▼
┌───────────────────────────────────────────────────────┐
│   dhe-nodered container  (Node-RED 4.0.9, port 1880)  │
│                                                       │
│   device palettes:                                    │
│     node-red-contrib-ccu       → Homematic CCU        │
│     node-red-contrib-huemagic  → Philips Hue Bridge   │
│     @flowfuse/node-red-dashboard → dashboard UI       │
│                                                       │
│   dhe palettes (in-tree, contrib/):                   │
│     node-red-contrib-dhc-mcp   → MCP server surface   │
│       endpoints: /mcp/sse, /mcp/messages/*,           │
│                  /mcp/health                          │
│       nodes: mcp-server-config, mcp-tool-in,          │
│              mcp-resource-in, mcp-response            │
│                                                       │
│     node-red-contrib-dhc-sync  → cloud OAuth + sync   │
│       nodes: dhc-sync-config, dhc-sync-status,        │
│              dhc-sync-cbox-out                        │
│                                                       │
│   auth on all surfaces:                               │
│     Node-RED editor / admin API — adminAuth (bcrypt)  │
│     /api/*                       — httpNodeAuth       │
│     /mcp/*                       — Bearer token       │
└──────────────────────────────┬────────────────────────┘
                               │
                               ▼
┌───────────────────────────────────────────────────────┐
│                Claude (Anthropic API)                 │
│   connects to MCP over SSE with Authorization: Bearer │
└───────────────────────────────────────────────────────┘
```

Systemd oneshot `dhe.service` manages the compose lifecycle.

---

## Local Hardware

| Device | Protocol | IP |
|---|---|---|
| Homematic CCU | BidCos-RF / XML-RPC | 192.168.1.2 |
| Philips Hue Bridge | REST | 192.168.1.15 |
| This edge server | — | 192.168.1.10 |

Sensitive values (API keys, credentials) live only under
`/opt/dhe/secrets/` and `/opt/dhe/config/dhe.config.cache` on the server
— gitignored, never committed. Bootstrap generates them locally on first
install. The digitalhome.cloud device flow eventually replaces the
device-side API keys with a `device_token` scoped to the linked SmartHome
(see [`docs/specs/edge-cloud-api.md`](docs/specs/edge-cloud-api.md)).

---

## Repository Structure

```
digitalhome-edge/
  contrib/
    dhc-mcp/           ← MCP server palette (in-tree; installed at build)
    dhc-sync/          ← OAuth + telemetry + dashboard palette (in-tree)
  deploy/
    docker-compose.yml ← single node-red service
    dhe.service        ← systemd oneshot
    bootstrap.sh       ← seeds /opt/dhe/ layout
    nodered/
      Dockerfile       ← nodered:4.0.9 base + palettes baked in
      entrypoint.sh    ← bcrypts secrets into settings.js on first boot
  flows/
    digitalhome-flows/ ← git submodule (Node-RED Project)
    flow-api.md        ← HTTP-in endpoint catalogue
  db/
    schema.sql         ← SQLite schema for knowledge / agent_log / device
                          (retained for reuse in a future in-container store)
    migrations/
  bin/
    dhcedge            ← CLI for the Docker stack
  docs/
    architecture.md    ← target-state (SLAB5 spec)
    install.md         ← installation procedure
    adr/               ← Architecture Decision Records
    audits/            ← security & quality audit reports
    specs/             ← wire-level specs (edge ↔ cloud)
  SPEC.md              ← this file
  CLAUDE.md            ← Claude Code instructions
```

---

## Node-RED Flow API (`/api/*`)

Node-RED exposes HTTP-in endpoints on the same port (1880) as the MCP
surface. `httpNodeAuth` in `settings.js` protects them; the operator
configures a Basic-auth client for the flows to speak with.

### Conventions

- `GET  /api/state/all`           — full snapshot of all device states
- `GET  /api/state/{room}`        — state for a specific room
- `POST /api/scene/{name}`        — activate a named scene
- `POST /api/lights/{room}/on`    — turn on lights in a room
- `POST /api/lights/{room}/off`
- `POST /api/lights/{room}/dim`   — body: `{"level": 0-100}`
- `POST /api/heating/{room}/set`  — body: `{"temp": 20.5}`
- `GET  /api/heating/status`      — all thermostat readings
- `POST /api/cloud/sync`          — push state snapshot to digitalhome.cloud
- `GET  /api/devices`             — list all devices from local inventory
- `GET  /api/devices/{class}`     — filter by DHC T-Box class
- `POST /api/devices/sync`        — discover devices from CCU + Hue

See [`flows/flow-api.md`](flows/flow-api.md) for the full catalogue as
flows are built out.

---

## MCP Server (in Node-RED)

Endpoints served by `node-red-contrib-dhc-mcp`:

| Path | Auth | Purpose |
|---|---|---|
| `GET /mcp/sse` | Bearer token | Establish SSE session (MCP transport) |
| `POST /mcp/messages/:sessionId` | Bearer token | Client → server JSON-RPC |
| `GET /mcp/health` | Bearer token | Health probe (server name, version, counts) |

The Bearer token is generated by `deploy/bootstrap.sh` on first install
and stored at `/opt/dhe/secrets/mcp-auth-token` (mode 0600).

Tools and resources register themselves via `mcp-tool-in` and
`mcp-resource-in` nodes. `mcp-response` terminates the flow and returns
the payload to Claude. The registry generates the MCP catalog and emits
`notifications/tools/list_changed` when it mutates.

---

## Cloud Sync (in Node-RED)

`node-red-contrib-dhc-sync` implements the client side of
[`docs/specs/edge-cloud-api.md`](docs/specs/edge-cloud-api.md):

1. On first boot with no `device-token`, POST `/edge/v1/device_authorization`.
2. Dashboard displays QR code + `user_code` to the operator.
3. Operator opens the URL on their phone, logs into digitalhome.cloud,
   picks the target SmartHome, approves.
4. Edge polls `/edge/v1/token` until approved, persists the returned
   `device_token`.
5. Steady state: POST `/edge/v1/telemetry` (full initial, then deltas
   every `poll_after_s`). 410 Gone wipes secrets and restarts the flow.

The state machine (BOOT / UNLINKED / AWAITING_APPROVAL / LINKED / DENIED
/ ERROR) is implemented at
[`contrib/dhc-sync/lib/state-machine.js`](contrib/dhc-sync/lib/state-machine.js).

---

## Shared Memory Database (planned, not currently active)

`db/schema.sql` defines tables (`knowledge`, `agent_log`, `device`) that
were previously served by a standalone Python MCP server. The Node-RED
container currently doesn't attach them. When the digital-twin catalog
lands (Phase 3+), the same schema will be reused in-container at
`/opt/dhe/db/digitalhome.db`.

### Tables

**`knowledge`** — persistent agent memory
```
id, type, topic, content, tags, source_agent, created_at, updated_at
```
Types: `practice`, `limitation`, `device_note`, `automation`, `incident`

**`agent_log`** — audit trail of agent decisions
```
id, agent_id, action, tool_called, payload, result, outcome, created_at
```

**`device`** — canonical device registry (DHC ontology-tagged)
```
id, name, protocol, address, room, type,
dhc_class, design_view, capability, model, manufacturer,
ccu_ise_id, hue_unique_id, last_seen, notes
```

---

## Component Inventory & Licences

> **Requirement:** all software components running on the edge server must be
> open source or freely self-hostable without a commercial subscription.

### Open source ✓

| Component | Role | Licence |
|---|---|---|
| [Node-RED](https://nodered.org) | Flow engine + HTTP surface | Apache 2.0 |
| [node-red-contrib-ccu](https://github.com/hobbyquaker/node-red-contrib-ccu) | Homematic CCU integration | MIT |
| [node-red-contrib-huemagic](https://github.com/Fodlos/node-red-contrib-huemagic) | Philips Hue integration | MIT |
| [@flowfuse/node-red-dashboard](https://github.com/FlowFuse/node-red-dashboard) | Dashboard UI palette | Apache 2.0 |
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | MCP server (used by `dhc-mcp`) | MIT |
| [qrcode](https://github.com/soldair/node-qrcode) | QR generation in `dhc-sync` pairing UI | MIT |
| [Docker Engine + Compose](https://docker.com) | Container runtime | Apache 2.0 |
| [Ubuntu Server 24.04 LTS](https://ubuntu.com) | Host OS | Various OSS |

### Proprietary — accepted exceptions

| Component | Role | Notes |
|---|---|---|
| **Claude (Anthropic)** | AI agent | Proprietary commercial model. MCP protocol and SDK are open source; the model itself is not. Acceptable because the edge is not *dependent* on Claude — any MCP-compatible agent works. |
| **Homematic CCU firmware** | Device controller firmware | Proprietary (eQ-3 hardware). Local-only. |
| **Philips Hue Bridge firmware** | Light controller firmware | Proprietary (Signify hardware). Local API only. |

---

## Ports & Services

Single systemd unit + single container. All auth-gated.

| Path | Port | Auth |
|---|---|---|
| Node-RED editor | 1880 | adminAuth (Basic + token) |
| `/api/*` (device HTTP endpoints) | 1880 | httpNodeAuth (Basic) |
| `/mcp/sse`, `/mcp/messages/*` | 1880 | Bearer token |
| Dashboard `/dashboard` | 1880 | adminAuth |
| SSH | 22 | (host-level) |

Ports 8000 and 8443 (used by the retired Python MCP container) are now
free.

---

## Open Items

- [x] Hue API key — registered and stored under `/opt/dhe/secrets/hue-api-key`
- [x] Build initial Node-RED flows for Homematic + Hue
- [x] Install Node-RED Dashboard v2 (baked into image)
- [x] Retire the systemd Python MCP stack; collapse to one container
- [x] Bearer auth on the MCP endpoint
- [x] OAuth device flow client (`dhc-sync`) + state machine + dashboard UI
- [x] Edge ↔ Cloud API spec (`docs/specs/edge-cloud-api.md`)
- [ ] Cloud side: `POST /edge/v1/device_authorization`, `/token`, `/telemetry` — implemented in `digitalhome-cloud-darkfactory`
- [x] Starter flow seeded on first boot (auto-instantiate `mcp-server-config` + `dhc-sync-config` + dashboard tabs)
- [x] Projects mode wired — `bootstrap.sh` clones `flows/digitalhome-flows` into `/opt/dhe/node-red-data/projects/`; `entrypoint.sh` seeds `.config.projects.json`. Fresh boxes boot into the active project instead of the first-run wizard.
- [x] Phase-1 data pipeline: device → A-Box filter → local JSONL buffer. Covers Hue + Homematic. See `docs/architecture.md §10 "Phase-1 pipeline"`.
- [x] Source→T-BOX mapping layer: per-integration `deploy/cbox/mappings/*.map.json` (hue, homematic, solarman) linking native fields to canonical Brick classes; replaces the inline `dhc:sourceMap/*` in `abox.jsonld`. See `docs/specs/solarman-edge-pipeline.md §2`.
- [x] Phase-2 SolarMan ingest: token → station discovery → 5-min realTime poll → raw (bronze) + Brick observations (silver) + `global.solar_latest` (gold, `GET /api/solar/status`). See `docs/specs/solarman-edge-pipeline.md`.
- [ ] Phase-1 data pipeline: Matter / SmartThings source ingest (deferred).
- [ ] Raw (bronze) tier retention/pruning job for `/timeseries/raw/*`.
- [ ] Cloud shipment of buffered observations (batch POST of `/timeseries/cbox/*.jsonl`) — needs wire spec agreed with dark-factory cloud team.
- [ ] Portal `/link` completion (approve/deny buttons wire the AppSync mutations, home picker). Spec: `docs/specs/portal-link-page.md`.
- [ ] C-BOX generator + catalog dispatch inside `dhc-mcp` (Phase 3)
- [ ] Assign room names to devices (currently all null)
- [ ] Pipeline-based deployment: stage branch → DLAB5-W541-01, main → DLAB5-M92P-01
- [ ] A-BOX / C-BOX naming reconciliation with umbrella platform specs (see `docs/architecture.md §12` Open Decision #7).
