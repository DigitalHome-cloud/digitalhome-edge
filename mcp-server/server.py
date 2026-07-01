"""
digitalhome.edge MCP server
Claude talks exclusively to Node-RED HTTP endpoints and digitalhome.cloud REST.
All device logic (Homematic, Philips Hue) lives in Node-RED flows.
"""

import json
import logging
import os
import secrets
import sys
import aiosqlite
import httpx
from contextlib import asynccontextmanager
from mcp.server.fastmcp import FastMCP
from dotenv import load_dotenv
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"))

log = logging.getLogger("digitalhome-edge")

_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
# DHE_CONFIG_CACHE lets Docker (and future orchestration) point the server at
# a bind-mounted config path without touching the repo layout.
_CONFIG_CACHE = os.environ.get("DHE_CONFIG_CACHE") or os.path.join(
    _PROJECT_ROOT, "digitalhome.edge.config.cache"
)

_CONFIG_DEFAULTS: dict = {
    "version": 3,
    "instance": {
        "id": "digitalhome-edge-01",
        "name": "My Digitalhome",
        "location": "Home",
    },
    "mcp": {
        "auth_token": "",
    },
    "nodered": {
        "url": os.getenv("NODERED_URL", "http://localhost:1880"),
        "credential_secret": "",
        "admin_user": "admin",
        "admin_password": "",
        "http_user": "dhcedge",
        "http_password": "",
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


def _write_config(cfg: dict) -> None:
    """Persist config to disk and re-apply 0600 perms (defence in depth)."""
    with open(_CONFIG_CACHE, "w") as f:
        json.dump(cfg, f, indent=2)
    try:
        os.chmod(_CONFIG_CACHE, 0o600)
    except OSError:
        pass


def _load_config() -> dict:
    """
    Load config from digitalhome.edge.config.cache. On first startup, seed the
    file from defaults + environment. Self-heal a missing MCP auth token so
    the endpoint is never unauthenticated: if the token is empty the server
    generates one, writes it back, and logs it once so the operator can wire
    it into the Claude Desktop client.

    The Node-RED admin/http passwords are NOT self-generated here — install.sh
    owns those (they must be bcrypt-hashed into settings.js at the same time,
    which is a Node-RED-side concern). If they're missing at load time the
    server logs a warning but continues; MCP → Node-RED calls will fail with
    401 until the operator runs install.sh.
    """
    if os.path.exists(_CONFIG_CACHE):
        with open(_CONFIG_CACHE) as f:
            cfg = json.load(f)
    else:
        cfg = json.loads(json.dumps(_CONFIG_DEFAULTS))  # deep copy
        _write_config(cfg)

    # Self-heal missing MCP bearer token
    mcp_cfg = cfg.setdefault("mcp", {})
    if not mcp_cfg.get("auth_token"):
        token = secrets.token_hex(32)
        mcp_cfg["auth_token"] = token
        _write_config(cfg)
        # log to stderr so systemd captures it; operator reads via journalctl
        print(
            "digitalhome-edge: generated MCP auth token — add to Claude "
            f"Desktop config as 'Authorization: Bearer {token}'. Token also "
            f"stored in {_CONFIG_CACHE} under mcp.auth_token.",
            file=sys.stderr,
        )
    return cfg


_cfg = _load_config()

MCP_AUTH_TOKEN      = _cfg["mcp"]["auth_token"]
NODERED_URL         = _cfg["nodered"]["url"]
NODERED_HTTP_USER   = _cfg["nodered"].get("http_user", "dhcedge")
NODERED_HTTP_PW     = _cfg["nodered"].get("http_password", "")
CLOUD_API_URL       = _cfg["cloud"]["api_url"]
CLOUD_API_KEY       = _cfg["cloud"]["api_key"]
DB_PATH             = _cfg["db"]["path"]

if not NODERED_HTTP_PW:
    print(
        "digitalhome-edge: nodered.http_password is empty — MCP → Node-RED "
        "calls will fail with 401. Run install.sh to provision credentials.",
        file=sys.stderr,
    )

_NODERED_AUTH = httpx.BasicAuth(NODERED_HTTP_USER, NODERED_HTTP_PW) if NODERED_HTTP_PW else None


def _nodered_client() -> httpx.AsyncClient:
    """AsyncClient factory: basic auth for /api/* and admin API calls."""
    return httpx.AsyncClient(auth=_NODERED_AUTH)


class BearerAuthMiddleware:
    """ASGI middleware enforcing `Authorization: Bearer <MCP_AUTH_TOKEN>`.

    Written as pure ASGI (not Starlette's BaseHTTPMiddleware) so that the SSE
    streaming response passes through untouched — BaseHTTPMiddleware wraps
    responses in a way that has known interactions with long-lived streams.
    """

    def __init__(self, app: ASGIApp, token: str) -> None:
        self._app = app
        self._expected = f"Bearer {token}"

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return

        header_val = ""
        for name, value in scope.get("headers", ()):
            if name == b"authorization":
                header_val = value.decode("latin-1", errors="replace")
                break

        # constant-time compare
        expected = self._expected
        ok = len(header_val) == len(expected) and secrets.compare_digest(header_val, expected)
        if not ok:
            response = JSONResponse(
                {"error": "unauthorized", "detail": "missing or invalid bearer token"},
                status_code=401,
            )
            await response(scope, receive, send)
            return

        await self._app(scope, receive, send)


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
    async with _nodered_client() as c:
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
    async with _nodered_client() as c:
        r = await c.post(f"{NODERED_URL}{endpoint}", json=payload, timeout=10)
        r.raise_for_status()
        return r.json() if r.content else {"status": "ok"}


@mcp.tool()
async def nodered_query(endpoint: str) -> dict:
    """
    GET a Node-RED HTTP-in endpoint to read state or data from a flow.
    endpoint: e.g. '/api/state/all', '/api/heating/status'
    """
    async with _nodered_client() as c:
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
    async with _nodered_client() as c:
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
    async with _nodered_client() as c:
        r = await c.post(f"{NODERED_URL}/api/devices/sync", json={}, timeout=30)
        r.raise_for_status()
        return r.json() if r.content else {"status": "ok"}


# ── entrypoint ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    # SSE transport — Claude connects via HTTP, works locally and over LAN.
    # Bearer auth is enforced on every request via BearerAuthMiddleware.
    # DHE_MCP_HOST / DHE_MCP_PORT let Docker Compose pick a different bind
    # (e.g. :8443 for the side-by-side dhe stack) without editing this file.
    bind_host = os.getenv("DHE_MCP_HOST", "0.0.0.0")
    bind_port = int(os.getenv("DHE_MCP_PORT", "8000"))
    app = BearerAuthMiddleware(mcp.sse_app(), token=MCP_AUTH_TOKEN)
    uvicorn.run(app, host=bind_host, port=bind_port)
