# Scan and control — phones as MQTT end devices

**Status:** v0.3, phases 1 and 2 running on the stage box; labels in EN/DE/FR and the code's language on its
card · **Date:** 2026-11-11

## Why

The Homematic app reaches everything, behind a lot of navigation. Old Android phones are cheap and everywhere.
A QR code, printed or on a screen, should open **only the functions of one place**: a floor, a room, a function.
No login, no app, no navigation. The broken door bell is the first stationary use: a phone at the door rings the
phones inside, and someone waiting for a delivery takes the bell along to their room by scanning a code.

LAN only. No ROS: a phone is an IoT device that speaks MQTT, and Node-RED does the rest.

## Shape

```
phone ── QR ──▶ http://<edge>:1880/app/panel/#c=<id>.<secret>      static page, served by Node-RED
   └── MQTT over WebSocket, port 9001 ──▶ Mosquitto (dhe-mosquitto, one client per code)
                                              └── 127.0.0.1:1883 ──▶ Node-RED, tab "Panel"
                                                     dhc-panel node: codes, scopes, checks
                                                     write device: Hue REST / CCU XML-API
```

- **The golden rule holds.** The `dhc-panel` node never talks to a device. It hands the flow one checked command
  per tap; the flow's `write device` function sends it to the Hue bridge or the CCU.
- **The broker is the second container** of the stack (`deploy/docker-compose.yml`). Port 1883 listens on
  loopback only, port 9001 (WebSocket) on the LAN. Nobody connects without a name and a password.

## Codes

A code is one client of the broker (Mosquitto Dynamic Security): its id is the user name, its secret the password.

| Field | |
|---|---|
| `id` | `p` + 12 hex digits |
| `name` | what the card says, e.g. "Ground floor lights" |
| `scope` | `{ floors: [n], rooms: [room id], kinds: ["light"\|"switch"\|"blind"\|"heating"], none }`. No floors and no rooms: the whole house. No kinds: every function. `none`: no tiles at all |
| `bell` | `none`, `listen` (rings with the door bell, may answer), `ring` (is the door bell) |
| `kind` | `panel` (a family phone); `door` (the door station adapter, see Door station); `phone` is reserved for a stationary face |
| `lang` | `en`, `de`, `fr`: the default language of the code: its printed card, its phone page, the home's words on it |

- **The secret is not kept on the edge.** It exists in the QR code and, hashed, in the broker. The registry
  `/opt/dhe/cbox/panel-codes.json` (0600) holds ids, names and scopes only. A lost card is revoked and made anew.
- **The scope is enforced twice.** The broker lets a code subscribe to `dhc/panel/<id>/#` and publish only the
  topics its role needs; the node then checks each tile against the code's scope.
- **A code that rings never has tiles**, whatever was asked: it sits on a phone outside the door.
- **Revoking** deletes the broker client, which closes its connection; the page says the code is no longer valid.
- Role changes disconnect a client, so on a restart the node touches only roles whose rules really differ.

## Tiles

Read from the twin (`/cbox/cbox.jsonld`, re-read when the file changes) by a **whitelist**
(`contrib/dhc-panel/lib/tiles.js`): a device type that is not named gives no tile.

| Tile | From | Actions |
|---|---|---|
| switch | Hue lights without brightness; `HM-LC-Sw*`, `HM-ES-PMSw*` (every STATE channel); `HmIP-BSM`/`BSL` ch 4, `HmIP-FSM` ch 2, `HmIP-PS`/`PSM` ch 3 | `on`, `off` |
| dimmer | Hue lights with brightness; `HM-LC-Dim*` | `on`, `off`, `level` 0–100 |
| blind | `HM-LC-Bl*` | `level` 0–100 |
| thermostat | `HM-CC-RT-DN` ch 4, `HmIP-STH*`/`eTRV`/`WTH` ch 1 | `setpoint` 5–28 °C in half degrees |

Never tiles: sirens (`HmIP-ASIR`), contacts, the chime, and the CCU's virtual copies of Hue lights (`VIR-*`).
Door locks and alarm functions are not to be added here. Functions (`kinds`): Hue lights and dimmers are
`light`; a Homematic switch is `switch`, because the twin cannot tell a lamp from a socket. A CCU name that
starts with its device type is shown without it; a room "0.Kitchen" is shown as "Kitchen".

## Labels

The home's words, in the code's language. A room or a device keeps the name it has in the CCU or the Hue app:
**that name is the key**, as the edge shows it (a CCU name without its device type, a room without its floor and
place numbers: "1.6 Garden" is "Garden"). A translation is looked up by it; a missing one shows the name itself, so nothing is ever blank.

**The CCU and the Hue app keep their own names**, IDs and all ("HM-LC-Sw4-DR IEQ0168402:1"): nothing is renamed
there for the phones. The translations live on the edge only.

- One dictionary per edge: `/opt/dhe/cbox/labels.json` (0600, runtime only: it holds room and device names),
  `{ version: 1, labels: { "<original>": { en, de, fr } } }`, read again when it changes.
- Edited in the edge portal (*Labels*: columns *Original (ID)*, i.e. the name as the CCU or Hue shows it, then
  EN, FR, DE; filter by kind or by what is missing in a language) or over `GET`/`PUT /api/panel/labels`.
- Every device of the twin is listed, also those that are no tile (buttons, contacts, sensors, the weather
  station: *other devices*), so each has its words ready; the CCU's copies of the Hue lights (`VIR-…`) are not.
- The node translates the tiles and rooms of each code's `scope` into that code's `lang`. A change reaches the
  phones at once (the retained `scope` is published again).
- Words that leave the twin keep their translations and are listed as no longer in the twin.
- The portal uses the same dictionary for room names on its own screens and on the printed cards.

## Cards

A card is one QR code with its name, where it applies and how to use it. It is printed and scanned, so it is
always light on white, in either theme, and it speaks **its code's language**, not the portal's:

- a badge in the corner: `EN`, `DE` or `FR`;
- the scope line (floors, rooms, functions) and the hint under the QR in that language, rooms from the label
  dictionary;
- the link in the QR carries it too, `#c=<id>.<secret>&l=<lang>`, so the phone page speaks it from the
  first screen, before the broker sends the scope.

## Topics

All under `dhc/panel/<code id>/`. JSON payloads, at most 512 bytes from a phone.

| Topic | Direction | Payload |
|---|---|---|
| `scope` | edge → phone, retained | `{ name, lang, bell, tiles: [{ id, kind, func, label, room }] }`. Labels and rooms in `lang`. No device references |
| `state` | edge → phone, retained | `{ <tile id>: { on, level, setpoint, temp, reachable } }` |
| `event` | edge → phone | `{ t: "ring", ringId, from }` · `{ t: "rung", listeners }` · `{ t: "answer", answer, by }` · `{ t: "answered", answer, by }` · `{ t: "refused", tile, why }` |
| `act` | phone → edge | `{ tile, action: "on"\|"off"\|"level"\|"setpoint", value }`. At most 30 in 10 s per code |
| `status` | phone → edge, retained | `{ state: "online" }`; `{ state: "offline" }` is the last will |
| `ring` | phone → edge | `{}`. Only a `ring` code; one ring per 5 s |
| `answer` | phone → edge | `{ answer: "coming"\|"wait"\|"leave" }`. Only a `listen` code, within 2 min of a ring |
| `frame` | door → edge → listening phones | A JPEG, binary, not retained, at most 150 kB and 5 a second. Only from a `door` code inside its watch window; relayed to the `listen` codes that are online; never stored |
| `event {t:"watch"}` | edge → door | `{ t: "watch", ringId, seconds }`: send pictures for that long (120 s after a ring, 20 s after an answer) |

State: the node takes what the data pipeline's polls report (CCU statelist and Hue lights, every 30 s) and shows
a tapped value at once; the next reading corrects it.

## The bell

A ring from a `ring` code goes to every `listen` code as an event, and sets off the house's own bell:

- **Hue lights blink** (`alert: lselect`: 15 s, then back to what they were) and a **Homematic chime** sounds
  (`HM-OU-CF-Pl`: channel 1 its light, channel 2 its sound, each offered by itself; `HmIP-MP3P` channel 2).
  The CCU decides what the chime plays.
- Which ones is a setting, kept in the codes file as `bell: { lights: [tile id], chimes: [chime id] }` and edited
  in the web app ("When the door bell rings", with a Test button) or over `/api/panel/bell`.
- They reach the devices as ordinary commands on the node's output 1 (`kind: "bell"`, `set: "alert"` or `"on"`),
  so the same `write device` function sends them. Nothing ticked: only the phones ring.

## Door station

The house has an analog 4-wire video intercom whose indoor monitor is broken; the outdoor station (button,
camera, speaker) still works. A **door station adapter** turns it into an MQTT device: a Raspberry Pi at the
station's cable with an interface board, a USB video grabber and a USB sound card
(`devices/door-adapter/`). The monitor is replaced by an old phone on the wall: an ordinary `listen` code.

```
station button ──▶ adapter: ring ──▶ engine ──▶ every listen code: ring card; Hue blink, chime (as above)
                                        └──▶ adapter: event watch 120 s
station camera ──▶ adapter: frame (JPEG, 3/s) ──▶ engine ──▶ listen codes online: the picture on the ring card
phone answer ──▶ engine ──▶ adapter: event answer ──▶ voice clip on the station's speaker ("Quelqu'un arrive.")
```

- The adapter has its own code of `kind: "door"`: bell `ring`, no tiles, made in the portal; its link is shown
  once to paste into the Pi's installer, never printed. The broker lets it publish `ring`, `status`, `frame`.
- **Pictures only during a ring**: the engine asks for them (`watch`) and drops any frame outside the window,
  over 150 kB or over 5 a second. They go to listening phones only, are never stored or logged, and stay on
  the LAN. There is no "look at the door" without a ring.
- The voice clips speak the phone page's own words in the door code's language (`make-clips.sh`).
- **No door opener**: the lock is not wired, there is no tile for it (decision of 2026-11-11).
- **No talking back** yet: a phone gives a page its microphone only on HTTPS.

## The node and its flow (tab "Panel")

- `dhc-panel` in: `{ topic: "values", payload: { source: "ccu"|"hue", values } }`.
- Out 1: `{ topic: "act", payload: { source, ref, kind, set: "on"|"level"|"setpoint", value, label, name } }`
  → `write device (Hue / CCU)`: Hue `PUT /api/<key>/lights/<id>/state`, CCU `statechange.cgi?ise_id=…`.
- Out 2: `{ topic: "ring"|"answer"|"status", payload }`: for anything else a ring should do in a flow.
- Admin API, behind the edge's basic auth: see `flows/flow-api.md` → Panel.

## Pages

- **Family page** `webapp/static/panel/` → `/app/panel/`: plain ES2017, no libraries, its own small MQTT client
  (`tinymqtt.js`). The code sits after the `#`, so it is never sent to a web server. `&p=<port>` overrides 9001.
- **Admin**: the edge portal's "Scan and control" views (`webapp/src/components/Codes.js`, `Labels.js`): make a
  code and choose its language, see its card once, print the sheet, see which codes are in use, revoke; the
  door bell; the label dictionary.

## Limits

- **A code is a bearer secret on paper** and travels unencrypted on the home Wi-Fi: who photographs a card has
  its scope. Keep scopes small; revoke a card that went missing.
- **Alerts need the page open and the screen on.** On plain http a browser gives a page no notifications and no
  wake lock, and lets it sound only after one touch. A phone that should ring stays on its charger with the page
  open. Alerts on a locked phone need HTTPS (phase 4).
- **The take-along bell code belongs inside the house** (a card in the hall, the admin page), never on the door
  phone, where a visitor could scan it.
- State from outside the panel (a wall switch) shows after the next poll, up to 30 s.

## Phases

1. **Done:** broker, codes, tiles, family page, admin with print sheet; ring and answer between phones.
2. **Done:** the house's own bell: chosen Hue lights blink, a Homematic chime sounds; settings and a test button.
3. The door phone and stations with a face and a voice: atl-phone's face page with an MQTT link in place of its
   bridge (`kind: "phone"`, topics `dhc/panel/<id>/up/#` and `…/down/#`), its files kept apart (GPL-3.0).
4. Later: HTTPS/WSS with an own authority; a take-along QR on a stationary phone's screen; codes per person;
   WAN through the cloud; the phones as devices in the twin.

## Verification

- `cd contrib/dhc-panel && npm test`: tiles, scopes, actions, registry, access rules (no broker needed).
- With a broker: `MOSQUITTO_BIN=… MOSQUITTO_CTRL=… MOSQUITTO_PLUGIN=… npm test` also runs the engine and the
  page's MQTT client against a real Mosquitto with Dynamic Security: a phone gets only its own topics; a tile
  outside the scope, a wrong action and a write as another code are refused; ring and answer; a restart keeps
  the phones; a revoked code is shut out.
- On the box: see `contrib/dhc-panel/README.md` → Bring-up.
