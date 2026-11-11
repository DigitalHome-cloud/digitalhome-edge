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

## 0. Measure first

Nothing here guesses the station's signalling. Before buying or soldering, at the cable where the monitor hung:

1. **Photograph** the station's label and terminals, and the monitor's connector (colours and labels).
2. **Identify the wires** with a multimeter (monitor unplugged): usually power (+12 V), ground, video, audio.
   Then power the station from a 12 V supply on power and ground only, and measure each other wire against
   ground: at rest, while the button is held, and while it is released.
3. **The call**: does pressing the button close a separate contact, or change the level on the audio wire
   (and by how much)? This decides the call-detect input.
4. **Power**: does the station need power all the time, or did the monitor switch it on for a call? (The
   adapter keeps it powered.)
5. **Video**: connect the video wire and ground to a TV or a cheap CVBS monitor. A picture: CVBS, any USB
   "composite" grabber works. Rolling or no picture: likely AHD 720P: use an AHD-to-CVBS converter in front of
   the grabber, or an AHD-capable USB grabber. `v4l2-ctl --list-devices` on the Pi shows what it found.
6. **Speaker**: the audio wire is usually shared by speaker and microphone. Feed a quiet tone through a
   capacitor (e.g. 10 µF) and listen at the station before adding an amplifier.

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
