# Solarman PV → Edge Pipeline + Source→T-BOX Mapping

**Status:** Draft v0.1 · **Date:** 2026-07-11 · **Owner:** digitalhome.edge

Ingest PV/battery data from the Solarman Global cloud API into the edge box as a local
cache, holding both **raw source data** exactly as received and **Brick-abstracted
observations** for downstream automations, dashboards, and (later) cloud shipment. Fills the
`dp-comment-solarman` "phase 2" placeholder on the Data-pipeline tab and introduces the
per-source **mapping layer** that links native device/API fields to the canonical T-BOX.

Solarman is a cloud API, not a LAN device, but the golden rule ("Node-RED owns all devices")
is honoured: all API access lives inside Node-RED flows — nothing else talks to Solarman.

## 1. Architecture (medallion / lambda layering)

```
              Solarman Global Cloud API  (globalapi.solarmanpv.com)
                              │  poll every 5 min (bearer token, cached)
                              ▼
                     sm-fn-ingest (function)
                    │                     │
        raw envelope│                     │ normalized {source,device_id,ts,observations[]}
                    ▼                     ▼
   BRONZE                         SILVER
   sm-buffer-raw                  dp-abox-filter (EXISTING) → dp-buffer-cbox
   /timeseries/raw/solarman/      /timeseries/cbox/DATE.jsonl   (brick:* JSON-LD)
       DATE.jsonl                 unmapped → /timeseries/unmapped/DATE.jsonl
                    │
                    ▼  (also) global.set('solar_latest')
   GOLD  ── /api/solar/status (HTTP-in) + dashboard tiles

   LATER (Phase 5): cursor-tail /timeseries/cbox/*.jsonl → batch POST → digitalhome.cloud
```

- **Bronze (raw)** — exact API responses, append-only, replayable, source of truth. Survives
  mapping/schema changes; lets silver be re-derived without re-polling the cloud.
- **Silver (Brick)** — the existing `sf-abox-filter` → `sf-buffer-writer` chain emits
  semantic `brick:*` observations. This is what downstream pipelines and the cloud consume.
- **Gold (cache)** — last-known state in Node-RED `global` context for instant dashboard
  reads and automation queries without disk or cloud round-trips.

## 2. Source → T-BOX mapping layer

Native fields are linked to classes in the canonical T-BOX
(`repos/core/schema/tbox/Brick+extensions.ttl` — full Brick + BrickShape + QUDT) via **one
mapping file per integration**, replacing the inline `dhc:sourceMap/*` that used to live in
`deploy/cbox/abox.jsonld`.

```
deploy/cbox/mappings/
├── mappings-manifest.json   registry {source, file, version} (mirrors core cbox-manifest.json)
├── solarman.map.json
├── hue.map.json             migrated from abox.jsonld (behaviour-preserving routing)
├── homematic.map.json       migrated from abox.jsonld (source key 'ccu')
└── extensions.ttl           local T-BOX extension terms (candidates for promotion to core)
```

Mapping file shape — `capabilities` (semantic role → T-BOX class + QUDT unit) and `fields`
(native field → capability + optional coercion):

```json
{ "source":"solarman", "tbox":"Brick+extensions.ttl", "version":"0.1.0",
  "capabilities": {
    "pv_generation_power": { "brickClass":"brick:Active_Power_Sensor", "valueType":"xsd:double", "unit":"unit:W" }
  },
  "fields": { "generationPower": { "capability":"pv_generation_power" } } }
```

**Pipeline:** `dp-fn-abox-index` (function, `libs:[fs]`) loads every file in the manifest at
boot + on the 30s reload inject and flattens them into `global.aboxIndex`
(`sourceMap[source+'/'+field] = {capability, coerce}`; `capability[id] = {brickClass, unit,
valueType}`) — the exact shape `sf-abox-filter` already consumes, so the filter/buffer chain
is unchanged.

**Ownership:** authored in the edge repo now (edge consumes them at runtime); promote to core
as the single source, pushed down like the C-BOX, when C-BOX generation lands (Phase 3). Ties
to ADR-0001 Open Decision #7.

**Validation:** every `brickClass` in the maps must exist in `Brick+extensions.ttl` or
`extensions.ttl`. This surfaced two broken references inherited from the old `abox.jsonld`
(`brick:Communication_Status`, `brick:Window_Sensor` — absent from Brick), now corrected to
`brick:Availability_Status` and `brick:Contact_Sensor`.

## 3. Datapoints and mapping (Solarman → T-BOX)

`POST /station/v1.0/realTime`, one call per station, every 5 minutes:

| Solarman field   | capability            | T-BOX class                      | unit (QUDT)     |
|------------------|-----------------------|----------------------------------|-----------------|
| `generationPower`| `pv_generation_power` | `brick:Active_Power_Sensor`      | `unit:W`        |
| `usePower`       | `load_power`          | `brick:Electric_Power_Sensor`    | `unit:W`        |
| `gridPower`      | `grid_power`          | `brick:Electric_Power_Sensor`    | `unit:W`        |
| `batteryPower`   | `battery_power`       | `brick:Active_Power_Sensor`      | `unit:W`        |
| `batterySoc`     | `battery_soc`         | `dhc:State_Of_Charge_Sensor` †   | `unit:PERCENT`  |
| `generationValue`| `energy_today`        | `brick:Energy_Generation_Sensor` | `unit:KiloW-HR` |
| `generationTotal`| `energy_total`        | `brick:Energy_Generation_Sensor` | `unit:KiloW-HR` |

Distinct capability per power role so `dhc:capability` distinguishes generation/grid/load/
battery (Brick alone collapses them to `Active_Power_Sensor`). † Brick 1.3 has no SOC point
class; `dhc:State_Of_Charge_Sensor` is defined in `extensions.ttl` for promotion to core.

## 4. Frequency, token, history

- **Poll cadence: 5 min.** The Solarman cloud only refreshes every ~5 min, so faster polling
  returns identical values and wastes quota. No hard per-day cap is documented; budget stays
  at ≈1 realtime call/station/tick + one token refresh/day.
- **Token:** `POST /account/v1.0/token?appId=…&language=en`, body `{appSecret, email,
  password}` where `password` is the **lowercase SHA-256 hex** of the account password.
  Returns a long-lived bearer (`expires_in` ~2 months). Cached in `global.solarman_token`,
  refreshed once daily (boot + 24h inject) and force-refreshed on any `401`/`403` via a
  `catch` node.
- **Stations:** discovered once after token via `POST /station/v1.0/list` →
  `global.solarman_stations`.
- **History:** `POST /station/v1.0/history` (`timeType` 1=5-min/day, 2=day, 3=month,
  4=year). A manual inject backfills the last 30 days of daily totals per station (Solarman
  caps a single request at ~31 days; chunk for deeper backfill up to ~180 days). History lands
  in **bronze only** (`/timeseries/raw/solarman/history/`); it is not real-time observation
  data so it bypasses the silver path.

## 5. Disk landing area

Under the existing `/opt/dhe/timeseries` bind-mount (`→ /timeseries`; buffer file node has
`createDir:true`, UTC daily rotation, one JSON object per line):

```
/opt/dhe/timeseries/
├── raw/solarman/2026-07-11.jsonl          BRONZE: one line per realtime poll (envelope below)
├── raw/solarman/history/2026-07.jsonl     BRONZE: history responses
├── cbox/2026-07-11.jsonl                  SILVER: brick:* JSON-LD observations
└── unmapped/2026-07-11.jsonl              observations with no mapping entry
```

Raw envelope (secrets stripped, replayable):
```json
{ "ts":"2026-07-11T09:05:00Z", "source":"solarman", "endpoint":"/station/v1.0/realTime",
  "station_id":123456, "http_status":200, "response": { ...verbatim API body... } }
```

The `sf-buffer-writer` `format + route` allow-list accepts `cbox`, `unmapped`, and
`raw/<source>[/...]` (else → `misc`).

## 6. Flows (on `dp-tab` in `flows/digitalhome-flows/flows.json`)

| Nodes | Role |
|---|---|
| `sm-inject-token` → `sm-fn-token` → `sm-http-token` → `sm-fn-token-store` | boot + daily token refresh; reads config + secrets |
| `sm-fn-list-req` → `sm-http-list` → `sm-fn-list-store` | station discovery → `global.solarman_stations` |
| `sm-inject-poll` (300s) → `sm-fn-poll-req` → `sm-http-realtime` → `sm-fn-ingest` | live poll; fan-out raw + normalized + `global.solar_latest` |
| `sm-buffer-raw`, `sm-buffer-raw-hist` | bronze writers (`sf-buffer-writer` instances) |
| `sm-inject-history` (manual) → `sm-fn-history-req` → `sm-http-history` → `sm-fn-history-store` | history backfill → bronze |
| `sm-status-in` (`GET /api/solar/status`) → `sm-fn-status` → `sm-status-out` | gold: current-state endpoint |
| `sm-catch` → `sm-fn-catch` | on 401/403, clear token → re-auth |

`sm-http-*` are `http request` nodes with `method:"use"` (URL/headers/body built by the
preceding function). `sm-fn-ingest` output 2 wires into the existing `dp-abox-filter`.

## 7. Config & secrets

- **Secrets** (`/opt/dhe/secrets/`, 0600): `solarman-app-secret`, `solarman-password-hash`
  (SHA-256 hex of the account password — **never the plaintext**;
  `printf '%s' 'PASSWORD' | sha256sum`). `bootstrap.sh` creates empty placeholders; the
  operator fills them. The flow logs `creds missing` and idles while unset.
- **Config cache** (`/opt/dhe/config/dhe.config.cache`), `solar` block:
  `{ provider, base_url, app_id, email, poll_interval_s, station_ids }`. Seeded empty by
  `bootstrap.sh`; mirrored (shape only) in `digitalhome.edge.config.cache.example`.
- `dhcedge show-config` redacts `email`; `dhcedge show-secrets` surfaces the two Solarman
  secrets. New flow code reads container mounts `/config/dhe.config.cache` and `/secrets/*`.

## 8. Later: cloud upload (Phase 5, design only)

Second flow, built when the cloud wire spec is agreed (`SPEC.md` open item — batch POST of
`/timeseries/cbox/*.jsonl`). The landing already supports it: append-only daily JSONL + a
cursor high-water mark → batch-POST new silver lines via the `dhc-sync` device-token +
`postTelemetry` transport (`contrib/dhc-sync/lib/oauth-device-flow.js`) → advance cursor.
Bronze stays local as cache/replay; ship to S3 separately if ever needed.

## 9. Verification

1. Fill the two secrets + `solar` config block on the stage box; `dhcedge show-config` shows
   the `solar` block with `email` redacted.
2. Deploy flows; `dp-fn-abox-index` status shows `loaded N cap / M map [hue,ccu,solarman]`;
   `sm-fn-token` → green `token ok`; `sm-fn-list-store` populates stations.
3. After one tick: `raw/solarman/DATE.jsonl` has a raw envelope; `cbox/DATE.jsonl` has
   `brick:*` observations; `dp-abox-filter` status shows `mapped N`.
4. `curl -s localhost:1881/api/solar/status` returns current PV power / yield / SOC.
5. Fire the history inject once; confirm `raw/solarman/history/` appears.
6. Confirm no secret (token, app-secret, password) appears in any raw/cbox line or flows.json.
