const TOUCH_RE = /^X(\d{3})A\[(\d+)\]$/;

const LED_STATES = { off: 0, fast: 1, slow: 2, on: 3 };

// Per the XT Touch Buttons manual, button-touch values are sparse:
// 0 = release, 3 = button1, 5 = button2, 9 = button3, 17 = button4.
const BUTTON_FROM_VALUE = { 3: 1, 5: 2, 9: 3, 17: 4 };

// Per-setting bounds, also from the manual.
const SETTING_BOUNDS = {
	4: { min: 1, max: 253, default: 5, label: 'Lower threshold' },
	5: { min: 3, max: 255, default: 110, label: 'Upper threshold' },
	6: { min: 1, max: 255, default: 2, label: 'Trigger time (×20ms)' },
};

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

function cmdLed(addr, state) {
	if (!(state in LED_STATES)) {
		throw new Error(`Unknown LED state '${state}'. Valid: ${Object.keys(LED_STATES).join(', ')}`);
	}
	const a = String(addr).padStart(3, '0');
	return `X${a}A[${LED_STATES[state]}]`;
}

function cmdSetting(addr, n, v) {
	const bounds = SETTING_BOUNDS[n];
	if (!bounds) throw new Error(`Unknown XT setting ${n}. Valid: ${Object.keys(SETTING_BOUNDS).join(', ')}`);
	if (v < bounds.min || v > bounds.max) {
		throw new Error(`XT setting ${n} value ${v} out of range [${bounds.min}, ${bounds.max}]`);
	}
	const a = String(addr).padStart(3, '0');
	return `X${a}S[${n}:${v}]`;
}

module.exports = {
	parseTouch,
	interpretTouch,
	cmdLed,
	cmdSetting,
	LED_STATES,
	SETTING_BOUNDS,
};
