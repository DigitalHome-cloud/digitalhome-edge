# Edge Web App — Gatsby served by Node-RED (`/app`)

**Status:** Draft v0.1 (prototype) · **Date:** 2026-07-12

## Context

The main UX lives in the cloud (Gatsby Portal). The edge only needs a **thin, simple** local
UI for what genuinely requires the LAN: **device onboarding** (scan → confirm → connect Solar /
CCU / Hue), **local health/status**, and **offline device control**. The current Node-RED
Dashboard 2.0 (`/ui`) works but couples UI to flows and its 12-column grid + `ui-template`
Vue-in-node model is fiddly (repeated layout issues).

**Direction:** make Node-RED **headless** (device I/O, pipeline, telemetry, a clean JSON API)
and serve a **static Gatsby SPA** from Node-RED's built-in static file server. This unifies the
frontend stack with the cloud Portal (Gatsby/React) and exploits Gatsby's key property — it
compiles to a **static directory** that any web server can serve. Node-RED becomes that server.

## Architecture

```
CI (cloud) ──gatsby build --prefix-paths──▶ webapp/public/  (static HTML/JS/CSS, pathPrefix=/app)
        └─ shipped to the edge ──▶ /opt/dhe/webapp   (bind-mount, read-only)
                                        │
Node-RED settings.js: httpStatic: [{ path:'/webapp', root:'/app/' }]
   http://<edge>:1880/app     ← serves the Gatsby SPA (LAN-open, like /dashboard)
   http://<edge>:1880/app-api/*  ← headless JSON API the SPA consumes (LAN-open)
        status (GET) · scan (POST) · connect (POST) · state (GET)
```

- **Node-RED = webserver + backend.** Flows keep everything already built (Solar/CCU/Hue
  scan/connect, A-Box pipeline, `/timeseries`, telemetry). They also expose an `/app-api/*`
  JSON surface for the SPA.
- **Gatsby SPA = the edge UI.** Reuses the platform's Gatsby/React design system so the edge
  UI matches the Portal. Built off-box; the edge only serves static files (lightweight).
- **Live data:** the SPA polls `GET /app-api/status` (2–5 s). A websocket/SSE can be added
  later if push is needed; polling is fine for a small onboarding/status UI.

## Auth / security posture

- `httpStatic` is served **outside** `httpNodeMiddleware` (which only gates httpNode `/api/*`),
  so `/app` needs no credentials — consistent with the existing decision to open `/dashboard`
  on the LAN for pairing.
- The onboarding API is namespaced `/app-api/*` and **exempted** from the basic-auth middleware
  (LAN-open) — same posture as the dashboard. The existing credential-gated `/api/*` endpoints
  are untouched. Also fix the stale middleware exemption (`/dashboard` → also `/ui`, `/app`).
- Future hardening: `httpStaticAuth` or a first-run local token; out of scope for the prototype.

## Deploy model (mirrors flows/mappings)

- `deploy/docker-compose.yml` — add `- /opt/dhe/webapp:/webapp:ro`.
- `deploy/nodered/entrypoint.sh` — insert `httpStatic` into `settings.js` on boot (idempotent).
- `deploy/nodered/http-auth-middleware.js` — exempt `/app`, `/ui`, `/app-api`.
- `deploy/bootstrap.sh` — `mkdir -p /opt/dhe/webapp`; seed the prototype build.
- Ship the build: CI runs `gatsby build --prefix-paths` → copy `webapp/public/*` to
  `/opt/dhe/webapp` (a `dhcedge webapp-pull` or the existing deploy path). Activating new infra
  (mount + settings) needs one `sudo dhcedge build && sudo dhcedge restart`.

## The webapp (`webapp/`)

A minimal Gatsby project (real, buildable):
- `package.json` (gatsby, react, react-dom), `gatsby-config.js` with `pathPrefix: '/app'`.
- `src/pages/index.js` — polls `/app-api/status`, renders Solar/CCU/Hue tiles + a **Connect**
  panel (scan → IP → connect) hitting `/app-api/scan` + `/app-api/connect`.
- Build output `webapp/public/` is what gets served.

**Prototype shortcut:** since a full `gatsby build` is heavy, this change also ships a
hand-authored `webapp/public-demo/index.html` (a tiny static SPA that polls `/app-api/status`)
so the serving path is proven end-to-end immediately; CI later replaces it with the real Gatsby
build output. Serving is identical either way — that's the point.

## `/app-api/*` (Node-RED flow, headless)

| Method | Endpoint | Returns / does |
|---|---|---|
| GET | `/app-api/status` | `{solar, ccu, hue}` link state + latest readings + pipeline counts (from `global.*`) |
| POST | `/app-api/scan` | `{source}` → trigger the existing scan flow, return candidates |
| POST | `/app-api/connect` | `{source, ip, email?, password?, user?, pass?}` → drive the existing connect functions |

Implemented: `GET /app-api/status`, `GET /app-api/ws` (WebSocket push), `POST /app-api/scan`,
`POST /app-api/connect` (CCU token/session, Hue 30s pairing loop, Solar). The Gatsby app does
onboarding natively via these — the iframe hybrid is retired (Dashboard 2.0 doesn't embed cleanly).

## Migration

Keep `/ui` (Node-RED Dashboard) running until the Gatsby `/app` reaches onboarding+status
parity, then retire the dashboard (or keep it as an admin/debug view). No flow logic is lost —
the dashboard and the SPA are both just frontends over the same flows + API.

## Verification

1. `sudo dhcedge build && sudo dhcedge restart`; boot log shows `httpStatic` active.
2. `curl -s http://localhost:1880/app/` → the SPA HTML (no auth prompt).
3. `curl -s http://localhost:1880/app-api/status` → JSON with solar/ccu/hue state.
4. Browser `http://<edge>:1880/app` → tiles show live Solar reading (and CCU/Hue once linked),
   updating on the poll interval.
5. `/api/*` still requires basic auth (unchanged); `/ui` still works.
