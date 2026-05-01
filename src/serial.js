const { SerialPort } = require('serialport');
const { RegexParser } = require('@serialport/parser-regex');

const BAUD = 115200;

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

module.exports = { BAUD, pickPort, openPort, sendCommand };
