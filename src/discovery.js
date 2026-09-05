// Diagnostic commands (X-Script API manual, p.45) ask the controller what is
// physically connected to an X-talk channel, without triggering the Element.
// That is the only way to populate the device list before anyone touches
// anything.
//
//   D001B[TYPE]    -> D001B[TYPE=XY146 ]
//   D001B[SERIAL]  -> D001B[SERIAL=32132_18-101-24 ]
//
// Note the manual's replies carry trailing padding inside the brackets.
const DIAG_RE = /^D(\d{3})B\[(TYPE|SERIAL)=([^\]]*)\]$/;

// Every XN controller in the range tops out at 8 X-talk channels, so scanning
// 1-8 covers the whole family (XN-115 through XN-185).
const DEFAULT_MAX_ADDRESS = 8;

function addr3(addr) {
	return String(addr).padStart(3, '0');
}

function cmdType(addr) {
	return `D${addr3(addr)}B[TYPE]`;
}

function cmdSerial(addr) {
	return `D${addr3(addr)}B[SERIAL]`;
}

function parseDiagnostic(line) {
	const m = DIAG_RE.exec(line);
	if (!m) return null;
	return {
		addr: parseInt(m[1], 10),
		field: m[2].toLowerCase(), // 'type' | 'serial'
		value: m[3].trim(),
	};
}

// Map a product code back to the device families this app has UI for. The
// manual prints codes with the hyphen stripped (XY-146 replies as "XY146"),
// so match on prefix. Anything unrecognised still gets a card — the product
// code alone is useful on site.
function deviceTypeFor(productCode) {
	const code = String(productCode || '').toUpperCase();
	if (/^XT-?[14]/.test(code)) return 'xtouch'; // XT-1xx / XT-4xx touch boards
	if (/^XR/.test(code)) return 'rfid'; // XR antenna drivers
	return 'unknown';
}

function addressRange(max = DEFAULT_MAX_ADDRESS) {
	return Array.from({ length: max }, (_, i) => i + 1);
}

module.exports = {
	DEFAULT_MAX_ADDRESS,
	cmdType,
	cmdSerial,
	parseDiagnostic,
	deviceTypeFor,
	addressRange,
};
