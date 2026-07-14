# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## What this repo is

Application layer for **digitalhome.edge** — the local edge server running on
`DLAB5-M92P-01` (192.168.1.10). Reading order for context:
- `SPEC.md` — current-state snapshot.
- `docs/architecture.md` — target architecture (SLAB5 spec).
- `docs/adr/0001-dhe-alignment.md` — locked decisions + phased migration plan.
- `docs/specs/edge-cloud-api.md` — edge ↔ cloud wire spec (OAuth device flow).

## Runtime shape

One Docker container: Node-RED 4.0.9 with the palettes baked in at build time.
`dhe.service` (systemd oneshot) drives `docker compose up -d/down`. All state
under `/opt/dhe/`.

- `contrib/dhc-mcp/` — MCP server surface in Node-RED (config node + tool/resource nodes + response node)
- `contrib/dhc-sync/` — OAuth device flow client + dashboard pairing UI + telemetry loop

## The golden rule

**Node-RED owns all devices. Everything else calls Node-RED.**

- Homematic CCU (`homematic-ccu`) and Philips Hue Bridge (`hue-bridge`) are
  only accessed through Node-RED flows.
- The MCP server surface runs *inside* Node-RED via `dhc-mcp` — a `tools/call`
  arriving at `/mcp/messages/:sessionId` fires an `mcp-tool-in` node in the
  matching flow. The response goes back via `mcp-response`.
- Claude calls MCP tools. MCP nodes fire flows. Flows call devices.
- If you're writing code that talks directly to device IPs from anywhere but
  a Node-RED flow — stop. That logic belongs in a flow.

## Repository layout

```
contrib/
  dhc-mcp/       MCP palette — config node + tool-in/resource-in/response
  dhc-sync/      OAuth device flow + dashboard pairing UI + telemetry loop
deploy/
  docker-compose.yml   single node-red service
  dhe.service          systemd oneshot
  bootstrap.sh         seeds /opt/dhe/ layout
  nodered/
    Dockerfile         base image + palettes
    entrypoint.sh      bcrypts secrets → settings.js on first boot
flows/
  digitalhome-flows/   git submodule (Node-RED Project)
  flow-api.md          HTTP-in endpoint catalogue
db/
  schema.sql           reserved for future in-container store
  migrations/
bin/
  dhcedge              CLI for the Docker stack
docs/
  architecture.md
  install.md
  adr/                 architecture decisions
  audits/              security & quality audits
  specs/               wire-level specs
```

## Device hostnames

Flows use DNS hostnames, never hardcoded IPs. Mapping lives in the config
cache under `devices` and gets written to `/etc/hosts` by `dhcedge update-hosts`.

| Hostname | Default IP | Device |
|---|---|---|
| `homematic-ccu` | 192.168.1.2 | Homematic CCU |
| `hue-bridge` | 192.168.1.15 | Philips Hue Bridge |
| `digitalhome-edge` | 127.0.0.1 | Self-reference (hardcoded) |

## Sensitive data

- `/opt/dhe/secrets/` — one file per secret (0600 each): `mcp-auth-token`,
  `nodered-admin-password`, `nodered-http-password`, `nodered-credential-secret`,
  `device-token`, `edge-id`, `home-id`, `machine-id`, plus integration link
  secrets `solarman-app-secret`, `solarman-token.json`, `ccu.json` (CCU IP +
  API token), `hue.json` (Hue IP + API key). Gitignored root; nothing from this
  dir belongs in commits.
- `/opt/dhe/config/dhe.config.cache` — non-secret settings + hue api key.
  0600. Gitignored.
- `/opt/dhe/cbox/discovered/{ccu,hue}.json` — **home structure downloaded from
  the devices** (rooms, functions, devices, scenes, plus the raw CCU XML / Hue
  bridge config). Written 0600 at runtime by the `POST /app-api/config-pull`
  flow. Contains **PII** (room/person names, device serials) and the **Hue
  bridge whitelist** (API keys). **Never commit.** Runtime-only under `/opt/dhe`;
  `.gitignore` blocks `**/discovered/`, `deploy/cbox/discovered/`,
  `*.discovered.json` as a backstop.
- Node-RED credentials are encrypted in `flows_cred.json` under the userDir
  (never committed; encryption key is in `credential-secret` above).
- Never put device IPs, API keys, tokens, or passwords in committed files.
  The `.example` files show the *shape*, not real values.

## MCP server (in Node-RED, `contrib/dhc-mcp/`)

- Runtime: Node.js (Node-RED contrib module — no extra process)
- Transport: SSE at `/mcp/sse`, JSON-RPC POSTs to `/mcp/messages/:sessionId`
- SDK: `@modelcontextprotocol/sdk` (TypeScript SDK, CJS-compatible)
- Auth: Bearer token read from `/secrets/mcp-auth-token` at Node-RED startup
- Tools + resources register from the `mcp-tool-in` / `mcp-resource-in`
  nodes; response returns via `mcp-response` matched by `callId`

## Cloud sync (in Node-RED, `contrib/dhc-sync/`)

- Runtime: same Node-RED container (no separate sync-agent)
- Wire: `docs/specs/edge-cloud-api.md` — RFC 8628 OAuth device flow
- State machine: `contrib/dhc-sync/lib/state-machine.js` (BOOT / UNLINKED /
  AWAITING_APPROVAL / LINKED / DENIED / ERROR)
- Dashboard: QR code + `user_code` + status, at `/dashboard` (Setup tab
  while unlinked, Status tab while linked)

## Node-RED flows (`flows/`)

- Node-RED runs inside the container, userDir `/data` = `/opt/dhe/node-red-data`
- **Node-RED Projects** enabled — flows live under
  `/opt/dhe/node-red-data/projects/`, git-backed via Projects UI
- Credentials encrypted in `flows_cred.json` (key at
  `/opt/dhe/secrets/nodered-credential-secret`)
- Palettes baked into the image: `node-red-contrib-ccu`,
  `node-red-contrib-huemagic`, `@flowfuse/node-red-dashboard`,
  `node-red-contrib-dhc-mcp`, `node-red-contrib-dhc-sync`
- `flows/flow-api.md` is the source of truth for `/api/*` endpoints
- Use hostnames (`homematic-ccu`, `hue-bridge`) in flow config nodes, never
  hardcoded IPs

## Database (`db/`)

`db/schema.sql` was previously served by a standalone Python MCP server that
has been retired. The Node-RED container does not currently attach a SQLite
store. Kept in the tree because the same schema will be reused when the C-BOX
catalog work lands (Phase 3+) as `/opt/dhe/db/digitalhome.db`.

## Shared agent memory (planned)

Once the in-container store is wired, agents will:
- Call `kb_search` before attempting anything with a device or flow
- Call `kb_add` on discovering a device quirk, failure mode, or working
  pattern

This is how multiple agents build shared institutional knowledge over time.
Not active today.

## Deploying changes to the server

```bash
# on the target box as an admin user
cd ~/digitalhome-edge
git pull

# only rebuild if the Dockerfile or contrib/ palettes changed
sudo docker compose -f deploy/docker-compose.yml build

# restart to pick up the new image (or the updated flows submodule)
sudo systemctl restart dhe.service
```

Use `dhcedge` to manage the stack:

```bash
dhcedge status                # systemd + container state
sudo dhcedge start            # bring up
sudo dhcedge stop             # tear down
sudo dhcedge restart
sudo dhcedge logs             # tail node-red logs
sudo dhcedge update-hosts     # regenerate /etc/hosts from config cache
dhcedge show-config           # config cache (secrets redacted)
sudo dhcedge show-secrets     # MCP token + Node-RED credentials
```

Full install / bring-up procedure lives at `docs/install.md`.

## Web UX

Operational UI (device control, scenes, sensors) → **Node-RED Dashboard v2**
(`@flowfuse/node-red-dashboard`) at `:1880/dashboard`. No separate frontend
server. Dashboard tabs are built as Node-RED flows.

The `dhc-sync` palette ships an importable pairing UI at
`contrib/dhc-sync/examples/pairing-flow.json` — Setup tab for the QR code +
`user_code`, Status tab once linked.

## What's not done yet (open items)

See `SPEC.md` → Open Items section.
