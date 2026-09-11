#!/usr/bin/env node
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

const { SerialLink, CALIBRATION_MS, COMMAND_GAP_MS } = require('./serial');
const { Registry } = require('./registry');
const { DesiredState } = require('./desired-state');
const discovery = require('./discovery');
const xtouch = require('./devices/xtouch');
const rfid = require('./devices/rfid');
const nfc = require('./devices/nfc');
const { createOscSender } = require('./osc-out');

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--port') out.port = parseInt(argv[++i], 10);
		else if (a === '--device') out.device = argv[++i];
		else if (a === '--host') out.host = argv[++i];
		else if (a === '--state-file') out.stateFile = argv[++i];
		else if (a === '--no-persist') out.noPersist = true;
		else if (a === '--calibration-ms') out.calibrationMs = parseInt(argv[++i], 10);
		else if (a === '--scan-max') out.scanMax = parseInt(argv[++i], 10);
		else if (a === '--scan-grace-ms') out.scanGraceMs = parseInt(argv[++i], 10);
		else if (a === '--no-scan') out.noScan = true;
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
const WEB_PORT = args.port || parseInt(process.env.PORT, 10) || 3000;
const HOST = args.host || '127.0.0.1';
const CALIBRATION_DELAY = Number.isFinite(args.calibrationMs) ? args.calibrationMs : CALIBRATION_MS;
const STATE_FILE = args.noPersist
	? null
	: args.stateFile || path.join(__dirname, '..', '.nexmosphere-state.json');
const SCAN_ENABLED = !args.noScan;
const SCAN_ADDRESSES = discovery.addressRange(
	Number.isFinite(args.scanMax) ? args.scanMax : discovery.DEFAULT_MAX_ADDRESS
);
// How long to keep listening after the last probe has gone out. The manual does
// not say what an empty channel replies, so a scan is bounded by time rather
// than by expecting one answer per address.
const SCAN_GRACE_MS = Number.isFinite(args.scanGraceMs) ? args.scanGraceMs : 1500;

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function ts() { return new Date().toISOString().slice(11, 23); }

async function main() {
	const registry = new Registry();
	const pairer = new rfid.RfidPairer();
	const oscSender = createOscSender();
	const desired = new DesiredState({ file: STATE_FILE });

	const wsClients = new Set();
	function broadcast(msg) {
		const data = JSON.stringify(msg);
		for (const ws of wsClients) {
			if (ws.readyState === 1) ws.send(data);
		}
	}

	function broadcastHeld() {
		broadcast({ type: 'held', held: desired.snapshot(), ts: Date.now() });
	}

	const link = new SerialLink({ device: args.device || null });
	let replayTimer = null;

	link.on('line', handleLine);
	link.on('raw', (buf) => {
		const hex = Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join(' ');
		broadcast({ type: 'raw', hex, len: buf.length, ts: Date.now() });
	});
	link.on('sent', (cmd, meta) => {
		// Emitted when the command actually reaches the wire, not when queued,
		// so the log reflects the paced order the controller really sees.
		broadcast({ type: 'sent', cmd, reason: (meta && meta.reason) || '—', ts: Date.now() });
	});
	link.on('warn', (message) => {
		console.error(`[${ts()}] serial: ${message}`);
		broadcast({ type: 'error', message, ts: Date.now() });
	});

	link.on('open', (devicePath) => {
		console.log(`[${ts()}] Serial: ${devicePath} @ 115200 8N1`);
		broadcast({ type: 'link', connected: true, path: devicePath, ts: Date.now() });

		// A freshly powered controller knows nothing about us and we know
		// nothing about it, so do both halves once the XT calibration window
		// (~10s after power-on) has passed: find out what is plugged in, then
		// push back whatever we are holding.
		clearTimeout(replayTimer);
		const cmds = desired.replayCommands();
		if (SCAN_ENABLED) {
			broadcast({ type: 'scan', phase: 'scheduled', delay: CALIBRATION_DELAY, ts: Date.now() });
		}
		if (cmds.length) {
			console.log(`[${ts()}] Holding ${cmds.length} command(s); replaying in ${CALIBRATION_DELAY}ms`);
			broadcast({ type: 'replay', phase: 'scheduled', count: cmds.length, delay: CALIBRATION_DELAY, ts: Date.now() });
		}
		if (!SCAN_ENABLED && !cmds.length) return;

		replayTimer = setTimeout(async () => {
			if (!link.connected) return;
			if (SCAN_ENABLED) await runScan('after connect');
			if (!link.connected || !cmds.length) return;
			const queued = link.sendAll(cmds, { reason: 'replay after reconnect' });
			console.log(`[${ts()}] Replayed ${queued} held command(s)`);
			broadcast({ type: 'replay', phase: 'sent', count: queued, ts: Date.now() });
		}, CALIBRATION_DELAY);
	});

	link.on('close', (reason) => {
		console.log(`[${ts()}] Serial link lost: ${reason}`);
		clearTimeout(replayTimer);
		broadcast({ type: 'link', connected: false, reason, ts: Date.now() });
	});

	link.on('retry', ({ delay, error }) => {
		if (error) console.log(`[${ts()}] Serial: ${error} — retrying in ${delay}ms`);
		broadcast({ type: 'link', connected: false, retryIn: delay, reason: error || undefined, ts: Date.now() });
	});

	// Addresses that answered a diagnostic request during the current scan.
	const responders = new Set();
	let scanning = false;

	// Ask every X-talk channel what is connected to it. Diagnostic requests do
	// not trigger the Element, so this populates the device list without anyone
	// having to touch a button. Two passes: product codes, then serial numbers
	// for whatever answered.
	async function runScan(reason) {
		if (scanning || !link.connected) return null;
		scanning = true;
		const before = new Set(registry.snapshot().map((d) => d.addr));
		responders.clear();
		broadcast({ type: 'scan', phase: 'start', addresses: SCAN_ADDRESSES.length, reason, ts: Date.now() });
		console.log(`[${ts()}] Scanning X-talk channels 1-${SCAN_ADDRESSES.length} (${reason})`);

		const settle = (n) => new Promise((r) => setTimeout(r, n * COMMAND_GAP_MS + SCAN_GRACE_MS));

		link.sendAll(SCAN_ADDRESSES.map(discovery.cmdType), { reason: 'scan: type' });
		await settle(SCAN_ADDRESSES.length);

		const found = [...responders];
		if (found.length && link.connected) {
			link.sendAll(found.map(discovery.cmdSerial), { reason: 'scan: serial' });
			await settle(found.length);
		}

		scanning = false;
		const devices = registry.snapshot().filter((d) => responders.has(d.addr));
		const added = devices.filter((d) => !before.has(d.addr)).length;
		console.log(`[${ts()}] Scan found ${devices.length} Element(s)${added ? `, ${added} new` : ''}`);
		broadcast({ type: 'scan', phase: 'done', found: devices.length, added, devices, ts: Date.now() });
		return devices;
	}

	function handleLine(line) {
		broadcast({ type: 'line', line, ts: Date.now() });

		// Diagnostic replies first — they share the D<addr>B[...] shape with
		// nothing else, so they can never be confused for element traffic.
		const diag = discovery.parseDiagnostic(line);
		if (diag) {
			responders.add(diag.addr);
			const patch = diag.field === 'type' ? { productCode: diag.value } : { serial: diag.value };
			const d = registry.describe(diag.addr, patch);
			if (d.productCode) {
				const type = discovery.deviceTypeFor(d.productCode);
				if (type !== 'unknown') registry.promoteType(diag.addr, type);
			}
			broadcast({
				type: 'device',
				addr: diag.addr,
				deviceType: d.type,
				productCode: d.productCode,
				serial: d.serial,
				ts: Date.now(),
			});
			return;
		}

		// XR2 NFC drivers (XR-DR2 / XR-DW2). X<addr>B[TD=…] is theirs alone: the
		// XR-DR1 status reply shares the X<addr>B[…] envelope but never carries
		// a TD=/TR= payload. A data-request reply arrives in the same shape as a
		// tag event, which is why both land here.
		const tag = nfc.parseTrigger(line);
		if (tag) {
			registry.promoteType(tag.addr, 'nfc');
			registry.record(tag.addr, { evt: tag.action, value: tag.primary, fields: tag.fields });
			broadcast({ type: 'nfc', addr: tag.addr, action: tag.action, fields: tag.fields, primary: tag.primary, ts: Date.now() });
			oscSender.send(`/nexmosphere/${tag.addr}/${tag.action}`, ...nfc.fieldValues(tag.fields));
			return;
		}

		const paired = pairer.feed(line);
		if (paired && (paired.kind === 'rfid_picked' || paired.kind === 'rfid_placed')) {
			const addr = paired.addr;
			const action = paired.kind === 'rfid_picked' ? 'picked' : 'placed';
			registry.promoteType(addr, 'rfid');
			registry.record(addr, { evt: action, tag: paired.tag });
			broadcast({ type: 'rfid', addr, action, tag: paired.tag, ts: Date.now() });
			oscSender.send(`/nexmosphere/${addr}/${action}`, paired.tag);
			return;
		}
		if (paired && paired.kind === 'rfid_prefix') return; // wait for the antenna line

		const touch = xtouch.parseTouch(line);
		if (touch) {
			const addr = touch.addr;
			registry.promoteType(addr, 'xtouch');
			const { isRelease, buttonIndex } = xtouch.interpretTouch(touch.value);
			const evt = isRelease ? 'release' : 'press';
			registry.record(addr, { evt, value: touch.value, buttonIndex });
			broadcast({ type: 'touch', addr, evt, value: touch.value, buttonIndex, ts: Date.now() });
			oscSender.send(`/nexmosphere/${addr}/${evt}`, touch.value);
			return;
		}

		// Unparsed — keep it visible in the log only.
	}

	const httpServer = http.createServer((req, res) => {
		const urlPath = (req.url || '/').split('?')[0];
		const filePath = urlPath === '/' ? '/index.html' : urlPath;
		const fullPath = path.join(PUBLIC_DIR, filePath);
		if (!fullPath.startsWith(PUBLIC_DIR)) {
			res.writeHead(403); res.end(); return;
		}
		fs.readFile(fullPath, (err, data) => {
			if (err) { res.writeHead(404); res.end('not found'); return; }
			const ext = path.extname(fullPath);
			res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
			res.end(data);
		});
	});

	const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
	wss.on('connection', (ws) => {
		wsClients.add(ws);
		ws.send(JSON.stringify({
			type: 'snapshot',
			link: link.status(),
			devices: registry.snapshot(),
			osc: oscSender.getConfig(),
			held: desired.snapshot(),
			persisting: Boolean(STATE_FILE),
			scanEnabled: SCAN_ENABLED,
			ts: Date.now(),
		}));

		ws.on('message', (raw) => {
			let msg;
			try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
			handleClientMessage(msg, ws);
		});
		ws.on('close', () => wsClients.delete(ws));
	});

	// Push it out now if there is a link, but the hold has already been recorded
	// either way — outliving the link is the entire point. The "sent" log line
	// comes from the link's own event once the command reaches the wire.
	function sendHeld(cmd, reason, ws) {
		if (link.send(cmd, { reason })) return;
		if (!ws) return;
		ws.send(JSON.stringify({
			type: 'error',
			message: `serial disconnected — ${cmd} held, will apply on reconnect`,
			ts: Date.now(),
		}));
	}

	function handleClientMessage(msg, ws) {
		try {
			if (msg.action === 'led') {
				const mask = msg.mask !== undefined ? Number(msg.mask) : xtouch.ledMask(msg.state);
				const cmd = xtouch.cmdLedMask(msg.addr, mask);
				desired.setLed(msg.addr, mask, cmd);
				broadcastHeld();
				sendHeld(cmd, `led ${msg.state || mask} on ${msg.addr}`, ws);
				return;
			}
			if (msg.action === 'setting') {
				const formatters = { rfid: rfid.cmdSetting, nfc: nfc.cmdSetting, xtouch: xtouch.cmdSetting };
				const fmt = formatters[msg.deviceType] || xtouch.cmdSetting;
				const cmd = fmt(msg.addr, msg.n, msg.v);
				desired.setSetting(msg.addr, msg.n, msg.deviceType, msg.v, cmd);
				broadcastHeld();
				sendHeld(cmd, `setting ${msg.n}=${msg.v} on ${msg.addr}`, ws);
				return;
			}
			// Tag operations are one-offs against whatever tag is on the antenna
			// right now, so unlike settings they are never held or replayed —
			// re-formatting a tag on every reconnect would be a disaster.
			if (msg.action === 'nfc') {
				if (nfc.DESTRUCTIVE_OPS.has(msg.op) && msg.confirm !== true) {
					ws.send(JSON.stringify({ type: 'error', message: `NFC ${msg.op} needs an explicit confirmation`, ts: Date.now() }));
					return;
				}
				const cmd = nfc.command(msg.op, msg.addr, msg);
				if (!link.send(cmd, { reason: `nfc ${msg.op} on ${msg.addr}` })) {
					ws.send(JSON.stringify({ type: 'error', message: `serial disconnected — ${cmd} dropped`, ts: Date.now() }));
				}
				return;
			}
			if (msg.action === 'scan') {
				if (!link.connected) {
					ws.send(JSON.stringify({ type: 'error', message: 'serial disconnected — cannot scan', ts: Date.now() }));
					return;
				}
				runScan('requested');
				return;
			}
			if (msg.action === 'clear_hold') {
				desired.clear(msg.addr);
				broadcastHeld();
				broadcast({
					type: 'sent',
					cmd: '—',
					reason: msg.addr === undefined ? 'cleared all held state' : `cleared held state for ${msg.addr}`,
					ts: Date.now(),
				});
				return;
			}
			if (msg.action === 'raw') {
				// Deliberately not held: a raw command is a one-off probe.
				const cmd = String(msg.cmd || '').trim();
				if (!cmd) return;
				if (!link.send(cmd, { reason: 'raw' })) {
					ws.send(JSON.stringify({ type: 'error', message: 'serial disconnected — raw command dropped', ts: Date.now() }));
				}
				return;
			}
			if (msg.action === 'osc') {
				const cfg = oscSender.configure({ enabled: msg.enabled, host: msg.host, port: msg.port });
				broadcast({ type: 'osc_config', osc: cfg, ts: Date.now() });
				return;
			}
		} catch (err) {
			ws.send(JSON.stringify({ type: 'error', message: err.message, ts: Date.now() }));
		}
	}

	httpServer.listen(WEB_PORT, HOST, () => {
		console.log(`[${ts()}] Web UI: http://${HOST}:${WEB_PORT}`);
		if (STATE_FILE) console.log(`[${ts()}] Held state: ${STATE_FILE}`);
		if (!desired.isEmpty()) console.log(`[${ts()}] Restored ${desired.replayCommands().length} held command(s) from disk`);
	});

	// Not awaited: the UI should come up and stay up whether or not the
	// controller is plugged in yet, and keep retrying until it is.
	link.start();

	process.on('SIGINT', () => {
		console.log('\nShutting down.');
		clearTimeout(replayTimer);
		oscSender.close();
		link.close();
		httpServer.close();
		process.exit(0);
	});
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
