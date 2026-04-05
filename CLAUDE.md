# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## What this repo is

Application layer for **digitalhome.edge** — the local edge server running on
`DLAB5-M92P-01` (192.168.1.10). Read `SPEC.md` for the full architecture before
making any changes.

## The golden rule

**Node-RED owns all devices. The MCP server never talks to devices directly.**

- Homematic CCU (`homematic-ccu`) and Philips Hue Bridge (`hue-bridge`) are only
  accessed through Node-RED flows.
- The MCP server calls Node-RED HTTP-in endpoints (`/api/*`) exclusively.
- Claude calls MCP tools. MCP calls Node-RED. Node-RED calls devices.
- If you find yourself writing code that talks directly to device IPs
  from the MCP server — stop. That logic belongs in a Node-RED flow.

## Repository layout

```
mcp-server/   Python FastMCP server — tools only, no device logic
flows/        Node-RED flow exports + HTTP-in endpoint catalogue
db/           SQLite schema and migrations
bin/          CLI utilities (dhcedge)
docs/         Architecture and agent guidance
```

## Device hostnames

Flows use DNS hostnames, never hardcoded IPs. The mapping is in the config
cache under `devices` and written to `/etc/hosts` by `dhcedge update-hosts`.

| Hostname | Default IP | Device |
|---|---|---|
| `homematic-ccu` | 192.168.1.2 | Homematic CCU |
| `hue-bridge` | 192.168.1.15 | Philips Hue Bridge |
| `digitalhome-edge` | 127.0.0.1 | Self-reference (hardcoded) |

## Sensitive data

- `digitalhome.edge.config.cache` is gitignored — it holds all local secrets
  (device IPs, API keys, credential secret, DB path).
  See `digitalhome.edge.config.cache.example` for the v2 schema.
- `.env` is kept for systemd/process-level overrides only; config cache takes
  precedence at runtime.
- The SQLite database (`*.db`) is gitignored — lives on the server at
  `/home/dhc-svc/digitalhome-edge/db/digitalhome.db`
- Node-RED credentials are encrypted in `flows_cred.json` (inside the
  Node-RED project directory, never committed to this repo).
- Never put device IPs, API keys, or credentials in committed files.

## Local config cache (`digitalhome.edge.config.cache`)

The MCP server writes this JSON file on first startup (seeded from `.env` or
hardcoded defaults). Operators edit it directly for local configuration.
Eventually `digitalhome.cloud` will push config updates into this file.

To bootstrap a new server:
1. Copy `digitalhome.edge.config.cache.example` → `digitalhome.edge.config.cache`
2. Fill in `cloud.api_key`, `instance.id`, `instance.name`
3. Start the MCP server — it reads the cache, skips rewriting it

## MCP server (`mcp-server/server.py`)

- Runtime: Python 3.12, venv at `/home/dhc-svc/mcp-server/venv/`
- Framework: FastMCP (`mcp` package)
- Transport: SSE on `:8000`
- Runs as: `dhc-svc` via `mcp-server.service`
- Config loaded from `digitalhome.edge.config.cache` (JSON) — not from env vars directly
- Tools talk to Node-RED via `httpx` — keep tools thin, no business logic in them

## Node-RED flows (`flows/`)

- Node-RED runs as `dhc-svc` on `:1880`, userDir `/home/dhc-svc/.node-red`
- **Node-RED Projects** is enabled — flows live in a separate git repo at
  `/home/dhc-svc/.node-red/projects/digitalhome-flows/`
- Credentials are encrypted in `flows_cred.json` (credential secret stored
  in config cache at `nodered.credential_secret`)
- Palettes installed: `node-red-contrib-ccu`, `node-red-contrib-huemagic`
- Periodic snapshots go to `flows/exported/` in this repo for backup/review
- `flows/flow-api.md` is the **source of truth** for HTTP-in endpoints.
  Keep it updated whenever you add or change an endpoint.
- HTTP-in endpoints follow the convention in SPEC.md (`/api/state/all`, etc.)
- **Use hostnames** (`homematic-ccu`, `hue-bridge`) in all flow config nodes,
  never hardcoded IPs

## Database (`db/`)

- SQLite — schema in `db/schema.sql`, migrations in `db/migrations/`
- Three tables: `knowledge`, `agent_log`, `device` — see SPEC.md for schema
- Never modify the DB file directly; go through MCP tools or migrations
- Name migration files: `001_initial.sql`, `002_add_column.sql`, etc.

## Shared agent memory — important behaviour

When a Claude agent discovers something non-obvious (a device quirk, a failure mode,
a working pattern), it **must** call `kb_add` to write it to the knowledge base.
Before attempting anything with a device or flow, call `kb_search` first.

This is how multiple agents build shared institutional knowledge over time.

## Deploying changes to the server

After committing to this repo, deploy to the server:

```bash
# on DLAB5-M92P-01 as frank-uwe
cd /home/dhc-svc/digitalhome-edge
git pull
sudo systemctl restart mcp-server   # if mcp-server/ changed
sudo systemctl restart nodered      # if flows changed
```

The repo should be cloned at `/home/dhc-svc/digitalhome-edge/` on the server.
For a full fresh install (new server), use the install script:
```bash
sudo bash install.sh --mode prod    # or --mode stage
```
See `docs/install.md` for the full install procedure and post-install steps.

Use `dhcedge` to manage the server:
```bash
dhcedge status          # show service state
sudo dhcedge start      # bring up services
sudo dhcedge stop       # take down services
sudo dhcedge update-hosts  # regenerate /etc/hosts from config cache
dhcedge show-config     # view config (secrets redacted)
```

## Web UX

Operational UI (device control, scenes, sensors) → **Node-RED Dashboard v2**
(`@flowfuse/node-red-dashboard` palette), served at `:1880/ui`. No separate
frontend server needed. Install the palette in Node-RED, then build dashboard
tabs alongside the flows.

## What's not done yet (open items)

See `SPEC.md` → Open Items section.
