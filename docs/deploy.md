# dhcedge & Deployment Guide

How the `dhcedge` CLI works and how a change travels **from a repo commit to the
running container** on an edge box.

> Bring-up from a bare box is in [`install.md`](install.md). This doc is about the
> steady-state: managing the stack and shipping updates.

## Runtime shape (what you're deploying to)

```
systemd: dhe.service (oneshot)  ──drives──▶  docker compose -f /opt/dhe/docker-compose.yml up -d
                                                     │
                                                     ▼
                                      container: dhe-nodered
                                      image: digitalhome/dhe-nodered:local
                                      Node-RED 4.x, palettes baked in
                                                     │  bind mounts
                    ┌────────────────────────────────┼─────────────────────────────────┐
     /opt/dhe/node-red-data:/data   /opt/dhe/secrets:/secrets   /opt/dhe/config:/config:ro
     /opt/dhe/cbox:/cbox            /opt/dhe/timeseries:/timeseries
```

Everything persistent lives under `/opt/dhe/` on the host. The image carries **code**
(Node-RED, palettes, `entrypoint.sh`, `contrib/` nodes); the host bind-mounts carry
**state** (flows, secrets, config, mappings, timeseries).

There are **three independent layers**, each deployed by a different mechanism — this is
the key thing to internalise:

| Layer | Lives in | Changed by editing | Deployed by |
|---|---|---|---|
| **Image** (palettes, `contrib/`, `Dockerfile`, `entrypoint.sh`, compose) | the Docker image | `deploy/**`, `contrib/**` | `dhcedge build` |
| **Flows** (`flows.json`, subflows) | `/opt/dhe/node-red-data/projects/digitalhome-flows/` (a git clone) | `flows/digitalhome-flows` submodule | `dhcedge flow-pull` |
| **Data/config** (mappings, A-Box, config cache, secrets) | `/opt/dhe/{cbox,config,secrets}` | `deploy/cbox/**`, config, secrets | `bootstrap.sh` / manual copy |

A `build` does **not** update running flows, and a `flow-pull` does **not** rebuild the
image. Mappings and config are seeded by `bootstrap.sh` and updated by neither — see
[Updating mappings & config](#updating-mappings--config).

## Command reference

Run `dhcedge <command>`. Commands marked 🔒 require `sudo`.

| Command | 🔒 | What it does |
|---|:--:|---|
| `status` | | Prints `systemd is-active dhe.service` + `docker compose ps` (container health). |
| `start` | 🔒 | `systemctl start dhe.service` → `docker compose up -d`. |
| `stop` | 🔒 | `systemctl stop dhe.service` → `docker compose down`. |
| `restart` | 🔒 | `systemctl restart dhe.service`. Re-runs `entrypoint.sh` and reloads flows from disk. |
| `build` | 🔒 | **Image track.** `git pull --recurse-submodules --ff-only` on the repo checkout, `docker compose build`, syncs `docker-compose.yml` into `/opt/dhe`, then `restart`. |
| `flow-pull` | 🔒 | **Flow track.** `git pull --ff-only` inside the Node-RED **project clone** (`/opt/dhe/node-red-data/projects/…`), then `restart` to reload flows. |
| `logs [svc]` | | `docker logs -f dhe-<svc>` (default `nodered`; `all` = compose logs). Read-only; no sudo needed if your user can reach the docker socket. |
| `update-hosts` | 🔒 | Rewrites the managed block in `/etc/hosts` from `devices.*.ip` in the config cache. |
| `show-config` | | Prints the config cache with secret keys (`api_key`, `*_password`, `auth_token`, `email`, …) redacted. |
| `show-secrets` | 🔒 | Prints MCP token, Node-RED admin/http logins, Solarman app secret, and Solarman link status. |
| `help` | | Command list. |

### Notes on the two "pull" commands

- **`build` pulls the repo, not the running flows.** The repo checkout contains
  `flows/digitalhome-flows` as a submodule, but Node-RED runs a *separate* clone under
  `/opt/dhe/node-red-data/projects/`. `build` updates the image and the repo's submodule
  pointer; it leaves the running flow clone untouched. Use `flow-pull` for flow changes.
- **`build` skips the pull if the checkout has local changes** (`--ff-only` fails) and
  builds the current checkout anyway, printing a WARN. On a dev box with uncommitted
  edits, pull/commit first or the build won't include remote commits.
- **`flow-pull` refuses if the project clone has editor changes.** Node-RED Projects
  commits flow edits locally; if someone edited flows in the editor, `git pull --ff-only`
  fails and `flow-pull` tells you to resolve it in the Projects UI first.

## Deploying a change: commit → running container

### 0. Commit & push (from your workstation / repo checkout)

Flows are a submodule, so commit and push **the submodule first, then the parent** (so the
parent's submodule pointer references a commit that already exists on the remote):

```bash
# flow changes
git -C flows/digitalhome-flows add -A && git -C flows/digitalhome-flows commit -m "…"
git -C flows/digitalhome-flows push origin stage

# parent repo (code, docs, and the bumped submodule pointer)
git add -A && git commit -m "…" && git push origin stage
```

### 1. Decide what changed → pick the track

| You changed… | Deploy with |
|---|---|
| A flow (`flows/digitalhome-flows/**`) only | `sudo dhcedge flow-pull` |
| Palettes, `contrib/**`, `Dockerfile`, `entrypoint.sh`, `docker-compose.yml` | `sudo dhcedge build` |
| Both | `sudo dhcedge build` **then** `sudo dhcedge flow-pull` |
| Mappings / A-Box / config cache | see [below](#updating-mappings--config) (neither command does this) |

### 2. On the edge box

`build` pulls the repo itself, but for a flow-only change pull the repo checkout too so
docs/pointers stay in sync:

```bash
# image or entrypoint change:
sudo dhcedge build                 # pulls repo + submodule, rebuilds image, restarts

# flow-only change:
sudo dhcedge flow-pull             # pulls the project clone, restarts
```

### 3. Verify (see [Verifying a deploy](#verifying-a-deploy))

## Updating mappings & config

`deploy/cbox/mappings/*.map.json`, `deploy/cbox/abox.jsonld`, and the `solar`/`devices`
config live under `/opt/dhe/{cbox,config}` and are **seeded once by `bootstrap.sh`** — they
are not shipped by `build` or `flow-pull`. To update an existing box:

```bash
# mappings / A-Box (read live by the pipeline; no restart needed — the 30s reload picks them up)
cp <repo>/deploy/cbox/mappings/* /opt/dhe/cbox/mappings/
cp <repo>/deploy/cbox/abox.jsonld /opt/dhe/cbox/abox.jsonld

# config cache: bootstrap only writes it when absent, so edit in place
sudo -e /opt/dhe/config/dhe.config.cache      # or: dhcedge show-config to inspect (redacted)
```

Secrets are never in the repo; write them directly under `/opt/dhe/secrets/` (mode 0600).
Re-running `deploy/bootstrap.sh` is idempotent and will create any missing dirs/placeholders
without clobbering existing config or secrets.

## Verifying a deploy

```bash
dhcedge status                     # container Up + health
sudo dhcedge logs                  # watch boot: version, "Projects enabled", flows file, Started flows
```

Confirm the **project** flows loaded (not the fallback starter) — check the boot log for:

```
[info] Flows file : /data/projects/digitalhome-flows/flows.json     ← good
[info] Flows file : /data/flows.json                                 ← WRONG (Projects disabled → starter)
```

Cross-check the running flow via the Admin API (counts the live nodes):

```bash
AU=$(cat /opt/dhe/secrets/nodered-admin-user); AP=$(cat /opt/dhe/secrets/nodered-admin-password)
TOK=$(curl -s localhost:1880/auth/token -H 'Content-Type: application/json' \
  -d "{\"client_id\":\"node-red-admin\",\"grant_type\":\"password\",\"scope\":\"*\",\"username\":\"$AU\",\"password\":\"$AP\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
curl -s localhost:1880/flows -H "Authorization: Bearer $TOK" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)),"nodes")'
```

## Gotchas (learned the hard way)

- **Projects mode must be enabled or none of your flows run.** If
  `editorTheme.projects.enabled` is `false` in `/data/settings.js`, Node-RED ignores the
  project and runs the flat `/data/flows.json` starter. The boot log warns
  `Projects disabled`. `entrypoint.sh` enables it on boot — an image predating that fix
  needs a `build`. To fix a running box immediately: set the `projects` block to
  `enabled: true` in `/opt/dhe/node-red-data/settings.js`, then `sudo dhcedge restart`.
- **`build` ≠ flow update.** After a `build`, the running flows are still the old ones
  unless you also `flow-pull` (or the flow clone was already current).
- **Submodule pointer vs. project clone.** The parent repo's `flows/digitalhome-flows`
  submodule and the box's `/opt/dhe/node-red-data/projects/digitalhome-flows` clone are
  two different working copies of the same GitHub repo. Push flow commits to the remote so
  both can pull them.
- **Healthcheck port.** The compose healthcheck probes `DHE_NODERED_PORT` (intended 1881)
  while Node-RED serves the port in `/secrets/nodered-port` (currently 1880) — a mismatch
  shows the container `(unhealthy)` even though it works. Reconcile the two if the health
  flag matters (e.g. for restart policies).
- **Editor edits vs. git.** Changing flows in the Node-RED editor commits to the project
  clone locally and will block `flow-pull` (non-ff). Push those from the box or discard
  them before pulling.
