// XR2 RFID/NFC driver — XR-DR2 (wired) and XR-DW2 (wireless).
// API manual p.17. Despite sharing the XR prefix with the XR-DR1 antenna
// driver (devices/rfid.js), this is a different protocol end to end: no
// two-line XR[PU…] + X<addr>A[1] pairing, no tag *numbers* on the wire unless
// you ask for them. Everything rides on X<addr>B[…], and what a tag event
// carries depends on the Element's output format (setting 10).

// Trigger outputs and data-request replies share one shape:
//   X001B[TD=UID:04A2B3C4D5E6F7]   tag detected
//   X001B[TR=TNR:00042]            tag removed
const TRIGGER_RE = /^X(\d{3})B\[(TD|TR)=(.*)\]$/;

// Output formats 6 and 7 return several fields at once ("UID, Tag number and
// Label 1"). The manual never prints a combined example, so rather than guess
// a separator, find where each known key starts and take everything up to the
// next one. That parses comma-, space- and semicolon-separated payloads alike.
const FIELD_KEYS = ['UID', 'TNR', 'LB1', 'LB2', 'LB3'];
const FIELD_SCAN_RE = /(UID|TNR|LB1|LB2|LB3):/g;

// Order fields are reported in, so a multi-field payload always reads the same
// way on screen and over OSC.
const FIELD_ORDER = ['uid', 'tnr', 'lb1', 'lb2', 'lb3'];

const LABEL_FIELDS = new Set(['lb1', 'lb2', 'lb3']);
const LABEL_MAX = 16; // 16 ASCII characters (manual)
const TNR_MIN = 1;
const TNR_MAX = 65535;

const ERASE_SCOPES = { all: 'ALL', tagnr: 'TAGNR', labels: 'LABELS' };

// Settings 1/4/5/6 match the XR-DR1 driver; 9 and 10 are new on the XR2.
//
// Note: the manual prints every option of setting 10 as "X001S[10:1]" — a
// copy/paste slip in the Q4 2025 revision. The values are 1-8 in the order
// listed, which is what this encodes.
const SETTING_BOUNDS = {
	1: { kind: 'enum', values: { 1: 'LED on', 2: 'LED off', 3: 'On, off when tag present', 4: 'Off, on when tag present' }, default: 3, label: 'Status LED behavior' },
	4: { kind: 'enum', values: { 1: '23 dB (min)', 2: '33 dB', 3: '38 dB (default)', 4: '43 dB', 5: '48 dB (max)' }, default: 3, label: 'Gain level' },
	5: { kind: 'enum', values: { 1: 'Show level 3 only', 2: 'Show all levels', 3: 'Off' }, default: 1, label: 'Interference indicator' },
	6: { kind: 'range', min: 1, max: 20, default: 2, label: 'Filter level' },
	9: { kind: 'enum', values: { 1: 'On detect and remove', 2: 'On detect only', 3: 'On remove only', 4: 'No triggers (data requests only)' }, default: 1, label: 'Trigger mode' },
	10: { kind: 'enum', values: { 1: 'UID', 2: 'Tag number', 3: 'Label 1', 4: 'Label 2', 5: 'Label 3', 6: 'UID + tag nr + label 1', 7: 'Label 1 + 2 + 3', 8: 'Custom' }, default: 1, label: 'Output format' },
};

function addr3(addr) {
	return String(addr).padStart(3, '0');
}

// Split a "UID:…TNR:…" payload into named fields. Values are trimmed: the
// controller pads fixed-width fields with spaces, same as diagnostic replies.
function parseFields(payload) {
	const starts = [];
	FIELD_SCAN_RE.lastIndex = 0;
	let m;
	while ((m = FIELD_SCAN_RE.exec(payload)) !== null) {
		starts.push({ key: m[1], from: m.index, valueFrom: m.index + m[0].length });
	}
	const fields = {};
	if (!starts.length) return fields;
	for (let i = 0; i < starts.length; i++) {
		const end = i + 1 < starts.length ? starts[i + 1].from : payload.length;
		// Trailing separator before the next key is not part of the value.
		const value = payload.slice(starts[i].valueFrom, end).replace(/[\s,;]+$/, '').trim();
		fields[starts[i].key.toLowerCase()] = value;
	}
	return fields;
}

// Both a tag event and a reply to a data request come back in this shape, so a
// caller cannot tell them apart from the line alone — and does not need to.
function parseTrigger(line) {
	const m = TRIGGER_RE.exec(line);
	if (!m) return null;
	const fields = parseFields(m[3]);
	if (!Object.keys(fields).length) return null;
	return {
		addr: parseInt(m[1], 10),
		action: m[2] === 'TD' ? 'detected' : 'removed',
		fields,
		// The first field present, in canonical order — what to show when
		// there is only room for one thing.
		primary: FIELD_ORDER.map((k) => fields[k]).find((v) => v !== undefined) ?? null,
	};
}

// Field values in canonical order, for logging and OSC arguments.
function fieldValues(fields) {
	return FIELD_ORDER.filter((k) => fields[k] !== undefined).map((k) => fields[k]);
}

function normField(field) {
	const f = String(field || '').toLowerCase();
	if (!FIELD_ORDER.includes(f)) {
		throw new Error(`Unknown NFC field '${field}'. Valid: ${FIELD_ORDER.join(', ')}`);
	}
	return f;
}

function cmdRequest(addr, field) {
	return `X${addr3(addr)}B[${normField(field).toUpperCase()}?]`;
}

function encodeTagNumber(value) {
	const n = Number(value);
	if (!Number.isInteger(n) || n < TNR_MIN || n > TNR_MAX) {
		throw new Error(`Tag number ${value} out of range [${TNR_MIN}, ${TNR_MAX}]`);
	}
	return String(n).padStart(5, '0');
}

function encodeLabel(value) {
	const s = String(value ?? '');
	if (s.length > LABEL_MAX) {
		throw new Error(`Label is ${s.length} characters; max ${LABEL_MAX}`);
	}
	// A bracket would terminate the command early, and anything non-printable
	// would not survive the wire — reject both rather than send a half command.
	if (!/^[\x20-\x7e]*$/.test(s) || /[[\]]/.test(s)) {
		throw new Error('Label must be printable ASCII without square brackets');
	}
	return s;
}

// The UID is burned into the chip — everything else on a tag is writable.
function cmdWrite(addr, field, value) {
	const f = normField(field);
	if (f === 'uid') throw new Error('UID is read-only — it cannot be written');
	const encoded = f === 'tnr' ? encodeTagNumber(value) : encodeLabel(value);
	return `X${addr3(addr)}B[WR=${f.toUpperCase()}:${encoded}]`;
}

function cmdErase(addr, scope = 'all') {
	const key = String(scope).toLowerCase();
	if (!(key in ERASE_SCOPES)) {
		throw new Error(`Unknown erase scope '${scope}'. Valid: ${Object.keys(ERASE_SCOPES).join(', ')}`);
	}
	return `X${addr3(addr)}B[ERASE=${ERASE_SCOPES[key]}]`;
}

function cmdFormat(addr) {
	return `X${addr3(addr)}B[FORMAT]`;
}

function cmdPassword(addr, password) {
	const pw = String(password || '').toUpperCase();
	if (!/^[0-9A-F]{8}$/.test(pw)) {
		throw new Error('Password must be exactly 8 hex characters (0-9, A-F)');
	}
	return `X${addr3(addr)}B[PASSWORD=${pw}]`;
}

function cmdLock(addr) {
	return `X${addr3(addr)}B[LOCK]`;
}

function cmdUnlock(addr) {
	return `X${addr3(addr)}B[UNLOCK]`;
}

function cmdReloadNdef(addr) {
	return `X${addr3(addr)}B[RELOAD=NDEF]`;
}

function cmdSetting(addr, n, v) {
	const bounds = SETTING_BOUNDS[n];
	if (!bounds) throw new Error(`Unknown NFC setting ${n}. Valid: ${Object.keys(SETTING_BOUNDS).join(', ')}`);
	if (bounds.kind === 'enum') {
		if (!(v in bounds.values)) {
			throw new Error(`NFC setting ${n} value ${v} not in ${Object.keys(bounds.values).join(', ')}`);
		}
	} else if (v < bounds.min || v > bounds.max) {
		throw new Error(`NFC setting ${n} value ${v} out of range [${bounds.min}, ${bounds.max}]`);
	}
	return `X${addr3(addr)}S[${n}:${v}]`;
}

// Operations that destroy tag content or change a tag's protection state. The
// server refuses these without an explicit confirmation, so a stray websocket
// message can never wipe or lock a customer's tag. A write is not on the list:
// the operator typed the value they want, which is confirmation enough.
const DESTRUCTIVE_OPS = new Set(['erase', 'format', 'password', 'lock', 'unlock']);

// One entry point for every tag operation, so the server stays a router and
// the command shapes all live here.
function command(op, addr, params = {}) {
	switch (op) {
		case 'request': return cmdRequest(addr, params.field);
		case 'write': return cmdWrite(addr, params.field, params.value);
		case 'erase': return cmdErase(addr, params.scope);
		case 'format': return cmdFormat(addr);
		case 'password': return cmdPassword(addr, params.password);
		case 'lock': return cmdLock(addr);
		case 'unlock': return cmdUnlock(addr);
		case 'reload': return cmdReloadNdef(addr);
		default: throw new Error(`Unknown NFC operation '${op}'`);
	}
}

module.exports = {
	parseTrigger,
	parseFields,
	fieldValues,
	command,
	cmdRequest,
	cmdWrite,
	cmdErase,
	cmdFormat,
	cmdPassword,
	cmdLock,
	cmdUnlock,
	cmdReloadNdef,
	cmdSetting,
	DESTRUCTIVE_OPS,
	SETTING_BOUNDS,
	FIELD_ORDER,
	FIELD_KEYS,
	LABEL_FIELDS,
	LABEL_MAX,
	TNR_MIN,
	TNR_MAX,
};
