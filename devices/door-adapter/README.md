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
- **2 wires** (white with a red stripe) with a small 2-pin plug that fits DC (J15): most likely the monitor's
  power supply, run through the wall. If it measures 12–15 V DC it powers the station and, through a 5 V
  step-down, the Pi.

What this means for the board:
- **The button has no wire of its own.** The call travels on the **white audio wire**, which also carries the
  speaker and the microphone. So call detection and the voice share that wire: a comparator/optocoupler
  watches its DC level, and the speaker signal goes in through a capacitor. The measurement below decides
  both.
- The **lock** is not in this cable: in these kits it is wired at the outdoor station. It stays as it is.
- The station's power comes from the monitor's VCC pin: the adapter supplies it from the 12 V supply.

## 0. Measure first

With the cable above, five readings (multimeter, monitor unplugged):

1. **The 2-wire cable**: DC volts and polarity. Expected 12–15 V; note which wire is +.
2. **Power the station**: that supply's + to **red**, − to **black**. Nothing on white and yellow yet.
3. **The call, on white against black**: the DC volts at rest, while the button is held, after it is released
   (and whether it stays changed for a while). A clear step of a volt or more: an optocoupler or comparator
   will see it. If nothing changes in DC: the station sends a tone; then the USB sound card listens for it.
4. **The current** in the red wire, at rest and with the button held (in the dark too, for the infrared
   LEDs): it sizes the supply.
5. **The video, yellow against black**, on a TV's composite input or a cheap CVBS screen: a steady picture
   means CVBS (any USB composite grabber works); rolling or none means AHD 720P (an AHD-to-CVBS converter
   in front of the grabber, or an AHD-capable grabber).

Then the speaker: a quiet tone through a 10 µF capacitor into white (− to black) should be heard at the
station.

Write the results into this file (a "Wiring" section), so the board below can be built to them.

## Parts

Raspberry Pi 3 or Zero 2 W (Wi-Fi), 12 V 2 A supply, 12 V → 5 V step-down for the Pi, USB video grabber
(per step 5), USB sound card, and a small board: an optocoupler (e.g. PC817) for the call to a GPIO
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
