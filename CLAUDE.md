# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## What this repo is

Application layer for **digitalhome.edge** — the local edge server running on
`DLAB5-M92P-01` (192.168.1.10). Read `SPEC.md` for the full architecture before
making any changes.

## The golden rule

**Node-RED owns all devices. The MCP server never talks to devices directly.**

- Homematic CCU (192.168.1.2) and Philips Hue Bridge (192.168.1.15) are only
  accessed through Node-RED flows.
- The MCP server calls Node-RED HTTP-in endpoints (`/api/*`) exclusively.
- Claude calls MCP tools. MCP calls Node-RED. Node-RED calls devices.
- If you find yourself writing code that talks to 192.168.1.2 or 192.168.1.15
  from the MCP server — stop. That logic belongs in a Node-RED flow.

## Repository layout

```
mcp-server/   Python FastMCP server — tools only, no device logic
flows/        Node-RED flow exports + HTTP-in endpoint catalogue
db/           SQLite schema and migrations
docs/         Architecture and agent guidance
```

## Sensitive data

- `.env` files are gitignored — never commit them
- Use `.env.example` as the template
- Real `.env` lives at `/home/dhc-svc/mcp-server/.env` on the server
- Device IPs are local-only config; keep them out of committed files
- The SQLite database (`*.db`) is gitignored — lives on the server at
  `/home/dhc-svc/digitalhome-edge/db/digitalhome.db`

## MCP server (`mcp-server/server.py`)

- Runtime: Python 3.12, venv at `/home/dhc-svc/mcp-server/venv/`
- Framework: FastMCP (`mcp` package)
- Transport: SSE on `:8000`
- Runs as: `dhc-svc` via `mcp-server.service`
- Config comes from env vars loaded from `.env` — no hardcoded IPs or keys
- Tools talk to Node-RED via `httpx` — keep tools thin, no business logic in them

## Node-RED flows (`flows/`)

- Node-RED runs as `dhc-svc` on `:1880`, userDir `/home/dhc-svc/.node-red`
- Palettes installed: `node-red-contrib-ccu`, `node-red-contrib-huemagic`
- Export flows to `flows/exported/` after every significant change:
  Node-RED menu → Export → All flows → Download JSON → commit here
- `flows/flow-api.md` is the **source of truth** for HTTP-in endpoints.
  Keep it updated whenever you add or change an endpoint.
- HTTP-in endpoints follow the convention in SPEC.md (`/api/state/all`, etc.)

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
If it isn't yet, set it up with:
```bash
sudo -u dhc-svc git clone <repo-url> /home/dhc-svc/digitalhome-edge
```

## What's not done yet (open items)

See `SPEC.md` → Open Items section. The DB tools (`kb_search`, `kb_add`,
`agent_log_write`) are not yet implemented in the MCP server — that's the next
task. The SQLite schema also needs to be written and initialised on the server.
