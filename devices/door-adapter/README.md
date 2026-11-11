# dhc-door: the door station adapter

An analog outdoor door station (here: a TMEZON 4-wire video intercom whose indoor monitor is broken) as an
MQTT device of digitalhome.edge. Its button rings every phone with a listening code, its camera shows on their
ring card during the ring, and their answer is spoken on the station's speaker. Spec:
[`docs/specs/panel-scan-and-control.md`](../../docs/specs/panel-scan-and-control.md) → Door station.

```
outdoor station ══ 4 wires ══ interface board ── Raspberry Pi (Wi-Fi) ── MQTT over WebSocket ── the edge
  button  ──▶ call detect ──▶ GPIO           → ring
  camera  ──▶ USB video grabber ──▶ ffmpeg   → frame (JPEG 640×360, 3/s), only while the edge asks (watch)
  speaker ◀── amp ◀── USB sound card ◀ aplay ← answer ("Quelqu'un arrive.")
  12 V    ◀── 12 V supply (and 5 V for the Pi from it)
```

No door opener: the lock wires stay unconnected. No talking back yet.

## What the photos show (monitor MZ-IP-V142B, 2026-11-11)

The monitor's label and board, and the cable that came out of the wall:

| Monitor port | Pins (label order) | Board |
|---|---|---|
| DOOR1, DOOR2 | VCC, Audio, GND, Video | CN1, CN2 |
| CAM1, CAM2 | VCC, Alarm, GND, Video | CN3, CN4 |
| OUT (a second monitor) | Audio, GND, DATA, Video | CN6 |
| DC | GND, DC | J15 |
| NET | 4 pins | — |

Also on the board: J21 "HOOK", J3 a serial port (3V3, TX, RX, GND), an I²C header (NC, GND, SCL, SDA).

The wall has **two cables**:
- **4 wires** with the DOOR connector: **red = VCC, white = Audio, black = GND, yellow = Video**, the usual
  colours for the label's order. This is the outdoor station.
- **2 wires** (white with a red stripe) with a small 2-pin plug that fits DC (J15): the monitor's power, from
  the kit's **DIN-rail supply in the electrical panel** (TMEZON "Modulo", type DR-60-12: 12 V, 60 W class,
  100–240 V in). 60 W is far more than the station, the Pi (about 3 W) and a small amplifier need, so the
  adapter runs from it: 12 V to the station's red wire, and a 12 → 5 V 3 A step-down for the Pi. Leave the
  supply's output trimmer as it is.

The station cable is the kit's 4-wire intercom cable, AWG24 (about 0.2 mm²), up to 15 m: about 1.3 Ω a wire,
so a few tenths of a volt lost at the station's current. Unshielded: fine for CVBS video at this length.

What this means for the board:
- **The button has no wire of its own.** The call travels on the **white audio wire**, which also carries the
  speaker and the microphone. So call detection and the voice share that wire: a comparator/optocoupler
  watches its DC level, and the speaker signal goes in through a capacitor. The measurement below decides
  both.
- The **lock** is not in this cable: in these kits it is wired at the outdoor station. It stays as it is.
- The station's power comes from the monitor's VCC pin: the adapter supplies it from the 12 V supply.

## 0. Measure first

With the cable above, five readings (multimeter, monitor unplugged):

1. **The 2-wire cable**: 12 V from the DIN supply; confirm the volts and note which wire is +.
2. **Power the station**: that supply's + to **red**, − to **black**. Nothing on white and yellow yet.
3. **The call, on white against black**: the DC volts at rest, while the button is held, after it is released
   (and whether it stays changed for a while). A clear step of a volt or more: an optocoupler or comparator
   will see it. If nothing changes in DC: the station sends a tone; then the USB sound card listens for it.
4. **The current** in the red wire, at rest and with the button held (in the dark too, for the infrared
   LEDs). Not needed for the supply (it has plenty); useful to know what the station draws.
5. **The video, yellow against black**, on a TV's composite input or a cheap CVBS screen: a steady picture
   means CVBS (any USB composite grabber works); rolling or none means AHD 720P (an AHD-to-CVBS converter
   in front of the grabber, or an AHD-capable grabber).

Then the speaker: a quiet tone through a 10 µF capacitor into white (− to black) should be heard at the
station.

Write the results into this file (a "Wiring" section), so the board below can be built to them.

## Video: a grabber that takes either standard

The old monitor's picture was unsteady, but the monitor is the broken part, so that says nothing certain about
the signal. Rather than find out, use a chain that accepts both: a small **"4-in-1" converter (AHD / TVI / CVI /
CVBS → HDMI)**, which detects the standard by itself, then a **USB HDMI grabber** (UVC, e.g. one with an
MS2109 chip), which the Pi sees as `/dev/video0` with no driver. Both run from 5 V or 12 V. If the TV test
(reading 5) shows a steady picture, a plain USB composite grabber is enough and cheaper.

## Camera power

The camera can be switched off between rings: a logic-level MOSFET (or a small relay) in the station's red
wire, driven from a GPIO, and two lines in `/etc/dhc-door/config.json`:

```json
{ "camera_on_cmd": "pinctrl set 27 op dh", "camera_off_cmd": "pinctrl set 27 op dl", "camera_warmup_ms": 1500 }
```

The adapter then switches it off at start, on when a ring is watched (pictures start after the warm-up), and
off when the window ends.

**But the station is one unit on four wires**: the button signals over the audio wire, and that may need the
station powered. So test first, with the red wire disconnected: hold a 10 kΩ resistor from white to +12 V and
measure white against black while pressing the button. If the level still changes, the button rings with the
camera off, and switching is safe. If not, switching the camera off also silences the bell: leave the
commands empty. The pictures already flow only during a ring either way.

## Parts

Raspberry Pi 3 or Zero 2 W (Wi-Fi), the existing 12 V DIN supply, a 12 V → 5 V 3 A step-down for the Pi, the video converter and USB grabber (see Video), optionally a logic-level MOSFET for the camera power,
USB sound card, and a small board: an optocoupler (e.g. PC817) for the call to a GPIO
(BCM 17 by default, active low), coupling and a small amplifier (e.g. LM386) for the speaker. Low voltage only.

## Install on the Pi

1. In the edge portal: **Scan and control → Codes**, door bell: *this is the door station adapter*, a name
   ("Porte"), language **fr** (the language the visitor hears). Copy the link it shows once.
2. Copy this folder to the Pi and run `sudo bash install.sh`. It installs Node, ffmpeg, gpiod, alsa-utils and
   espeak-ng, makes the voice clips, asks for the link (input hidden), writes `/etc/dhc-door/config.json`
   (0640) and starts `dhc-door.service`.
3. Test the chain without the button: `sudo systemctl kill -s USR2 dhc-door`. Phones with a listening code ring
   and show the camera; an answer is spoken at the door. Logs: `journalctl -u dhc-door -f`.

`/etc/dhc-door/config.json` may also set `ring_cmd`, `video_cmd`, `play_cmd` and `clips` (see `index.js`,
DEFAULTS), e.g. another GPIO or `-i /dev/video1`. The phones reach the edge on port 9001; so does the adapter.

## Voice

`make-clips.sh` speaks the phone page's own answers into `clips/<lang>/{coming,wait,leave}.wav`, with piper if a
voice is given (`PIPER_MODEL_FR=/path/fr_FR-….onnx`), else espeak-ng. Own recordings with the same names are
used as they are, and are kept when the script runs again.

## Try it without hardware

```bash
npm install
DHC_DOOR_LINK='http://<edge>:1880/app/panel/#c=<id>.<secret>&l=fr' node index.js --fake --config /dev/null
```

A test picture stands in for the camera, Enter (or `kill -USR2 <pid>`) rings, and the clip to be played is
printed.

## Privacy

The camera sees the street. Pictures leave the adapter only while the edge asks for them after a ring
(120 s, 20 s after an answer); the edge relays them to listening phones and keeps none. The link in the
config file is the adapter's password: revoke the code in the portal if the Pi is lost; the service then stops
(exit 3) instead of knocking again.
