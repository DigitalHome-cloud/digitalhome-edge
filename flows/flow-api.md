# Node-RED HTTP-in Endpoint Catalogue

This is the source of truth for all HTTP-in endpoints exposed by Node-RED.
Update this file whenever you add, change, or remove an endpoint.

The MCP server calls these via `nodered_query()` (GET) and `nodered_trigger()` (POST).

---

## State / Read

| Method | Endpoint | Returns |
|---|---|---|
| GET | `/api/state/all` | Full snapshot: all devices, all rooms |
| GET | `/api/state/{room}` | State for one room |
| GET | `/api/heating/status` | All thermostat setpoints + current temps |

---

## Lights

| Method | Endpoint | Body | Description |
|---|---|---|---|
| POST | `/api/lights/{room}/on` | — | Turn on all lights in room |
| POST | `/api/lights/{room}/off` | — | Turn off all lights in room |
| POST | `/api/lights/{room}/dim` | `{"level": 0-100}` | Set brightness |
| POST | `/api/lights/{room}/color-temp` | `{"ct": 153-500}` | Set colour temperature |

---

## Scenes

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/scene/morning` | Morning routine (gradual warm light) |
| POST | `/api/scene/evening` | Evening routine (warm, dimmed) |
| POST | `/api/scene/night` | Night mode (minimal light) |
| POST | `/api/scene/away` | All off + security mode |
| POST | `/api/scene/welcome` | Entrance lights on |

---

## Heating

| Method | Endpoint | Body | Description |
|---|---|---|---|
| POST | `/api/heating/{room}/set` | `{"temp": 20.5}` | Set thermostat setpoint |
| POST | `/api/heating/eco` | — | Set all thermostats to eco mode |
| POST | `/api/heating/comfort` | — | Set all thermostats to comfort mode |

---

## Devices (inventory)

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/devices` | List all devices from SQLite inventory |
| GET | `/api/devices/:class` | Filter by DHC T-Box class (e.g. `Light`, `Thermostat`, `Sensor`) |
| POST | `/api/devices/sync` | Discover devices from CCU + Hue, UPSERT into SQLite |

`/api/devices/sync` reads CCU XML-API `statelist.cgi` and Hue REST `/lights`,
maps each device to DHC ontology classes (`dhc_class`, `design_view`, `capability`),
and writes to the `device` table. Returns `{synced: {ccu: N, hue: M, total: N+M}}`.

---

## Solar (PV)

| Method | Endpoint | Returns |
|---|---|---|
| GET | `/api/solar/status` | Latest Solarman realtime snapshot: `{station_id, ts, data, observations}` from `global.solar_latest`. `503 {error}` until the first poll lands. |

Backed by the Solarman ingest flow on `dp-tab` (token → station discovery → 5-min realTime
poll). Raw responses land in `/timeseries/raw/solarman/`; Brick observations in
`/timeseries/cbox/`. See `docs/specs/solarman-edge-pipeline.md`.

---

## Panel (scan and control)

Phones as MQTT end devices: one code per QR. Spec: `docs/specs/panel-scan-and-control.md`.
Registered by the `dhc-panel` node (tab "Panel"), behind the same basic auth as the rest of `/api/*`.

| Method | Endpoint | Body | Returns |
|---|---|---|---|
| GET | `/api/panel/codes` | — | `{broker: {connected}, ws_port, codes: [{id, name, scope, bell, kind, lang, online, tiles}], catalog: {floors, rooms, kinds, tiles}}` |
| POST | `/api/panel/codes` | `{name, scope: {floors, rooms, kinds, none}, bell, lang}` | `{code, secret, ws_port}`. The secret is returned once and not kept |
| DELETE | `/api/panel/codes/{id}` | — | Revokes the code and closes its phone's connection |
| GET | `/api/panel/bell` | — | `{bell: {lights, chimes}, options: {lights: [{id, label, room}], chimes: [{id, label}]}}` |
| PUT | `/api/panel/bell` | `{lights: [tile id], chimes: [chime id]}` | What a ring sets off in the house: Hue lights blink, chimes sound |
| POST | `/api/panel/bell/test` | — | Sets them off once without ringing the phones; `{targets: n}` |
| GET | `/api/panel/labels` | — | `{langs: ["en","de","fr"], entries: [{original, where: ["room"\|"tile"\|"chime"], rooms, en, de, fr}]}`: every word the home shows; `where: []` = translated but no longer in the twin |
| PUT | `/api/panel/labels` | `{"<original>": {en, de, fr}}` | `{changed: n}`. `""` removes a language; the phones get the new words at once |

The phones themselves use MQTT (broker port 9001, WebSocket), not HTTP: topics `dhc/panel/<id>/…` in the spec.
The page they open is static: `/app/panel/#c=<id>.<secret>&l=<lang>` (`l`: the code's language, so the first
screen speaks it before the broker answers).

---

## Cloud Sync

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/cloud/sync` | Push full state snapshot to digitalhome.cloud |

---

## Notes

- All endpoints return `{"status": "ok"}` on success, or `{"error": "..."}` on failure.
- `{room}` values: `living-room`, `kitchen`, `bedroom`, `bathroom`, `entrance`, `office`
- Flows not yet built are listed here as spec — implement them in Node-RED.
