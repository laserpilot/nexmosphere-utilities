# Nexmosphere Utility

A small on-site web tool for testing and configuring Nexmosphere XN-series controllers, XT touch buttons, XR RFID antennas, and XR2 NFC drivers. Plug the controller into USB, run `npm start`, open the URL it prints. Live event stream on the left, per-device controls on the right.

![Nexmosphere Utility — live event log on the left, XT touch + XR RFID device cards on the right](./screenshots/utility.png)

## Hardware tested

- **XN-145** USB X-Talk interface — Prolific PL2303 (vendor `0x067B`).
- **XT-1GW6** large single-button capacitive touch (with LED).
- **XR-DR1** RFID driver + **XR-A50** antenna (parser scaffolded; format matches the Nexmosphere "XR Range RFID" manual, see `docs/`).
- **XR-DR2** / **XR-DW2** NFC drivers (parser and command set built from the X-Script API manual p.17, see `docs/` — not yet bench-tested against hardware).

The auto-detect heuristic also accepts FTDI, Silicon Labs CP210x, and WCH CH340 USB-serial chips by vendor ID.

## macOS setup note

Prolific PL2303 chips need Prolific's macOS driver — macOS does not ship a working built-in one. You need the v2 DriverKit (`.dext`) version. The Mac App Store listing ("PL2303 Serial") works, but Prolific also publishes the installer directly, which is easier to script and to carry on-site:

```sh
brew install --cask prolific-pl2303
```

Or download it by hand — the archive is 7-Zip, which macOS `tar` reads natively:

```sh
curl -LO 'https://www.prolific.com.tw/wp-content/uploads/2025/07/PL2303HXD_G_Mac-Driver_v2.2.11_20250314.pkg_-1.7z'
tar -xf 'PL2303HXD_G_Mac-Driver_v2.2.11_20250314.pkg_-1.7z'
open 'PL2303HXD_G_Mac Driver_v2.2.11_20250314.pkg'
```

v2.2.11 (2025-03-14), SHA-256 of the `.7z`: `2c4c1ebf8f1eb997cde5c138b881c4389e17069114b6ef3a1aaff53e424465f2`. The `.pkg` is notarized and signed by *Developer ID Installer: Prolific Technology Inc. (2MP849R8J5)*; check with `pkgutil --check-signature`. It installs `/Applications/PL2303Serial.app`, which carries the `com.prolific.cdc.PLCdcFSDriver.dext` — the same driver extension the App Store app ships. (It also drops legacy kexts in `/Library/Extensions`; those are inert on current macOS, the dext is what loads.)

Either way, enable it afterwards in **System Settings → General → Login Items & Extensions → Driver Extensions**. After enabling, a `/dev/tty.PL2303G-USBtoUART*` node appears.

Verify with:

```sh
systemextensionsctl list | grep -i prolific      # should show: enabled * active *
ls /dev/tty.PL2303G-USBtoUART*                   # should list a node
```

## Run

```sh
npm install
npm start
```

Output:

```
[hh:mm:ss] Web UI: http://127.0.0.1:3000
[hh:mm:ss] Held state: /path/to/.nexmosphere-state.json
[hh:mm:ss] Serial: /dev/tty.PL2303G-USBtoUART110 @ 115200 8N1
```

Open the URL. Touch your button — events flash in the log and a card appears for the address.

The web UI comes up whether or not the controller is plugged in, and the serial
link reconnects on its own (1s, doubling to 10s) when the controller is
unplugged, power-cycled, or enumerates under a different tty node.

### Flags

- `--port <web-port>` — default `3000`. Or set `PORT` env var.
- `--host <bind-host>` — default `127.0.0.1`.
- `--device <devpath>` — skip auto-detect, e.g. `--device /dev/tty.PL2303G-USBtoUART110`.
- `--state-file <path>` — where held state lives. Default `.nexmosphere-state.json` in the project root.
- `--no-persist` — keep held state in memory only; forget it when the process exits.
- `--calibration-ms <ms>` — how long to wait after a serial link comes up before scanning and replaying held state. Default `10000`, sized to the XT calibration window.
- `--scan-max <n>` — highest X-talk channel to probe on a scan. Default `8`, which covers every XN model.
- `--scan-grace-ms <ms>` — how long to keep listening after the last probe goes out. Default `1500`.
- `--no-scan` — never scan; devices appear only once they emit an event, as before.

## What you can do from the UI

- **Live log**: every parsed event (touch press/release, RFID picked/placed) plus a "raw bytes" toggle for hex inspection.
- **Scan**: asks every X-talk channel what is connected — see below. Runs automatically after each connect.
- **XT card** (per address that emits touch events):
  - **LED control**: Off / Fast blink / Slow blink / On, applied to all four LEDs. The active state is highlighted and **held** — see below.
  - **Sensitivity**: settings 4 (lower threshold), 5 (upper threshold), 6 (trigger time × 20ms). Slide and click Apply.
- **RFID card** (XR-DR1, per antenna address):
  - **Status LED behavior**, **antenna gain** (5 levels), **interference indicator**, **filter level** (1–20).
- **NFC card** (XR-DR2 / XR-DW2):
  - **Read tag**: request UID, tag number, or any of the three text labels. The reply arrives as a normal event — which is also the only way to see a tag when trigger mode is set to "no triggers".
  - **Write tag**: set the tag number (1–65535) or labels 1–3 (16 ASCII characters each) on whatever tag is on the antenna. The UID is burned into the chip and is read-only.
  - **Settings**: status LED behavior, gain, interference indicator, filter level, plus **trigger mode** (setting 9) and **output format** (setting 10) — held, like every other setting.
  - **Tag maintenance**: erase (all / tag number / labels), format NTAG, set the lock password, lock, unlock, reload NDEF. Each destructive button confirms first, and the server refuses these commands unless the confirmation came with them.
- **Raw send**: textbox at the top accepts arbitrary X-Talk commands like `X004A[3]`. Deliberately *not* held — a raw command is a one-off probe.
- **Clear holds**: drops every held LED state and setting so nothing is re-asserted. Each card also has its own **Clear hold**.

## Device discovery

Elements used to appear only once they fired an event, which meant walking the
install pressing every button to find out what was plugged in. The **Diagnostic
commands** (API manual p.45) ask the controller directly, without triggering
anything:

```
D001B[TYPE]      ->  D001B[TYPE=XT1GW6 ]
D001B[SERIAL]    ->  D001B[SERIAL=11844_22-014-21 ]
```

A scan probes `D001B[TYPE]` through `D008B[TYPE]` (8 covers every XN model), then
asks for serial numbers from only the channels that answered. Cards appear with
the product code and serial filled in, and the product code prefix picks the card
type — `XT-1xx`/`XT-4xx` → touch, `XR-DR2`/`XR-DW2` → NFC, other `XR…` → RFID,
anything else gets a card labelled with its raw code.

A scan runs automatically after every connect (after the calibration wait, before
held state is replayed), and the **Scan** button in the top bar re-runs it.

Two caveats worth knowing:

- The manual does not document what an *empty* channel replies, so a scan is
  bounded by time rather than by waiting for one answer per address. If your
  controller does answer for empty channels, you will see phantom cards — tell
  me and the filter is a one-liner.
- p.11 notes status requests are "not intended to be used as a polling
  mechanism", so this is a scan on connect, not a loop.

## Held state — making an LED stay on

Nexmosphere controllers store nothing. The X-Script API manual is explicit (p.11,
"Element settings"):

> Element settings are used to control the behavior of an X-talk Element (e.g. the
> status LED behavior). **Element settings are always restored to the default value
> after a power cycle.**

LED output is an *action* command, more volatile still, and the entire System
command set (p.44) is `S111B[ON|OFF]` for autotrigger and `S112B[X:ON|OFF]` for
channel activation — neither of which saves anything. There is no store, commit,
or boot-default command anywhere in the API, and no way to read an LED back
(`X<addr>A[ ]` is a status request that returns the *trigger input*, not the LED).
Persistence does exist for a few sensors' calibration data — `X001B[STORE=P1]` on
the XZ-A40, `CALI=BG`/`CALI=WH` on the XZ-H60, each paired with
`X001B[FACTORYRESET]` — but nothing of the kind exists for XT boards.

So the host has to be the memory. Every LED state and setting you apply is
recorded as **held**, and re-sent:

- after the controller is power-cycled or replugged (the link reconnects, then replays),
- after this tool itself is restarted (held state is written to `.nexmosphere-state.json`).

Replay waits `--calibration-ms` (default 10s) after the link comes up, because the
XT buttons spend ~10s after power-on calibrating to their environment and should
not be written to during it. Settings are replayed before LED states, and the
whole batch is paced at 75ms per command.

Held state is visible per card and cleared with **Clear hold**, or all at once
with **Clear holds** in the top bar. Run with `--no-persist` to keep holds in
memory only.

## OSC (optional)

Flip the **OSC** checkbox in the top bar (default destination `127.0.0.1:8000`). Parsed events fan out as:

```
/nexmosphere/<addr>/press     <int value>
/nexmosphere/<addr>/release   <int value>
/nexmosphere/<addr>/picked    <int tag>
/nexmosphere/<addr>/placed    <int tag>
```

Quick listener in another terminal (uses the same `osc` lib already in `node_modules/`):

```sh
node -e "const osc=require('osc'); const u=new osc.UDPPort({localAddress:'0.0.0.0',localPort:8000,metadata:false}); u.on('message',m=>console.log(m.address,m.args)); u.open();"
```

## Layout

```
src/
  server.js         http + ws + serial wiring
  serial.js         port detect, reconnecting link, paced write queue
  registry.js       in-memory addr → device state
  discovery.js      diagnostic probes: what is on each X-talk channel
  desired-state.js  held LED/settings, replayed after every reconnect
  osc-out.js        UDP OSC sender
  devices/
    xtouch.js       parse touch + format LED/settings commands
    rfid.js         pair XR[PU/PB] with X<addr>A[1/0]; format settings
    nfc.js          XR2 NFC: parse X<addr>B[TD=…]; read/write/erase tag commands
public/
  index.html  app.js  style.css
docs/
  API_Manual_Q4_2025.pdf      X-Script serial API, all Elements + system commands
  XT-Touch-buttons-manual.pdf
  XR-Range-RFID-manual.pdf
```

## Protocol notes (gathered from manuals + bench testing)

- **Baud**: 115200 8N1.
- **Command terminator**: bare CR (`\r`). CRLF is also accepted on the device side; replies arrive with CRLF.
- **Touch event**: `X<addr>A[<v>]` — `0`=release, `3`=button1, `5`=button2, `9`=button3, `17`=button4 (per XT manual, page 2).
- **LED command**: same form, opposite direction. `X<addr>A[<v>]` where `v` is a **bitfield**, two bits per LED, LED 1 in the low bits: `0`=off, `1`=fast blink, `2`=slow blink, `3`=on. So all four LEDs on is `A[255]`, not `A[3]` — `A[3]` is LED 1 only. All-LED values: `0` off, `85` fast, `170` slow, `255` on (API manual p.36).
  - Note the XT product manual's Appendix A prints `X=64` for "LED 4 off / others on"; the API manual's `A[63]` is the correct value. `64` is LED 4 fast blink.
- **Settings**: `X<addr>S[<n>:<v>]`, reset on power cycle.
- **Command spacing**: leave 50–100ms between consecutive control commands or one can be dropped (API manual p.11). This app queues every write and paces it at 75ms.
- **Diagnostics**: `D<addr>B[TYPE]` and `D<addr>B[SERIAL]` report what is connected to a channel without triggering it. Replies come back padded inside the brackets (`D001B[TYPE=XY146 ]`), so trim before comparing.
- **Detecting a dead link**: node-serialport does not surface a vanished device on the read side — `isOpen` keeps returning true until the next *write* fails. This app also watches for the tty node to disappear (every 2s), which catches an unplug or power cycle while idle.
- **NFC tag events** (XR-DR2 / XR-DW2): one line, `X<addr>B[TD=<FIELD>:<value>]` for detected and `TR=` for removed. Which field arrives depends on setting 10 (output format): `UID`, `TNR`, `LB1`–`LB3`, or several at once for formats 6 and 7. The manual prints no combined example, so this app finds each `UID:`/`TNR:`/`LB1:` key in the payload and takes everything up to the next one — separator-agnostic. Values arrive space-padded to their fixed width, so trim.
  - A reply to a data request (`X<addr>B[UID?]`) comes back in exactly the same shape as a tag event; there is no way to tell them apart from the line alone.
  - The Q4 2025 manual prints every option of setting 10 as `X001S[10:1]`. The values are 1–8 in the order listed.
  - Do not confuse this with the XR-DR1 driver: same `XR` product prefix, completely different protocol. `X<addr>B[…]` on an XR-DR1 is a *status reply* (`X001B[ d004 d002 d000 d000]`), which is why the NFC parser insists on a `TD=`/`TR=` payload.
- **RFID pickup**: two consecutive lines — `XR[PU<nnn>]` then `X<addr>A[1]`. Placeback: `XR[PB<nnn>]` then `X<addr>A[0]`. The antenna line shares format with touch release, which is why this app pairs them with a 500 ms window before deciding which device fired.

## Acknowledgements

Protocol-parsing patterns (touch / RFID / setting message formats) were originally extracted from the [@signageos/nexmosphere-sdk-js](https://github.com/signageos/nexmosphere-sdk-js) library by signageOS (MIT). This project re-implements those patterns in plain JavaScript inside a small web utility — it is not a fork of the SDK and does not ship signageOS code.

## License

MIT — see [LICENSE](./LICENSE).
