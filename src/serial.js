const { EventEmitter } = require('events');
const fs = require('fs');
const { SerialPort } = require('serialport');
const { RegexParser } = require('@serialport/parser-regex');

const BAUD = 115200;

// X-Script API manual, p.11: "If consecutive control commands are sent too fast
// after each other, a command can be missed... we recommend a delay between
// 50-100ms." Every write goes through a queue paced at this interval.
const COMMAND_GAP_MS = 75;

// XT Touch Buttons manual, "Calibration after start-up": the buttons calibrate
// to their environment for ~10s after power-on. Replaying state into that
// window is asking for trouble, so held state waits this long after a link
// comes up.
const CALIBRATION_MS = 10000;

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 10000;

// serialport only surfaces a dead port on *write* — the read side stays quiet,
// and isOpen keeps reporting true. If the controller goes away while we are
// idle we would never notice, and so never replay held state when it comes
// back. Watching for the tty node to vanish catches a real unplug or power
// cycle immediately, and costs nothing on the bus.
const PRESENCE_POLL_MS = 2000;

// USB-serial vendor IDs that commonly host Nexmosphere controllers.
const KNOWN_VIDS = new Set(['0403', '067b', '10c4', '1a86']);

function looksLikely(p) {
	const hay = `${p.path} ${p.manufacturer || ''}`.toLowerCase();
	if (/usbserial|ftdi|nexmosphere|prolific|pl2303|usbtouart|cp210|ch340|tty\.usb/.test(hay)) return true;
	return KNOWN_VIDS.has((p.vendorId || '').toLowerCase());
}

async function pickPort(explicit) {
	if (explicit) return explicit;
	const ports = await SerialPort.list();
	const likely = ports.filter(looksLikely);
	if (likely.length === 1) return likely[0].path;
	if (likely.length > 1) {
		throw new Error(
			`Multiple USB-serial devices detected; pass --device to choose one: ${likely.map((p) => p.path).join(', ')}`
		);
	}
	if (ports.length === 0) {
		throw new Error('No serial ports found. Is the XN controller plugged in?');
	}
	throw new Error(
		`No FTDI/Prolific/CP210x/CH340 USB-serial device found. Pass --device <path>. Visible ports: ${ports.map((p) => p.path).join(', ')}`
	);
}

async function openPort(path, { onLine, onRaw } = {}) {
	const port = new SerialPort({
		path,
		baudRate: BAUD,
		dataBits: 8,
		parity: 'none',
		stopBits: 1,
		autoOpen: false,
	});

	await new Promise((resolve, reject) => {
		port.open((err) => (err ? reject(err) : resolve()));
	});

	const parser = port.pipe(new RegexParser({ regex: /[\r\n]+/ }));

	if (onRaw) port.on('data', onRaw);
	if (onLine) {
		parser.on('data', (line) => {
			const clean = String(line).replace(/[\r\n]/g, '');
			if (clean.length > 0) onLine(clean);
		});
	}

	return port;
}

function sendCommand(port, msg) {
	// Nexmosphere expects bare CR (0x0D) terminator.
	port.write(msg + '\r');
}

// A serial connection that survives the controller being unplugged or power
// cycled, and that paces its writes to the interval the manual asks for.
//
// Events: 'open' (path), 'close' (reason), 'retry' ({ delay, error }),
//         'line' (string), 'raw' (Buffer), 'sent' (cmd, meta), 'warn' (message)
class SerialLink extends EventEmitter {
	constructor({ device = null, commandGapMs = COMMAND_GAP_MS, presencePollMs = PRESENCE_POLL_MS } = {}) {
		super();
		this.device = device; // explicit path, or null to re-detect on every attempt
		this.commandGapMs = commandGapMs;
		this.presencePollMs = presencePollMs;
		this.port = null;
		this.path = null;
		this.connected = false;
		this.queue = [];
		this.draining = false;
		this.reconnectDelay = RECONNECT_MIN_MS;
		this.reconnectTimer = null;
		this.presenceTimer = null;
		this.stopped = false;
	}

	status() {
		return { connected: this.connected, path: this.path, pending: this.queue.length };
	}

	async start() {
		if (this.stopped) return;
		clearTimeout(this.reconnectTimer);
		try {
			// Re-detect every attempt: the tty node name is not stable across a
			// replug (PL2303G-USBtoUART110 can come back as ...120).
			const path = await pickPort(this.device);
			const port = await openPort(path, {
				onLine: (line) => this.emit('line', line),
				onRaw: (buf) => this.emit('raw', buf),
			});

			this.port = port;
			this.path = path;
			this.connected = true;
			this.reconnectDelay = RECONNECT_MIN_MS;

			port.on('close', () => this._dropped('port closed'));
			port.on('error', (err) => this._dropped(err.message));

			this._watchPresence();
			this.emit('open', path);
		} catch (err) {
			this._retry(err);
		}
	}

	_watchPresence() {
		clearInterval(this.presenceTimer);
		if (!this.presencePollMs) return;
		this.presenceTimer = setInterval(() => {
			if (!this.connected || !this.path) return;
			fs.access(this.path, (err) => {
				if (err && this.connected) this._dropped('device node disappeared');
			});
		}, this.presencePollMs);
		// Do not hold the process open just to poll.
		if (this.presenceTimer.unref) this.presenceTimer.unref();
	}

	_dropped(reason) {
		if (!this.connected) return; // already handled; close+error both fire
		this.connected = false;
		clearInterval(this.presenceTimer);
		// The old port object may still be mid-teardown; drop our handle to it
		// so nothing tries to write through it.
		const dead = this.port;
		this.port = null;
		if (dead) { try { dead.close(); } catch (_) { /* already gone */ } }
		// Anything still queued was meant for a link that no longer exists.
		// Held state gets replayed on reconnect, so dropping it loses nothing.
		this.queue.length = 0;
		this.emit('close', reason);
		if (!this.stopped) this._retry(null);
	}

	_retry(err) {
		if (this.stopped) return;
		const delay = this.reconnectDelay;
		this.emit('retry', { delay, error: err ? err.message : null });
		this.reconnectTimer = setTimeout(() => this.start(), delay);
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
	}

	// Returns false if there is no link to write to; the caller decides whether
	// that is an error or something to hold for later. `meta` is echoed back on
	// the 'sent' event, so callers can label a command without having to track
	// the queue themselves.
	send(cmd, meta = null) {
		if (!this.connected) return false;
		this.queue.push({ cmd, meta });
		this._drain();
		return true;
	}

	sendAll(cmds, meta = null) {
		let queued = 0;
		for (const cmd of cmds) if (this.send(cmd, meta)) queued++;
		return queued;
	}

	_drain() {
		if (this.draining) return;
		this.draining = true;
		const step = () => {
			if (this.stopped || !this.connected || this.queue.length === 0) {
				this.draining = false;
				return;
			}
			const { cmd, meta } = this.queue.shift();
			try {
				sendCommand(this.port, cmd);
				this.emit('sent', cmd, meta);
			} catch (err) {
				this.emit('warn', `write failed for ${cmd}: ${err.message}`);
			}
			setTimeout(step, this.commandGapMs);
		};
		step();
	}

	close() {
		this.stopped = true;
		clearTimeout(this.reconnectTimer);
		clearInterval(this.presenceTimer);
		this.queue.length = 0;
		if (this.port) {
			try { this.port.close(); } catch (_) { /* ignore */ }
		}
		this.connected = false;
	}
}

module.exports = {
	BAUD,
	COMMAND_GAP_MS,
	CALIBRATION_MS,
	PRESENCE_POLL_MS,
	pickPort,
	openPort,
	sendCommand,
	SerialLink,
};
