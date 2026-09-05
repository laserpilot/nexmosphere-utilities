const TOUCH_RE = /^X(\d{3})A\[(\d+)\]$/;

// Per the X-Script API manual (p.36), the LED byte is a bitfield: two bits per
// LED, LED 1 in the low bits. 0=off, 1=fast blink, 2=slow blink, 3=on.
// So A[3] is *LED 1 only* — "all LEDs on" is 0b11111111 = 255.
const LED_CODES = { off: 0, fast: 1, slow: 2, on: 3 };
const LED_CODE_NAMES = ['off', 'fast', 'slow', 'on'];
const LED_COUNT = 4;

// All-LED masks. These match the manual's worked examples exactly.
const LED_STATES = {
	off: 0,    // X001A[0]
	fast: 85,  // X001A[85]
	slow: 170, // X001A[170]
	on: 255,   // X001A[255]
};

// Per the XT Touch Buttons manual, button-touch values are sparse:
// 0 = release, 3 = button1, 5 = button2, 9 = button3, 17 = button4.
const BUTTON_FROM_VALUE = { 3: 1, 5: 2, 9: 3, 17: 4 };

// Per-setting bounds, also from the manual.
const SETTING_BOUNDS = {
	4: { min: 1, max: 253, default: 5, label: 'Lower threshold' },
	5: { min: 3, max: 255, default: 110, label: 'Upper threshold' },
	6: { min: 1, max: 255, default: 2, label: 'Trigger time (×20ms)' },
};

function addr3(addr) {
	return String(addr).padStart(3, '0');
}

function parseTouch(line) {
	const m = TOUCH_RE.exec(line);
	if (!m) return null;
	return { addr: parseInt(m[1], 10), value: parseInt(m[2], 10) };
}

function interpretTouch(value) {
	if (value === 0) return { isRelease: true, buttonIndex: null };
	const buttonIndex = BUTTON_FROM_VALUE[value] || null;
	return { isRelease: false, buttonIndex };
}

// Accepts either a state name (applied to all four LEDs) or an array of up to
// four state names, LED 1 first. Missing entries default to 'off'.
function ledMask(states) {
	if (typeof states === 'string') {
		if (!(states in LED_STATES)) {
			throw new Error(`Unknown LED state '${states}'. Valid: ${Object.keys(LED_STATES).join(', ')}`);
		}
		return LED_STATES[states];
	}
	if (!Array.isArray(states)) {
		throw new Error('LED state must be a state name or an array of state names');
	}
	let mask = 0;
	for (let i = 0; i < LED_COUNT; i++) {
		const name = states[i] || 'off';
		if (!(name in LED_CODES)) {
			throw new Error(`Unknown LED state '${name}'. Valid: ${Object.keys(LED_CODES).join(', ')}`);
		}
		mask |= LED_CODES[name] << (i * 2);
	}
	return mask;
}

// Inverse of ledMask: the per-LED state names a mask encodes, LED 1 first.
function describeMask(mask) {
	const out = [];
	for (let i = 0; i < LED_COUNT; i++) out.push(LED_CODE_NAMES[(mask >> (i * 2)) & 0b11]);
	return out;
}

function cmdLedMask(addr, mask) {
	const m = Number(mask);
	if (!Number.isInteger(m) || m < 0 || m > 255) {
		throw new Error(`LED mask ${mask} out of range [0, 255]`);
	}
	return `X${addr3(addr)}A[${m}]`;
}

function cmdLed(addr, states) {
	return cmdLedMask(addr, ledMask(states));
}

function cmdSetting(addr, n, v) {
	const bounds = SETTING_BOUNDS[n];
	if (!bounds) throw new Error(`Unknown XT setting ${n}. Valid: ${Object.keys(SETTING_BOUNDS).join(', ')}`);
	if (v < bounds.min || v > bounds.max) {
		throw new Error(`XT setting ${n} value ${v} out of range [${bounds.min}, ${bounds.max}]`);
	}
	return `X${addr3(addr)}S[${n}:${v}]`;
}

module.exports = {
	parseTouch,
	interpretTouch,
	ledMask,
	describeMask,
	cmdLed,
	cmdLedMask,
	cmdSetting,
	LED_CODES,
	LED_STATES,
	LED_COUNT,
	SETTING_BOUNDS,
};
