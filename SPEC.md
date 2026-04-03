# digitalhome-edge — Specification

## Overview

**digitalhome.edge** is the local edge server for the digitalhome platform. It bridges
`digitalhome.cloud` (AWS REST backend) with local smarthome hardware, and runs a Claude
agent that acts as an autonomous digitalhome admin.

This repository contains the **application layer** running on `DLAB5-M92P-01`
(ThinkCentre M92p, Ubuntu 24.04.2 LTS headless, `192.168.1.10`).

---

## Tiers

| Tier | Description |
|---|---|
| **Basic** | Node-RED bridge: routes data between digitalhome.cloud and local devices |
| **Advanced** | Basic + Claude agent: automates backend tasks, learns from history, acts as admin |

This deployment is **Advanced**.

---

## Architecture

```
digitalhome.cloud (AWS REST)
        │  HTTP REST
        ▼
┌───────────────────────────────────────────┐
│             Node-RED  :1880               │
│                                           │
│  node-red-contrib-ccu   ← Homematic CCU   │
│  node-red-contrib-huemagic ← Hue Bridge  │
│                                           │
│  HTTP-in /api/*  ← MCP server calls here │
│  HTTP-out        → digitalhome.cloud      │
└──────────────────┬────────────────────────┘
                   │ HTTP localhost
                   ▼
┌───────────────────────────────────────────┐
│         MCP Server  :8000  (SSE)          │
│         Python / FastMCP                  │
│                                           │
│  tools: nodered_query, nodered_trigger,   │
│         nodered_inject, nodered_get_flows │
│         cloud_get, cloud_post, cloud_patch│
│         kb_search, kb_add,                │
│         agent_log_write                   │
└──────────────────┬────────────────────────┘
                   │ MCP SSE
                   ▼
┌───────────────────────────────────────────┐
│         Claude Agent (dhc-svc)            │
│         digitalhome admin                 │
└───────────────────────────────────────────┘
                   │ read/write
                   ▼
┌───────────────────────────────────────────┐
│         SQLite  (shared memory DB)        │
│  knowledge — practices, limitations,      │
│              device notes, incidents      │
│  agent_log — decision audit trail         │
│  device    — canonical device registry    │
└───────────────────────────────────────────┘
```

---

## Local Hardware

| Device | Protocol | IP |
|---|---|---|
| Homematic CCU | BidCos-RF / XML-RPC | 192.168.1.2 |
| Philips Hue Bridge | REST | 192.168.1.15 |
| This edge server | — | 192.168.1.10 |

Sensitive values (API keys, credentials) live in `/home/dhc-svc/mcp-server/.env` on the
server — never committed to this repo. Use `.env.example` as the template.

---

## Repository Structure

```
digitalhome-edge/
  mcp-server/
    server.py          ← FastMCP server, 7 tools
    requirements.txt
    .env.example
  flows/
    exported/          ← Node-RED flow JSON exports (committed)
    flow-api.md        ← HTTP-in endpoint catalogue (source of truth)
  db/
    schema.sql         ← SQLite schema
    migrations/        ← numbered migration files (001_*.sql, ...)
  docs/
    architecture.md    ← detailed diagrams
    agent-guide.md     ← how Claude should reason about this system
  SPEC.md              ← this file
  CLAUDE.md            ← Claude Code instructions
```

---

## Node-RED Flow API

Node-RED exposes HTTP-in endpoints on `localhost:1880`. These are the **only** interface
the MCP server uses for device control. All endpoints return JSON.

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

See `flows/flow-api.md` for the full catalogue as flows are built out.

---

## Shared Memory Database

**Location on server:** `/home/dhc-svc/digitalhome-edge/db/digitalhome.db` (SQLite,
gitignored)

### Tables

**`knowledge`** — persistent agent memory
```
id, type, topic, content, tags, source_agent, created_at, updated_at
```
Types: `practice`, `limitation`, `device_note`, `automation`, `incident`

Example entries:
- `limitation` / `homematic` / "LEVEL datapoint uses float 0.0–1.0, not 0–100"
- `practice` / `hue` / "Always dim to 1 before off for bulb longevity"
- `incident` / `heating` / "CCU drops BidCos-RF connection if polled > 1/sec"

**`agent_log`** — audit trail of agent decisions
```
id, agent_id, action, tool_called, payload, result, outcome, created_at
```

**`device`** — canonical device registry
```
id, name, protocol, address, room, type, last_seen, notes
```

---

## MCP Tools Reference

| Tool | Description |
|---|---|
| `nodered_get_flows()` | List all Node-RED flows — discover endpoints before calling |
| `nodered_query(endpoint)` | GET a Node-RED endpoint — read device/system state |
| `nodered_trigger(endpoint, payload)` | POST to a Node-RED endpoint — trigger action/scene |
| `nodered_inject(node_id)` | Trigger a specific inject node by ID |
| `cloud_get(path)` | GET from digitalhome.cloud REST API |
| `cloud_post(path, payload)` | POST to digitalhome.cloud REST API |
| `cloud_patch(path, payload)` | PATCH a resource on digitalhome.cloud REST API |
| `kb_search(query, type?)` | Full-text search the knowledge base |
| `kb_add(type, topic, content, tags?)` | Write a new knowledge entry |
| `agent_log_write(action, tool, result, outcome)` | Log an agent decision |

---

## Component Inventory & Licences

> **Requirement:** all software components running on the edge server must be
> open source or freely self-hostable without a commercial subscription.

### Open source ✓

| Component | Role | Licence |
|---|---|---|
| [Node-RED](https://nodered.org) | Flow engine, device bridge, web UI host | Apache 2.0 |
| [node-red-contrib-ccu](https://github.com/hobbyquaker/node-red-contrib-ccu) | Homematic CCU integration | MIT |
| [node-red-contrib-huemagic](https://github.com/Fodlos/node-red-contrib-huemagic) | Philips Hue integration | MIT |
| [@flowfuse/node-red-dashboard](https://github.com/FlowFuse/node-red-dashboard) | Dashboard UI palette for Node-RED | Apache 2.0 |
| [Python 3.12](https://python.org) | MCP server runtime | PSF |
| [FastMCP (`mcp`)](https://github.com/modelcontextprotocol/python-sdk) | MCP server framework | MIT |
| [httpx](https://www.python-httpx.org) | Async HTTP client | BSD-3-Clause |
| [aiosqlite](https://github.com/omnilib/aiosqlite) | Async SQLite wrapper | MIT |
| [python-dotenv](https://github.com/theskumar/python-dotenv) | `.env` loader | BSD-3-Clause |
| [SQLite](https://sqlite.org) | Embedded database | Public domain |
| [Ubuntu Server 24.04 LTS](https://ubuntu.com) | Host OS | Various OSS |
| [MCP protocol spec](https://modelcontextprotocol.io) | Agent-tool communication protocol | MIT |

### Proprietary — accepted exceptions

| Component | Role | Notes |
|---|---|---|
| **Claude (Anthropic)** | AI agent | Proprietary commercial model. The MCP protocol and SDK are open source; the model itself is not. Acceptable because the edge server is not *dependent* on Claude — it can be replaced by any MCP-compatible agent. |
| **Homematic CCU firmware** | Device controller firmware | Proprietary (eQ-3 hardware). Local-only, no cloud dependency. |
| **Philips Hue Bridge firmware** | Light controller firmware | Proprietary (Signify hardware). Local API used; no Hue cloud dependency. |

### Note on FlowFuse

`@flowfuse/node-red-dashboard` (the npm package) is Apache 2.0. FlowFuse also
sells a commercial hosted platform — that product is not used here. The
self-hosted dashboard palette has no commercial dependency.

---

## Service Accounts & Ports

All services run as `dhc-svc` (system account, no login shell).

| Service | Port | Systemd unit |
|---|---|---|
| Node-RED | 1880 | `nodered.service` |
| MCP Server | 8000 | `mcp-server.service` |
| SSH | 22 | `ssh.service` |

Firewall: `ufw` — only ports 22, 1880, 8000 open.

---

## Open Items

- [ ] Hue API key — register at `http://192.168.1.15/debug/clip.html`, add to `digitalhome.edge.config.cache`
- [ ] digitalhome.cloud URL + API key — add to `digitalhome.edge.config.cache` (cloud-sync will automate this later)
- [ ] Build initial Node-RED flows for Homematic + Hue
- [x] Implement `kb_search` / `kb_add` / `agent_log_write` MCP tools
- [x] Create SQLite schema (DB auto-initialised on first server startup)
- [ ] Export first flow snapshot to `flows/exported/`
- [ ] Write `flows/flow-api.md` endpoint catalogue
- [ ] Install Node-RED Dashboard v2 (`@flowfuse/node-red-dashboard`) for operational web UX at `:1880/ui`
- [ ] Implement cloud config sync from `digitalhome.cloud` → `digitalhome.edge.config.cache`
