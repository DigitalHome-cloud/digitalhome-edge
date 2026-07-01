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
| Credential secret | Generated and stored in config cache; set in Node-RED `settings.js` |
| Node-RED Projects | Enabled in `settings.js` for built-in git UI + credential encryption |
| DNS hostnames | `/etc/hosts` updated with device hostnames from config cache |
| dhcedge CLI | Installed to `/usr/local/bin/dhcedge` |
| Systemd | `nodered.service` + `mcp-server.service` installed (prod: enabled+started, stage: disabled+stopped) |
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

### 3. Create the Node-RED project

With Projects enabled, Node-RED shows a first-run wizard on first access.

1. Open `http://192.168.1.10:1880`
2. The wizard prompts you to create a project
3. Name it `digitalhome-flows`
4. Optionally configure a git remote for backup

Flows are stored at `/home/dhc-svc/.node-red/projects/digitalhome-flows/`.
Credentials are encrypted in `flows_cred.json` (never committed to git).

### 4. Install Node-RED Dashboard v2

The operational web UI requires the `@flowfuse/node-red-dashboard` palette.
It is not installed automatically because it requires Node-RED to be running.

1. Open `http://192.168.1.10:1880`
2. Hamburger menu → **Manage palette** → **Install**
3. Search `@flowfuse/node-red-dashboard` → Install

### 5. Connect Claude to the MCP server

The MCP endpoint requires a bearer token — the installer generates one and
prints it at the end of the install (also retrievable with
`sudo dhcedge show-secrets`).

Add to Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "digitalhome-edge": {
      "url": "http://192.168.1.10:8000/sse",
      "headers": {
        "Authorization": "Bearer <token from `sudo dhcedge show-secrets`>"
      }
    }
  }
}
```

Or use the MCP inspector to verify:
```bash
npx @modelcontextprotocol/inspector \
    --header "Authorization: Bearer <token>" \
    http://192.168.1.10:8000/sse
```

## Node-RED editor login

The installer also configures `adminAuth` and `httpNodeAuth` in `settings.js`,
so `http://<server-ip>:1880` and every `/api/*` endpoint now require a login.
Two accounts are created:

- **Admin** (`admin` by default) — full editor access. Use for `Manage palette`,
  creating the Node-RED project, deploying flows.
- **`dhcedge`** — a service account whose password the MCP server uses when
  calling `/api/*`. You'll rarely need it directly.

Passwords are printed once at install time. Retrieve them later with:

```bash
sudo dhcedge show-secrets
```

The plaintext passwords live in `/home/dhc-svc/digitalhome.edge.config.cache`
(mode `0600`, gitignored). The bcrypt-hashed forms are in
`/home/dhc-svc/.node-red/settings.js`.

To **rotate** any credential: delete the corresponding block from `settings.js`
(the `adminAuth: {…}` block or the `httpNodeAuth: …` line), clear the matching
plaintext field in the config cache, then re-run `sudo bash install.sh`. The
installer regenerates missing values and reinserts the settings blocks.

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
├── .node-red/                      # Node-RED user directory
│   ├── settings.js                 # Projects enabled, credentialSecret set
│   ├── package.json
│   ├── node_modules/
│   └── projects/
│       └── digitalhome-flows/      # Node-RED project (separate git repo)
│           ├── flows.json          # live flows — hostnames, no IPs
│           ├── flows_cred.json     # encrypted credentials — never in git
│           └── package.json
└── .dhcedge-mode                   # "prod" or "stage"
```

## Device hostname conventions

Flows use hostnames instead of IPs. The mapping is managed via `/etc/hosts`,
generated from the config cache by `dhcedge update-hosts`.

| Hostname | Default IP | Device |
|---|---|---|
| `homematic-ccu` | 192.168.1.2 | Homematic CCU |
| `hue-bridge` | 192.168.1.15 | Philips Hue Bridge |
| `digitalhome-edge` | 127.0.0.1 | Self-reference (always hardcoded) |

To update after changing device IPs in the config cache:

```bash
sudo dhcedge update-hosts
```

## dhcedge CLI

| Command | Sudo | Description |
|---|---|---|
| `dhcedge status` | no | Show service status and install mode |
| `dhcedge start` | yes | Start Node-RED + MCP server |
| `dhcedge stop` | yes | Stop both services |
| `dhcedge restart` | yes | Restart both services |
| `dhcedge logs [service]` | no | Tail logs (nodered, mcp-server, or all) |
| `dhcedge update-hosts` | yes | Regenerate /etc/hosts from config cache |
| `dhcedge show-config` | no | Show config cache (secrets redacted) |
