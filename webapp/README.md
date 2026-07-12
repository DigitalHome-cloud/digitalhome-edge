# digitalhome.edge web app

A thin **Gatsby** SPA that is the local edge UI — onboarding (scan → connect Solar/CCU/Hue)
and status. It is **served by Node-RED** from a static directory (`httpStatic`) at `/app`, and
talks to the edge over the same-origin **headless API** `/app-api/*`. The rich UX lives in the
cloud Portal; this stays intentionally minimal.

See `docs/specs/edge-webapp.md` for the architecture.

## Build & deploy

```bash
cd webapp
npm install
npm run build            # gatsby build --prefix-paths  →  public/  (pathPrefix = /app)

# ship the static output to the edge (bind-mounted read-only at /webapp → served at /app)
rsync -a --delete public/ <edge>:/opt/dhe/webapp/
# then reload Node-RED (no rebuild needed for content-only changes):
#   the static files are served straight from the mount
```

`gatsby build` must run with `--prefix-paths` so asset URLs resolve under `/app`
(set via `pathPrefix` in `gatsby-config.js`).

## Local dev

```bash
npm run develop          # http://localhost:8000
```
Point the browser's `/app-api/*` calls at a running edge (proxy, or run against the box on the LAN).

## Prototype note

`public-demo/index.html` is a dependency-free static SPA that proves the serving path end-to-end
**without** a Gatsby build (Node-RED serves it identically). `deploy/bootstrap.sh` seeds it into
`/opt/dhe/webapp` on first install. Once CI runs `npm run build`, the real Gatsby `public/`
replaces it — the serving mechanism is unchanged.
