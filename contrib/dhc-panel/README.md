# node-red-contrib-dhc-panel

Scan and control for digitalhome.edge: phones as MQTT end devices. One revocable code per QR fixes what a phone
may show and switch. Spec: [`docs/specs/panel-scan-and-control.md`](../../docs/specs/panel-scan-and-control.md).

```
lib/tiles.js      what a phone may switch, read from the twin (a whitelist of device types)
lib/registry.js   the codes file: ids, names, scopes; never a secret
lib/labels.js     the home's words in EN/DE/FR, keyed on the name from the CCU or Hue
lib/dynsec.js     the broker's rules for a code (Mosquitto Dynamic Security)
lib/engine.js     broker link, scopes and state out, taps and rings in, checks
nodes/dhc-panel   the Node-RED node and /api/panel/* (behind the edge's basic auth)

../../devices/door-adapter   the other end of a "door" code: an outdoor station on a Raspberry Pi
```

The node never talks to a device. Output 1 carries one checked command per tap; the flow sends it to the device.

## Bring-up on a box

```bash
# 1. broker config, its folder, Node-RED's broker password. Pass the flags this box was set up with:
#    bootstrap rewrites /opt/dhe/.env from them (defaults: port 1881, DE-DEMO). It keeps existing secrets.
sudo bash deploy/bootstrap.sh --nodered-port <port> --home-id <home id>
# 2. image with this palette, new compose file, restart; the first start pulls eclipse-mosquitto
sudo dhcedge build
# 3. the "Panel" tab: pulled from the flows repository on GitHub, so that change must be pushed first
sudo dhcedge flow-pull
# 4. /app with "Scan and control" and /app/panel/
dhcedge webapp-pull
```

Step 1 must come before step 2: without the broker's config file and password file, Docker makes folders in
their place and the broker does not start.

Then, from a computer on the home network, open `http://<edge>:1880/app/`, **Manage codes** (user `dhcedge`,
password from `sudo dhcedge show-secrets`), make a code and scan it with a phone on the home Wi-Fi.
Port 9001 must be reachable from the phones. With ufw on (default deny incoming), open it to the home network
only, or the page loads but says "no link":

```bash
sudo ufw allow from 192.168.1.0/24 to any port 9001 proto tcp comment 'dhe-mosquitto websocket (panel phones)'
```

Check:

```bash
docker logs dhe-mosquitto | tail            # "mosquitto version 2.0.x running"
curl -u dhcedge:<password> http://localhost:<port>/api/panel/codes   # broker.connected: true, catalog.tiles > 0
```

`catalog.tiles` is 0 until the twin exists: connect CCU and Hue, update their config, generate the C-BOX.

## Tests

```bash
npm install
npm test                                    # units; the broker tests are skipped
MOSQUITTO_BIN=/usr/sbin/mosquitto MOSQUITTO_CTRL=/usr/bin/mosquitto_ctrl \
MOSQUITTO_PLUGIN=/usr/lib/x86_64-linux-gnu/mosquitto_dynamic_security.so npm test   # + a real broker on a random local port
```

The broker tests start their own Mosquitto in a temp folder and use the page's own client
(`webapp/static/panel/tinymqtt.js`), so they cover both ends of the wire.

## Things to know

- **The first start costs one reconnect:** the node adds its own right to publish under `dhc/#`, and the broker
  disconnects a client whose role changed. For the same reason the node rewrites a code's role only when its
  rules differ, so a Node-RED restart does not throw the phones out.
- **Changing Node-RED's broker password** (`/opt/dhe/secrets/mqtt-nodered-password`) means deleting
  `/opt/dhe/mosquitto/data/dynamic-security.json` too: every code is then void.
- **A code the broker does not know** (its data was lost) is logged at start: revoke it and make a new one.
- **Adding a device type:** one line in `CCU_RULES` (`lib/tiles.js`) and a case in `test/fixture.js`.
  Never sirens, locks or alarm functions.
