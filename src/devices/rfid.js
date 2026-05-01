const RFID_PREFIX_RE = /^XR\[P(U|B)(\d{3})\]$/;
const ANTENNA_STATE_RE = /^X(\d{3})A\[([01])\]$/;

const PAIR_TIMEOUT_MS = 500;

// Per XR Range RFID manual.
const SETTING_BOUNDS = {
	1: { kind: 'enum', values: { 1: 'LED on', 2: 'LED off', 3: 'On, off when tag placed', 4: 'Off, on when tag placed' }, default: 3, label: 'Status LED behavior' },
	4: { kind: 'enum', values: { 1: '23 dB (min)', 2: '33 dB', 3: '38 dB (default)', 4: '43 dB', 5: '48 dB (max)' }, default: 3, label: 'Antenna gain' },
	5: { kind: 'enum', values: { 1: 'Show level 3 only', 2: 'Show all levels', 3: 'Off' }, default: 1, label: 'Interference indicator' },
	6: { kind: 'range', min: 1, max: 20, default: 2, label: 'Filter level' },
};

function parseRfidPrefix(line) {
	const m = RFID_PREFIX_RE.exec(line);
	if (!m) return null;
	return { action: m[1] === 'U' ? 'picked' : 'placed', tag: parseInt(m[2], 10) };
}

function parseAntennaState(line) {
	const m = ANTENNA_STATE_RE.exec(line);
	if (!m) return null;
	return { addr: parseInt(m[1], 10), isPresent: m[2] === '0' };
}

class RfidPairer {
	constructor() {
		this.pending = null;
	}

	feed(line) {
		const prefix = parseRfidPrefix(line);
		if (prefix) {
			this.pending = { ...prefix, ts: Date.now() };
			return { kind: 'rfid_prefix', ...prefix };
		}
		const antenna = parseAntennaState(line);
		if (antenna && this.pending && Date.now() - this.pending.ts < PAIR_TIMEOUT_MS) {
			const out = {
				kind: this.pending.action === 'picked' ? 'rfid_picked' : 'rfid_placed',
				addr: antenna.addr,
				tag: this.pending.tag,
			};
			this.pending = null;
			return out;
		}
		if (this.pending && Date.now() - this.pending.ts >= PAIR_TIMEOUT_MS) {
			this.pending = null;
		}
		return null;
	}
}

function cmdSetting(addr, n, v) {
	const bounds = SETTING_BOUNDS[n];
	if (!bounds) throw new Error(`Unknown RFID setting ${n}. Valid: ${Object.keys(SETTING_BOUNDS).join(', ')}`);
	if (bounds.kind === 'enum') {
		if (!(v in bounds.values)) {
			throw new Error(`RFID setting ${n} value ${v} not in ${Object.keys(bounds.values).join(', ')}`);
		}
	} else if (bounds.kind === 'range') {
		if (v < bounds.min || v > bounds.max) {
			throw new Error(`RFID setting ${n} value ${v} out of range [${bounds.min}, ${bounds.max}]`);
		}
	}
	const a = String(addr).padStart(3, '0');
	return `X${a}S[${n}:${v}]`;
}

module.exports = {
	parseRfidPrefix,
	parseAntennaState,
	RfidPairer,
	cmdSetting,
	SETTING_BOUNDS,
};
