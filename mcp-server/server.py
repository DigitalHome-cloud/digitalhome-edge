"""
digitalhome.edge MCP server
Claude talks exclusively to Node-RED HTTP endpoints and digitalhome.cloud REST.
All device logic (Homematic, Philips Hue) lives in Node-RED flows.
"""

import os
import httpx
from mcp.server.fastmcp import FastMCP
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"))

NODERED_URL   = os.getenv("NODERED_URL",   "http://localhost:1880")
CLOUD_API_URL = os.getenv("CLOUD_API_URL", "")
CLOUD_API_KEY = os.getenv("CLOUD_API_KEY", "")

mcp = FastMCP("digitalhome-edge")


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


# ── entrypoint ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # SSE transport — Claude connects via HTTP, works locally and over LAN
    mcp.run(transport="sse")
