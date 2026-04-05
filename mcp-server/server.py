"""
digitalhome.edge MCP server
Claude talks exclusively to Node-RED HTTP endpoints and digitalhome.cloud REST.
All device logic (Homematic, Philips Hue) lives in Node-RED flows.
"""

import json
import os
import aiosqlite
import httpx
from contextlib import asynccontextmanager
from mcp.server.fastmcp import FastMCP
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"))

_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
_CONFIG_CACHE = os.path.join(_PROJECT_ROOT, "digitalhome.edge.config.cache")

_CONFIG_DEFAULTS: dict = {
    "version": 2,
    "instance": {
        "id": "digitalhome-edge-01",
        "name": "My Digitalhome",
        "location": "Home",
    },
    "nodered": {
        "url": os.getenv("NODERED_URL", "http://localhost:1880"),
        "credential_secret": "",
    },
    "cloud": {
        "api_url": os.getenv("CLOUD_API_URL", "https://api.digitalhome.cloud"),
        "api_key": os.getenv("CLOUD_API_KEY", ""),
    },
    "db": {
        "path": os.getenv("DB_PATH", "/home/dhc-svc/digitalhome-edge/db/digitalhome.db"),
    },
    "devices": {
        "homematic-ccu": {
            "ip": "192.168.1.2",
        },
        "hue-bridge": {
            "ip": "192.168.1.15",
            "api_key": "",
        },
    },
}


def _load_config() -> dict:
    """
    Load config from digitalhome.edge.config.cache.
    On first startup the file doesn't exist — create it with defaults seeded
    from environment variables (which take precedence over hardcoded values).
    The cache is gitignored and will eventually be populated from digitalhome.cloud.
    """
    if os.path.exists(_CONFIG_CACHE):
        with open(_CONFIG_CACHE) as f:
            return json.load(f)
    # First startup: write defaults so operators can edit the file directly.
    with open(_CONFIG_CACHE, "w") as f:
        json.dump(_CONFIG_DEFAULTS, f, indent=2)
    return _CONFIG_DEFAULTS


_cfg = _load_config()

NODERED_URL   = _cfg["nodered"]["url"]
CLOUD_API_URL = _cfg["cloud"]["api_url"]
CLOUD_API_KEY = _cfg["cloud"]["api_key"]
DB_PATH       = _cfg["db"]["path"]


async def _init_db() -> None:
    """Run schema.sql + pending migrations against the DB."""
    schema_path = os.path.join(os.path.dirname(__file__), "..", "db", "schema.sql")
    migrations_dir = os.path.join(os.path.dirname(__file__), "..", "db", "migrations")
    with open(schema_path) as f:
        schema = f.read()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript(schema)
        # Run migrations — each ALTER is wrapped in try/except to be idempotent
        if os.path.isdir(migrations_dir):
            for mig in sorted(os.listdir(migrations_dir)):
                if mig.endswith(".sql"):
                    with open(os.path.join(migrations_dir, mig)) as f:
                        for stmt in f.read().split(";"):
                            stmt = stmt.strip()
                            if stmt:
                                try:
                                    await db.execute(stmt)
                                except Exception:
                                    pass  # column already exists
        await db.commit()


@asynccontextmanager
async def lifespan(app):
    await _init_db()
    yield


mcp = FastMCP("digitalhome-edge", lifespan=lifespan)


# ── Node-RED ──────────────────────────────────────────────────────────────────

@mcp.tool()
async def nodered_get_flows() -> dict:
    """
    List all Node-RED flows. Use this to discover available automations,
    devices, and HTTP-in endpoints before triggering anything.
    """
    async with httpx.AsyncClient() as c:
        r = await c.get(f"{NODERED_URL}/flows", timeout=10)
        r.raise_for_status()
        return r.json()


@mcp.tool()
async def nodered_trigger(endpoint: str, payload: dict = {}) -> dict:
    """
    POST to a Node-RED HTTP-in endpoint to trigger an automation or scene.
    endpoint: path defined in Node-RED, e.g. '/api/scene/evening'
    payload: optional JSON body passed to the flow
    All device control goes through here — never talk to devices directly.
    """
    async with httpx.AsyncClient() as c:
        r = await c.post(f"{NODERED_URL}{endpoint}", json=payload, timeout=10)
        r.raise_for_status()
        return r.json() if r.content else {"status": "ok"}


@mcp.tool()
async def nodered_query(endpoint: str) -> dict:
    """
    GET a Node-RED HTTP-in endpoint to read state or data from a flow.
    endpoint: e.g. '/api/state/all', '/api/heating/status'
    """
    async with httpx.AsyncClient() as c:
        r = await c.get(f"{NODERED_URL}{endpoint}", timeout=10)
        r.raise_for_status()
        return r.json()


@mcp.tool()
async def nodered_inject(node_id: str) -> dict:
    """
    Trigger a Node-RED inject node by its ID.
    Use nodered_get_flows() first to find node IDs.
    Prefer nodered_trigger() with named endpoints where possible.
    """
    async with httpx.AsyncClient() as c:
        r = await c.post(f"{NODERED_URL}/inject/{node_id}", timeout=10)
        r.raise_for_status()
        return {"status": "injected", "node_id": node_id}


# ── digitalhome.cloud ─────────────────────────────────────────────────────────

@mcp.tool()
async def cloud_get(path: str) -> dict:
    """
    GET from digitalhome.cloud REST API.
    path: e.g. '/devices', '/scenes', '/automations', '/logs'
    """
    async with httpx.AsyncClient() as c:
        r = await c.get(
            f"{CLOUD_API_URL}{path}",
            headers={"Authorization": f"Bearer {CLOUD_API_KEY}"},
            timeout=15
        )
        r.raise_for_status()
        return r.json()


@mcp.tool()
async def cloud_post(path: str, payload: dict) -> dict:
    """
    POST to digitalhome.cloud REST API.
    path: e.g. '/automations', '/scenes/activate', '/devices/sync'
    """
    async with httpx.AsyncClient() as c:
        r = await c.post(
            f"{CLOUD_API_URL}{path}",
            json=payload,
            headers={"Authorization": f"Bearer {CLOUD_API_KEY}"},
            timeout=15
        )
        r.raise_for_status()
        return r.json()


@mcp.tool()
async def cloud_patch(path: str, payload: dict) -> dict:
    """
    PATCH a resource on digitalhome.cloud REST API.
    path: e.g. '/automations/42', '/devices/living-room-light'
    """
    async with httpx.AsyncClient() as c:
        r = await c.patch(
            f"{CLOUD_API_URL}{path}",
            json=payload,
            headers={"Authorization": f"Bearer {CLOUD_API_KEY}"},
            timeout=15
        )
        r.raise_for_status()
        return r.json()


# ── Knowledge base ───────────────────────────────────────────────────────────

@mcp.tool()
async def kb_search(query: str, type: str = "") -> list:
    """
    Full-text search the shared knowledge base.
    query: search terms, e.g. 'homematic dimmer level'
    type: optional filter — 'practice', 'limitation', 'device_note', 'automation', 'incident'
    Call this before attempting any device action or automation.
    Returns list of matching knowledge entries (id, type, topic, content, tags, source_agent, created_at).
    """
    sql = (
        "SELECT k.id, k.type, k.topic, k.content, k.tags, k.source_agent, k.created_at "
        "FROM knowledge_fts "
        "JOIN knowledge k ON knowledge_fts.rowid = k.id "
        "WHERE knowledge_fts MATCH ?"
    )
    params: list = [query]
    if type:
        sql += " AND k.type = ?"
        params.append(type)
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, params) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@mcp.tool()
async def kb_add(type: str, topic: str, content: str, tags: str = "") -> dict:
    """
    Write a new entry to the shared knowledge base.
    type: 'practice' | 'limitation' | 'device_note' | 'automation' | 'incident'
    topic: short subject tag, e.g. 'homematic', 'hue', 'heating'
    content: full description of what was discovered
    tags: optional comma-separated extra tags
    Call this when you discover a device quirk, working pattern, or failure mode.
    """
    valid_types = {"practice", "limitation", "device_note", "automation", "incident"}
    if type not in valid_types:
        raise ValueError(f"type must be one of {sorted(valid_types)}")
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO knowledge (type, topic, content, tags, source_agent) VALUES (?, ?, ?, ?, ?)",
            (type, topic, content, tags or None, "claude"),
        )
        await db.commit()
        return {"id": cur.lastrowid, "status": "added"}


@mcp.tool()
async def agent_log_write(action: str, tool_called: str, result: str, outcome: str) -> dict:
    """
    Append an entry to the agent audit log.
    action: human-readable description of what was attempted
    tool_called: MCP tool name used, e.g. 'nodered_trigger'
    result: JSON or text result received
    outcome: 'success' | 'failure' | 'partial'
    Call this after every significant action so other agents can learn from outcomes.
    """
    valid_outcomes = {"success", "failure", "partial"}
    if outcome not in valid_outcomes:
        raise ValueError(f"outcome must be one of {sorted(valid_outcomes)}")
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO agent_log (agent_id, action, tool_called, result, outcome) VALUES (?, ?, ?, ?, ?)",
            ("claude", action, tool_called, result, outcome),
        )
        await db.commit()
        return {"id": cur.lastrowid, "status": "logged"}


# ── Device inventory ─────────────────────────────────────────────────────────

@mcp.tool()
async def device_list(
    room: str = "",
    dhc_class: str = "",
    design_view: str = "",
    capability: str = "",
    protocol: str = "",
) -> list:
    """
    Query the device inventory. All filters are optional, combine as needed.
    dhc_class: DHC ontology class — 'Light', 'Switch', 'Thermostat', 'Sensor',
               'Actor', 'Controller', 'Gateway', 'Socket', 'Heater'
    design_view: DHC design view — 'electrical', 'heating', 'network', 'automation'
    capability: device capability — 'sensor', 'actor', 'controller'
    protocol: communication protocol — 'homematic' or 'hue'
    room: room name — e.g. 'living-room', 'kitchen', 'bedroom'
    Returns list of device dicts with all columns.
    """
    sql = "SELECT * FROM device WHERE 1=1"
    params: list = []
    if room:
        sql += " AND room = ?"
        params.append(room)
    if dhc_class:
        sql += " AND dhc_class = ?"
        params.append(dhc_class)
    if design_view:
        sql += " AND design_view = ?"
        params.append(design_view)
    if capability:
        sql += " AND capability LIKE ?"
        params.append(f"%{capability}%")
    if protocol:
        sql += " AND protocol = ?"
        params.append(protocol)
    sql += " ORDER BY design_view, dhc_class, name"
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, params) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


@mcp.tool()
async def device_sync() -> dict:
    """
    Trigger full device discovery from CCU + Hue Bridge.
    Calls Node-RED POST /api/devices/sync which reads both sources,
    maps devices to DHC ontology classes, and writes to the SQLite device table.
    Returns sync result with device counts per source.
    """
    async with httpx.AsyncClient() as c:
        r = await c.post(f"{NODERED_URL}/api/devices/sync", json={}, timeout=30)
        r.raise_for_status()
        return r.json() if r.content else {"status": "ok"}


# ── entrypoint ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    # SSE transport — Claude connects via HTTP, works locally and over LAN
    uvicorn.run(mcp.sse_app(), host="0.0.0.0", port=8000)
