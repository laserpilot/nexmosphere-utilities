#!/usr/bin/env node
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

const { pickPort, openPort, sendCommand } = require('./serial');
const { Registry } = require('./registry');
const xtouch = require('./devices/xtouch');
const rfid = require('./devices/rfid');
const { createOscSender } = require('./osc-out');

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--port') out.port = parseInt(argv[++i], 10);
		else if (a === '--device') out.device = argv[++i];
		else if (a === '--host') out.host = argv[++i];
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
const WEB_PORT = args.port || parseInt(process.env.PORT, 10) || 3000;
const HOST = args.host || '127.0.0.1';

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function ts() { return new Date().toISOString().slice(11, 23); }

async function main() {
	const registry = new Registry();
	const pairer = new rfid.RfidPairer();
	const oscSender = createOscSender();

	const wsClients = new Set();
	function broadcast(msg) {
		const data = JSON.stringify(msg);
		for (const ws of wsClients) {
			if (ws.readyState === 1) ws.send(data);
		}
	}

	const devicePath = await pickPort(args.device);
	console.log(`[${ts()}] Serial: ${devicePath} @ 115200 8N1`);

	const port = await openPort(devicePath, {
		onLine: (line) => handleLine(line),
		onRaw: (buf) => {
			const hex = Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join(' ');
			broadcast({ type: 'raw', hex, len: buf.length, ts: Date.now() });
		},
	});

	function handleLine(line) {
		broadcast({ type: 'line', line, ts: Date.now() });

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
			devicePath,
			devices: registry.snapshot(),
			osc: oscSender.getConfig(),
			ts: Date.now(),
		}));

		ws.on('message', (raw) => {
			let msg;
			try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
			handleClientMessage(msg, ws);
		});
		ws.on('close', () => wsClients.delete(ws));
	});

	function handleClientMessage(msg, ws) {
		try {
			if (msg.action === 'led') {
				const cmd = xtouch.cmdLed(msg.addr, msg.state);
				sendCommand(port, cmd);
				broadcast({ type: 'sent', cmd, reason: `led ${msg.state} on ${msg.addr}`, ts: Date.now() });
				return;
			}
			if (msg.action === 'setting') {
				const fmt = msg.deviceType === 'rfid' ? rfid.cmdSetting : xtouch.cmdSetting;
				const cmd = fmt(msg.addr, msg.n, msg.v);
				sendCommand(port, cmd);
				broadcast({ type: 'sent', cmd, reason: `setting ${msg.n}=${msg.v} on ${msg.addr}`, ts: Date.now() });
				return;
			}
			if (msg.action === 'raw') {
				const cmd = String(msg.cmd || '').trim();
				if (!cmd) return;
				sendCommand(port, cmd);
				broadcast({ type: 'sent', cmd, reason: 'raw', ts: Date.now() });
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
	});

	process.on('SIGINT', () => {
		console.log('\nShutting down.');
		oscSender.close();
		try { port.close(); } catch (_) { /* ignore */ }
		httpServer.close();
		process.exit(0);
	});
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
