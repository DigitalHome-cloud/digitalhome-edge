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

## Cloud Sync

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/cloud/sync` | Push full state snapshot to digitalhome.cloud |

---

## Notes

- All endpoints return `{"status": "ok"}` on success, or `{"error": "..."}` on failure.
- `{room}` values: `living-room`, `kitchen`, `bedroom`, `bathroom`, `entrance`, `office`
- Flows not yet built are listed here as spec — implement them in Node-RED.
