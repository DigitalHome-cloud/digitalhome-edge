# digitalhome.edge — Install Procedure

Target: Ubuntu 24.04 LTS on DLAB5-M92P-01 (192.168.1.10)

## Prerequisites

- Fresh Ubuntu 24.04 LTS server
- SSH access as a user with `sudo`
- The repo URL (e.g. `git@github.com:DigitalHome-cloud/digitalhome-edge.git`)

## One-shot install

```bash
# clone the repo as your admin user, then run the installer as root
git clone <repo-url> ~/digitalhome-edge
sudo bash ~/digitalhome-edge/install.sh
```

The script is idempotent — safe to re-run after upgrades or partial failures.

## What the installer does

| Step | What happens |
|---|---|
| System packages | `python3.12`, `nodejs`, `npm`, `git`, `ufw` via apt |
| Service account | Creates `dhc-svc` (system user, no login shell) |
| Node-RED | `npm install -g node-red`, palettes `node-red-contrib-ccu` + `node-red-contrib-huemagic` installed in `/home/dhc-svc/.node-red` |
| Repo | Cloned to `/home/dhc-svc/digitalhome-edge` as `dhc-svc` |
| MCP server | Standalone copy at `/home/dhc-svc/mcp-server/`, Python venv created, dependencies installed |
| Database | Directory `/home/dhc-svc/digitalhome-edge/db/` created; schema applied by MCP server on first startup |
| Config cache | `digitalhome.edge.config.cache` created at `/home/dhc-svc/` from the example file |
| Systemd | `nodered.service` + `mcp-server.service` installed, enabled, and started |
| Firewall | `ufw` enabled; ports 22, 1880, 8000 opened |

## After install — required manual steps

### 1. Edit the config cache

```bash
sudo nano /home/dhc-svc/digitalhome.edge.config.cache
```

Fill in:
- `cloud.api_key` — from digitalhome.cloud
- `instance.id` — unique ID for this edge server
- `instance.name` — human name, e.g. `"My Home"`

Then restart the MCP server:
```bash
sudo systemctl restart mcp-server
```

### 2. Register the Philips Hue API key

1. Open `http://192.168.1.15/debug/clip.html` in a browser
2. Press the physical button on the Hue Bridge
3. POST to `/api` with body `{"devicetype":"digitalhome-edge"}`
4. Copy the returned `username` (this is the API key)
5. Store it in the config cache under `hue.api_key` (add the key if not present)

### 3. Install Node-RED Dashboard v2

The operational web UI requires the `@flowfuse/node-red-dashboard` palette.
It is not installed automatically because it requires Node-RED to be running.

1. Open `http://192.168.1.10:1880`
2. Hamburger menu → **Manage palette** → **Install**
3. Search `@flowfuse/node-red-dashboard` → Install

### 4. Connect Claude to the MCP server

Add to Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "digitalhome-edge": {
      "url": "http://192.168.1.10:8000/sse"
    }
  }
}
```

Or use the MCP inspector to verify:
```bash
npx @modelcontextprotocol/inspector http://192.168.1.10:8000/sse
```

## Deploying updates

After committing changes to the repo:

```bash
# on the server as frank-uwe
cd /home/dhc-svc/digitalhome-edge
sudo -u dhc-svc git pull

# if mcp-server/ changed:
sudo cp mcp-server/server.py /home/dhc-svc/mcp-server/server.py
sudo cp mcp-server/requirements.txt /home/dhc-svc/mcp-server/requirements.txt
sudo -u dhc-svc /home/dhc-svc/mcp-server/venv/bin/pip install -q -r /home/dhc-svc/mcp-server/requirements.txt
sudo systemctl restart mcp-server

# if flows/ changed:
sudo systemctl restart nodered
```

Or just re-run the installer — it will pull, re-copy, and restart cleanly:

```bash
sudo bash /home/dhc-svc/digitalhome-edge/install.sh
```

## Service reference

| Service | Port | URL | Logs |
|---|---|---|---|
| Node-RED editor | 1880 | `http://192.168.1.10:1880` | `journalctl -u nodered -f` |
| Node-RED UI | 1880 | `http://192.168.1.10:1880/ui` | same |
| MCP server | 8000 | `http://192.168.1.10:8000/sse` | `journalctl -u mcp-server -f` |

## Runtime file layout

```
/home/dhc-svc/
├── digitalhome.edge.config.cache   # local secrets — gitignored, edit directly
├── digitalhome-edge/               # git repo
│   ├── db/
│   │   ├── schema.sql
│   │   ├── digitalhome.db          # gitignored — live database
│   │   └── migrations/
│   ├── flows/
│   ├── mcp-server/
│   └── docs/
├── mcp-server/                     # standalone runtime copy
│   ├── server.py
│   ├── requirements.txt
│   ├── .env
│   └── venv/
└── .node-red/                      # Node-RED user directory
    ├── package.json
    ├── flows.json
    └── node_modules/
```
