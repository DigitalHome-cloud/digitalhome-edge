# Install / bring-up procedure

digitalhome.edge runs as a single Docker Compose stack under `/opt/dhe/`.
Everything (device flows, MCP server surface, cloud sync client, dashboard)
lives in one Node-RED container with the `node-red-contrib-dhc-mcp` and
`node-red-contrib-dhc-sync` palettes baked in at image build time.

## Prerequisites

- Ubuntu 24.04 LTS (server or desktop) with sudo.
- Docker Engine ≥ 24 + Compose plugin ≥ 2.20 (`apt install docker.io docker-compose-v2`).
- Network path to your Homematic CCU (`homematic-ccu`) and Philips Hue Bridge (`hue-bridge`) — or whatever devices you intend to integrate.
- Git clone of this repo somewhere the operator can read (typically `~/digitalhome-edge` or `~/digitalhomeCloud/digitalhome-edge`).

## One-shot install

```bash
git clone https://github.com/DigitalHome-cloud/digitalhome-edge.git
cd digitalhome-edge

# 1. Build the image (once — bakes in both dhc-mcp and dhc-sync palettes).
sudo docker compose -f deploy/docker-compose.yml build

# 2. Seed /opt/dhe/, generate secrets, install the systemd unit.
sudo bash deploy/bootstrap.sh

# 3. Start the stack.
sudo systemctl start dhe.service

# 4. Grab the credentials for Claude Desktop + Node-RED editor.
sudo dhcedge show-secrets
```

Bootstrap prints the credentials at the end too, so you don't strictly
need step 4. Save the MCP bearer token — you'll need it in your Claude
Desktop config.

`bootstrap.sh` is idempotent — safe to re-run to add missing pieces
without touching existing secrets.

## What lands where

| Path | What lives there |
|---|---|
| `/opt/dhe/docker-compose.yml` | Runtime compose file (bootstrap copies from the repo) |
| `/opt/dhe/.env` | Non-secret port / home-id vars |
| `/opt/dhe/config/dhe.config.cache` | Config cache (0600) |
| `/opt/dhe/secrets/` | Per-secret files (0600 each): MCP token, Node-RED admin + http passwords, credential secret, machine-id fallback |
| `/opt/dhe/node-red-data/` | Node-RED userDir (settings.js, flows, projects) |
| `/opt/dhe/cbox/` | Digital-twin JSON-LD cache (Phase 3+) |
| `/opt/dhe/timeseries/` | SQLite sensor buffer (Phase 5) |
| `/opt/dhe/logs/` | Structured logs |
| `/etc/systemd/system/dhe.service` | Systemd oneshot that manages compose up/down |
| `/usr/local/bin/dhcedge` | CLI for common operations |

Everything under `/opt/dhe/` is owned by uid 1000 (the container's `node-red` user; matches host `frankuwe` on many desktop installs, but that's a coincidence).

## Post-install steps

### 1. Connect Claude to the MCP server

The MCP endpoint requires a bearer token. Retrieve it with `sudo dhcedge show-secrets`.

Add to Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "digitalhome-edge": {
      "url": "http://<server-ip>:1880/mcp/sse",
      "headers": {
        "Authorization": "Bearer <token from dhcedge show-secrets>"
      }
    }
  }
}
```

Verify with the MCP inspector:

```bash
npx @modelcontextprotocol/inspector \
    --header "Authorization: Bearer <token>" \
    http://<server-ip>:1880/mcp/sse
```

### 2. Node-RED editor + dashboard

Open `http://<server-ip>:1880/` and log in with the admin credentials
(`admin` + password from `dhcedge show-secrets`).

Dashboard is at `http://<server-ip>:1880/dashboard/`.

The palette shows two new sections:

- **digitalhome (MCP)** — `mcp-server-config`, `mcp-tool-in`, `mcp-resource-in`, `mcp-response`
- **digitalhome (sync)** — `dhc-sync-config`, `dhc-sync-status`, `dhc-sync-cbox-out`

Drop a `mcp-server-config` node into a flow to bring the MCP endpoint live
(routes only register when the config node is instantiated).

Same for `dhc-sync-config` to kick off the OAuth device flow. The
example flow at `contrib/dhc-sync/examples/pairing-flow.json` gives you
the QR code pairing UI on the dashboard — import via Node-RED menu →
Import → paste.

### 3. Pair the box with digitalhome.cloud

Once `dhc-sync-config` is wired and the cloud API is reachable, the
edge will:

1. POST `/edge/v1/device_authorization` and display a QR code on the
   dashboard "Setup" tab.
2. You open the URL on your phone, log into digitalhome.cloud with your
   existing Cognito account, pick your SmartHome, and approve.
3. The box receives its `device_token`, transitions to the "Status" tab,
   and starts sending authenticated telemetry.

Full spec: [`edge-cloud-api.md`](specs/edge-cloud-api.md).

## Operations

```bash
sudo dhcedge status           # systemd + container state
sudo dhcedge start / stop / restart
sudo dhcedge logs             # tail the Node-RED container
sudo dhcedge update-hosts     # regenerate /etc/hosts from config cache
sudo dhcedge show-config      # config cache with secrets redacted
sudo dhcedge show-secrets     # full credentials (sudo-gated)
```

## Deploying updates

```bash
# Pull the latest code
cd ~/digitalhome-edge
git pull

# Rebuild the image if the Dockerfile or contrib/ palettes changed
sudo docker compose -f deploy/docker-compose.yml build

# Restart to pick up the new image
sudo systemctl restart dhe.service
```

Bind-mounts (`/opt/dhe/{config,secrets,node-red-data,cbox,timeseries}`)
survive rebuilds — you don't lose settings, flows, or secrets.

## Full teardown

```bash
sudo systemctl stop dhe.service
sudo systemctl disable dhe.service
sudo rm /etc/systemd/system/dhe.service
sudo rm -rf /opt/dhe
sudo docker rmi digitalhome/dhe-nodered:local
```

Nothing else on the host system is touched — no service user was ever
created for the Docker stack; the container's `node-red` user (uid 1000)
maps to whichever host uid owns the bind-mounted dirs.

## Migration notes

- **v0.1 → v0.2 (2026-07-01)** — Retired the systemd-managed nodered + Python MCP stack. Everything moves to `/opt/dhe/` under Docker. Old paths (`/home/dhc-svc/…`) can be deleted by hand once you've confirmed the new stack has parity for your flows.
