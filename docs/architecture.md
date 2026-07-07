# digitalhome.edge / digitalhome.cloud — Target Architecture

**Status:** Draft v0.1  
**Author:** Frank-Uwe (with Claude assistance), authored under the SLAB5 architecture programme  
**Date:** 2026-07-01

> **Scope.** This document describes the **target** architecture that the
> digitalhome.edge product is migrating toward. It is not a snapshot of what
> is running today — for the current-state overview of this repo, see
> [`../SPEC.md`](../SPEC.md). The migration path from current → target is
> tracked in ADR [`adr/0001-dhe-alignment.md`](adr/0001-dhe-alignment.md).

---

## 1. Overview

SLAB5 is a smart home platform that creates a semantically rich digital twin of a home, exposable to AI agents via the Model Context Protocol (MCP). The platform combines:

- An **ontology-based design layer** (REC/Brick) to model any home in a standardised way
- An **AI integration layer** (MCP) to make that model callable by LLMs
- A **device communication layer** (Matter, MQTT, SmartThings, and other protocols)
- A **cloud control plane** (digitalhome.cloud) always present for UX, design, and configuration
- An **optional edge runtime** (digitalhome.edge) for local device communication, availability, and data privacy

The core semantic mapping is:
- **Matter Attributes / Brick Points** → MCP Resources (sensors, readable state)
- **Matter Commands / Brick actuators** → MCP Tools (actions the LLM can invoke)

---

## 2. Concepts and Terminology

### A-BOX (Generic Schema Layer)
The generic model, defined once. Based on REC (RealEstateCore) and Brick ontology standards. Defines what kinds of things can exist in any home and how they relate: `Room`, `Point`, `Temperature_Sensor`, `Lock`, `hasPoint`, `isLocatedIn`, etc. Deployed once; rarely changes.

### C-BOX (Digital Twin — Home-specific Instance Layer)
The concrete digital twin of a specific home, serialised as a JSON-LD file. Instantiates the A-BOX classes with real rooms, real devices, real locations. One C-BOX per home (`{homeId}`). Designed in digitalhome.cloud, deployed to the runtime.

> **Naming note — flagged.** The A-BOX / C-BOX terms above are **inverted** relative to standard Description Logic and the umbrella platform specs (`DH-SPEC-002/003/004` use T-Box = schema, A-Box = instance data). Edge repo keeps the local usage above for continuity with `adr/0001-dhe-alignment.md`; when talking to the Modeler/Designer teams, always disambiguate. Reconciling this is Open Decision #7 (see §12).

Example C-BOX fragment:
```json
{
  "@context": {
    "rec": "https://w3id.org/rec#",
    "brick": "https://brickschema.org/schema/Brick#",
    "slab": "https://slab5.example/ns#"
  },
  "@id": "slab:livingroom",
  "@type": "rec:Room",
  "rec:label": "Living Room",
  "brick:hasPoint": {
    "@id": "slab:tempSensor_lr01",
    "@type": "brick:Temperature_Sensor",
    "slab:liveRef": {
      "protocol": "matter",
      "endpoint": 12,
      "cluster": "0x0402"
    },
    "slab:lakeRef": {
      "pointId": "lr01_temp"
    }
  }
}
```

### liveRef / lakeRef
Every C-BOX Point entity carries two reference fields:
- **`slab:liveRef`** — how to reach the device for real-time reads/writes (protocol, endpoint, cluster, or cloud API coordinates)
- **`slab:lakeRef`** — the partition key under which this point's historical data is stored in the cloud lake

### MCP Catalog
The set of Tools and Resources derived from the C-BOX at deploy time. Not hand-authored. Generated programmatically by walking the C-BOX graph and emitting one Resource (live state) and one Tool (historical query) per Point entity, plus one Tool per Command-type Point.

---

## 3. Deployment Modes

Cloud (digitalhome.cloud) is **always present** — it is the control plane for UX, C-BOX design, and configuration. What varies per customer is where the MCP server and device runtime execute.

| Mode | Edge Runtime | Device Layer | Use Case |
|---|---|---|---|
| **Cloud-executed** | None (runs in AWS Lambda) | Cloud APIs (SmartThings, etc.) | Entry-level; all devices already cloud-native. No local fallback if WAN drops. |
| **Hybrid (primary target)** | Yes (local box) | Local protocols (Matter, MQTT, Zigbee) + optional cloud APIs | Full capability: local availability for critical services, cloud for analytics and remote access. |

> **Pure edge without cloud is not a supported mode.** Cloud connectivity is a hard dependency for UX, C-BOX maintenance, and home ID management.

### Availability and Criticality

Points in the C-BOX are tagged by criticality (`slab:criticality: "high" | "normal"`). High-criticality Tools (locks, alarms, climate safety cutoffs) **must** execute via the edge runtime and must never depend on a cloud round-trip for their actual action. In cloud-executed mode (no edge runtime), high-criticality tags cannot be guaranteed — this should be surfaced clearly to the user during C-BOX design.

---

## 4. Cloud Control Plane (digitalhome.cloud)

### Technology Stack
- **Frontend:** Gatsby (React static site)
- **Backend:** AWS Amplify Gen2
  - **Auth:** Cognito (user pools, per-home identity claims)
  - **API:** AppSync GraphQL (designer CRUD, deploy history, dashboard data)
  - **Storage:** S3 (C-BOX config, lake tables — per `{homeId}` prefix)
  - **Functions:** Lambda (deploy pipeline, MCP server for cloud-executed homes, SmartThings webhook receiver)

### S3 Tenant Layout
```
s3://digitalhome-cloud/
  {homeId}/
    config/
      cbox.jsonld               ← current digital twin
      cbox.history/             ← versioned snapshots (rollback/audit)
    lake/
      sensordata/
        point_id={pointId}/
          year=YYYY/month=MM/day=DD/*.parquet
```

**Tenant isolation** is enforced at the IAM/STS layer, not in application logic. When a session authenticates as a given `homeId`, the server assumes a role scoped to `s3://digitalhome-cloud/{homeId}/*` via STS AssumeRole. A bug in application code cannot read another tenant's data.

### Blockly Designer
The cloud designer is the **only** authoring surface for flows and the digital twin. End users never touch Node-RED's flow editor directly. The designer supports:

- **Greenfield design** — user starts from scratch, adds rooms and devices manually
- **Brownfield autodiscovery** — network scan (Matter commissioning, mDNS, Zigbee scan) proposes discovered devices as typed Blockly blocks; user drags them into the right Room socket and confirms

Blockly's typed block sockets directly enforce A-BOX constraints: a `Temperature_Sensor` block can only plug into a Room's `hasPoint` socket, not a `Command` socket. This gives SHACL-like structural validation as a side effect of the UI, before formal validation runs.

### Deploy Pipeline
One Blockly design session produces **two derived artifacts**:
1. **C-BOX JSON-LD** — the updated digital twin
2. **Node-RED flow JSON** — the device wiring (auto-generated, not hand-authored)

Both are pushed together at deploy time:
- C-BOX → written to `s3://{homeId}/config/cbox.jsonld` → pushed down to edge runtime (if present) via sync agent
- Flow JSON → pushed to the Node-RED runtime via Admin API (`POST /flows`)

After pushing, the MCP server reloads the catalog from the new C-BOX and emits `notifications/tools/list_changed` + `notifications/resources/list_changed` to any already-connected MCP clients.

**Catalog updates at deploy time, not at request time.** The MCP catalog is a stable, versioned snapshot of the twin — not a live graph query per `tools/list` call. This means mid-session tool availability is predictable and stable.

---

## 5. Edge Runtime (digitalhome.edge)

### Purpose
- Local device communication (Matter, MQTT, Zigbee) on the home LAN
- High-criticality automation execution without WAN dependency
- Local buffering and store-and-forward for sensor data
- Reduced latency for real-time device state reads

### Hardware Target
Production-grade edge boxes: DIN-rail mounted, fanless, industrial-rated, x86 (avoids ARM native-dependency friction). Reference tier: **Neousys POC-series** (Intel Atom-class, NVMe, -25°C to 70°C, ~€500–800/unit configured).

Development/prototyping: any Ubuntu x86 box (e.g. repurposed IBM workstation). Same Docker Compose stack runs identically — no changes needed between dev and production.

### Technology Stack
- **OS:** Ubuntu (LTS)
- **Runtime management:** Docker Compose + systemd
- **Flow engine:** Node-RED (with Projects/git backend enabled)
- **MCP server:** DHC.Edge MCP package (custom Node-RED contrib, see Section 7)
- **Local store:** SQLite (sensor data buffer / timeseries) + bind-mounted JSON for C-BOX cache

---

## 6. Edge Disk Layout

All persistent data lives under `/opt/slab5/` on the host, bind-mounted into containers. Named volumes are avoided — bind-mounts to known host paths make backup, inspection, and field debugging possible without Docker tooling.

```
/opt/slab5/
├── docker-compose.yml
├── .env                                 ← HOME_ID, cloud endpoint, log level
│
├── node-red-data/                       ← bind-mounted into node-red as /data
│   ├── settings.js                      ← Node-RED config (Projects enabled)
│   ├── .config.nodes.json
│   └── projects/
│       └── slab5-home/                  ← Node-RED Project (git-backed)
│           ├── flows.json               ← generated at deploy; never hand-edited
│           ├── package.json
│           └── .git/
│
├── cbox/                                ← bind-mounted into mcp-server
│   ├── cbox.jsonld                      ← current digital twin
│   └── cbox.history/
│       ├── cbox-2026-06-28T10-00.jsonld
│       └── ...
│
├── cache/                               ← derived from cbox at deploy time
│   ├── config-cache.json                ← expanded/resolved C-BOX (fast-read shape)
│   └── catalog.json                     ← MCP tools/resources list (generated, not authored)
│
├── timeseries/
│   └── points.db                        ← SQLite sensor data buffer
│
├── secrets/                             ← read-only mount, 600 perms
│   ├── home-id                          ← provisioned once at first install
│   └── device-token                     ← cloud auth credential
│
└── logs/
```

**Node-RED Projects** provide git-backed flow versioning. Since `flows.json` is always generated by the deploy pipeline (never hand-edited), git history is effectively a log of every design-time deploy, with full diffability.

---

## 7. Docker Compose Layout

```yaml
version: "3.9"

services:
  node-red:
    image: nodered/node-red:latest
    container_name: slab5-nodered
    restart: unless-stopped
    ports:
      - "1880:1880"
    volumes:
      - /opt/slab5/node-red-data:/data
    environment:
      - TZ=Europe/Brussels
    devices:
      - "/dev/ttyUSB0:/dev/ttyUSB0"     # USB radio (Zigbee/Thread dongle)
    network_mode: host                   # required for Matter mDNS multicast
    
  mcp-server:
    image: digitalhome/slab5-mcp:latest
    container_name: slab5-mcp
    restart: unless-stopped
    depends_on:
      - node-red
    ports:
      - "8443:8443"                      # MCP Streamable HTTP / SSE endpoint
    volumes:
      - /opt/slab5/cbox:/data/cbox
      - /opt/slab5/cache:/data/cache
    environment:
      - NODE_RED_URL=http://localhost:1880    # host network, same as node-red
      - CBOX_PATH=/data/cbox/cbox.jsonld
      - CATALOG_PATH=/data/cache/catalog.json
      - HOME_ID=${HOME_ID}
    network_mode: host

  sync-agent:
    image: digitalhome/slab5-sync:latest
    container_name: slab5-sync
    restart: unless-stopped
    volumes:
      - /opt/slab5/cbox:/data/cbox
      - /opt/slab5/cache:/data/cache
      - /opt/slab5/timeseries:/data/timeseries
      - /opt/slab5/secrets:/secrets:ro
    environment:
      - CLOUD_ENDPOINT=https://api.digitalhome.cloud
      - HOME_ID=${HOME_ID}

networks: {}    # all services use host network for Matter mDNS compatibility
```

> **Note on networking:** Matter relies on mDNS/multicast for device discovery, which does not traverse Docker's default bridge network. `network_mode: host` is required for the Node-RED container (and MCP server, since it calls into Node-RED). This is a known constraint of containerised Matter controllers.

### Systemd Unit (24/7 reliability)
```ini
# /etc/systemd/system/slab5.service
[Unit]
Description=SLAB5 Edge Runtime
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/slab5
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
```

---

## 8. Initial Bootstrap Sequence

The user must have already created a home ID in digitalhome.cloud before the edge box is powered on.

```
1. systemd starts slab5.service → docker compose up -d
2. sync-agent reads /secrets/home-id
3. Agent authenticates to digitalhome.cloud with device-token
4. Downloads cbox.jsonld for that homeId → writes to /opt/slab5/cbox/cbox.jsonld
5. MCP server traverses C-BOX → generates:
     cache/config-cache.json (expanded twin, fast-read)
     cache/catalog.json (MCP tools/resources list)
6. sync-agent downloads generated Node-RED flow JSON
7. Flow JSON pushed to Node-RED Admin API: POST http://localhost:1880/flows
8. Node-RED reloads the slab5-home Project, device flows go live
9. MCP server starts serving from catalog.json on port 8443
```

**If step 3 fails** (no connectivity at first boot), the box fails loudly with a clear status log rather than starting silently with an empty catalog. The edge runtime is not useful without an initial C-BOX pull.

**Subsequent boots** (C-BOX already cached locally): the sync-agent checks for a newer version from the cloud but can serve from the local cache if the cloud is temporarily unreachable. Device flows and MCP catalog remain available across WAN outages after initial provisioning.

---

## 9. DHC.Edge MCP — Node-RED Package

### Architecture Decision

The MCP server runs as a **separate process** from Node-RED (its own container), not embedded as nodes inside the Node-RED flow engine. The rationale:

- Catalog generation from JSON-LD is a **code task**, not a visual-wiring task. Parsing an ontology graph and emitting MCP-compliant tool schemas belongs in code, not in a flow.
- Protocol-level concerns (session lifecycle, `listChanged` notifications, SSE streaming, auth) are cleanly handled in a dedicated Node.js MCP SDK server without flow-editor constraints.
- The MCP server can be restarted/redeployed independently of the flow runtime, which is important if the catalog needs refreshing without disturbing live device flows.

The connection between the two is a clean internal HTTP interface: the MCP server calls into Node-RED's `HTTP-in` / `HTTP-response` flow pairs (one per Point) to execute tool actions. These HTTP endpoints are auto-generated by the deploy pipeline alongside the flows.

### DHC.Edge MCP Node Package — Three Components

The package (`node-red-contrib-dhc-edge-mcp`) is a custom Node-RED contrib module installed inside the Node-RED container. It provides the integration surface between Node-RED flows and the external MCP server process.

#### 1. DHC.Edge MCP server config (config node)
A Node-RED config node — singleton per deployment. Holds:
- Transport settings (MCP server URL, port, auth token)
- Path to the local catalog (`cache/catalog.json`)
- Path to the C-BOX (`cbox/cbox.jsonld`)
- Reconnect/retry settings for the cloud tunnel

Referenced by all `MCP in` and `MCP out` nodes in the flow.

#### 2. DHC.Edge MCP in
Fires when the MCP server receives a `tools/call` request for a specific Tool. Outputs a `msg` with:
```json
{
  "topic": "<toolName>",
  "payload": { "<arg1>": "<value>", ... },
  "mcp": {
    "sessionId": "<session>",
    "callId": "<callId>"
  }
}
```
Wires into the existing device-logic flow (Matter cluster read/write, MQTT publish, SmartThings API call, etc.). Semantically equivalent to an HTTP-in node, but speaking MCP tool-call semantics.

#### 3. DHC.Edge MCP out
Sits at the end of the device-logic flow. Takes the device-layer result in `msg.payload` and returns it as the MCP tool response, matched to the originating `callId`. Also supports emitting `notifications/resources/changed` for Resource update events.

Semantically equivalent to an HTTP-response node.

### Flow Structure (auto-generated, not hand-wired)

One flow fragment per Point:
```
[MCP in: "living_room_temperature"]
    → [function: validate/transform args]
    → [matter-read: endpoint 12, cluster 0x0402]
    → [function: wrap result {value, unit, room}]
    → [MCP out]
```

The deploy pipeline generates one such triplet per Point from the C-BOX, as part of the same step that generates `catalog.json`. This ensures the MCP catalog and the flow routing are always in sync — there is no separate maintenance step.

---

## 10. Data Flow: Live vs. Historical

The same natural-language question ("What temperature is the living room?") can mean two different things, hitting different data paths:

| Question type | MCP primitive | Data source | Latency |
|---|---|---|---|
| "What is the current temperature?" | **Resource** — `living_room_temperature` | Real-time device read-through via Matter/MQTT/API | Seconds |
| "What was it yesterday at 3pm?" / "Show me this week's trend" | **Tool** — `get_temperature_history(pointId, start, end)` | Lake table query (S3 Parquet + Athena) | Sub-second to seconds |

Both are exposed in the MCP catalog, derived from the same C-BOX Point entity. The `liveRef` field drives the Resource; the `lakeRef` field drives the historical Tool.

The sync-agent handles the data flow from edge to cloud lake: edge writes to `timeseries/points.db` first (zero cloud round-trip dependency for live control), then asynchronously flushes to S3 Parquet partitions. During a WAN outage, data accumulates locally and is flushed on reconnect (store-and-forward).

### Phase-1 pipeline: device → A-Box filter → local buffer

Landed in the stage branch (see `flows/digitalhome-flows/subflows/` + Data pipeline tab in `flows.json`). Covers Hue + Homematic today; Matter / SolarMan / SmartThings are placeholders on the same tab.

```
[Hue palette nodes]  ─┐
                      ├─▶ [normalizer]  ─▶ [A-Box filter subflow]  ─▶ [buffer writer subflow]
[CCU palette nodes]  ─┘                          │  1: mapped        (JSONL rotating daily)
                                                 └─ 2: unmapped     ─▶ [buffer writer subflow]
                                                                       (review queue)

Vocabulary: /cbox/abox.jsonld  (hot-reloaded every 30s by the loader flow)
Local buffer: /timeseries/cbox/YYYY-MM-DD.jsonl
Review queue: /timeseries/unmapped/YYYY-MM-DD.jsonl
```

**Iterative loop.** The A-Box vocabulary lives at `/opt/dhe/cbox/abox.jsonld` (starter seeded from `deploy/cbox/abox.jsonld`). Adding a new device capability = adding one `dhc:sourceMap/*` entry — no code deploy. The loader detects file changes by content hash and swaps the global index; the filter picks it up on the next observation. Recurring `(source, field)` pairs in `/timeseries/unmapped/` are the backlog of vocabulary work.

**Cloud shipment** (batch POST of buffered fragments) is deferred to a later phase; the wire needs to be agreed with the dark-factory cloud team first.

---

## 11. Provisioning (Claude Code Skill)

The edge box is provisioned via Claude Code running a predefined Skill:

```
1. Boot Ubuntu from USB (standard install)
2. Install Claude Code
3. Claude Code runs the SLAB5 provisioning Skill
4. The Skill generates declarative infrastructure artifacts:
     /opt/slab5/docker-compose.yml
     /etc/systemd/system/slab5.service
     /opt/slab5/.env  (from user-supplied HOME_ID)
5. Skill enables and starts the systemd service
6. Bootstrap sequence takes over (Section 8)
```

**Key principle:** The Skill's job is to **generate infrastructure artifacts**, not to imperatively configure the box. The generated files are the deliverable — auditable, diffable, reproducible. Reprovisioning a second box means re-running the Skill (or simply copying the generated artifacts). The system does not depend on re-running the agent to be operational.

---

## 12. Open Decisions

| # | Decision | Options | Notes |
|---|---|---|---|
| 1 | **Cloud-executed MCP server** — Lambda function URL or API Gateway? | Lambda Function URL (simpler) vs. API GW (more control over SSE/streaming) | MCP Streamable HTTP needs to be served correctly; Lambda Function URLs support streaming but worth validating |
| 2 | **Matter networking** — `network_mode: host` acceptable long-term? | Host mode (current plan) vs. macvlan network for better isolation | Host mode is pragmatic for now; revisit if security posture requires stricter isolation |
| 3 | **Node-RED flow update strategy on redeploy** — atomic swap or merge? | Atomic (replace all flows) vs. incremental diff | Recommend atomic for simplicity at home scale |
| 4 | **Local timeseries store** — SQLite or dedicated TSDB? | SQLite + time-series extension (lightweight) vs. InfluxDB/TimescaleDB (more capable) | Profile real workload on IBM dev box first |
| 5 | **`DHC.Edge MCP in` granularity** — one node per Tool or generic router? | One node per Point (auto-generated) vs. single entry node + switch routing | Recommend one node per Point; matches "one Point = one flow fragment" principle |
| 6 | **Cloud-executed homes: high-criticality tag handling** | Warn user at design time vs. block assignment | Recommend warn + require explicit acknowledgement |
| 7 | **A-BOX / C-BOX naming reconciliation with umbrella specs** | Keep edge's inverted usage vs. rename to standard DL (T-Box/A-Box) | Two-way rename affects `contrib/dhc-mcp` config, `abox.jsonld` file, ADR-0001. Do it in one PR when someone owns the coordination. |
