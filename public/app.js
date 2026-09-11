/* Nexmosphere Utility — frontend */

// All-LED masks from the X-Script API manual p.36. The LED byte is a bitfield,
// two bits per LED — A[3] would be LED 1 only, not "on".
const LED_MASKS = { off: 0, fast: 85, slow: 170, on: 255 };

const XT_SETTINGS = {
	4: { kind: 'range', min: 1, max: 253, default: 5, label: 'Lower threshold' },
	5: { kind: 'range', min: 3, max: 255, default: 110, label: 'Upper threshold' },
	6: { kind: 'range', min: 1, max: 255, default: 2, label: 'Trigger time (×20ms)' },
};

const RFID_SETTINGS = {
	1: { kind: 'enum', default: 3, label: 'Status LED behavior',
		values: { 1: 'On', 2: 'Off', 3: 'On / off when tag', 4: 'Off / on when tag' } },
	4: { kind: 'enum', default: 3, label: 'Antenna gain',
		values: { 1: '23 dB', 2: '33 dB', 3: '38 dB (default)', 4: '43 dB', 5: '48 dB (max)' } },
	5: { kind: 'enum', default: 1, label: 'Interference indicator',
		values: { 1: 'Level 3 only', 2: 'All levels', 3: 'Off' } },
	6: { kind: 'range', min: 1, max: 20, default: 2, label: 'Filter level' },
};

// XR2 NFC drivers (XR-DR2 / XR-DW2), API manual p.17. 1/4/5/6 mirror the XR1
// driver; 9 and 10 are new. The manual misprints every setting-10 option as
// "10:1" — the values are 1-8 in the order listed.
const NFC_SETTINGS = {
	1: { kind: 'enum', default: 3, label: 'Status LED behavior',
		values: { 1: 'On', 2: 'Off', 3: 'On / off when tag', 4: 'Off / on when tag' } },
	4: { kind: 'enum', default: 3, label: 'Gain level',
		values: { 1: '23 dB', 2: '33 dB', 3: '38 dB (default)', 4: '43 dB', 5: '48 dB (max)' } },
	5: { kind: 'enum', default: 1, label: 'Interference indicator',
		values: { 1: 'Level 3 only', 2: 'All levels', 3: 'Off' } },
	6: { kind: 'range', min: 1, max: 20, default: 2, label: 'Filter level' },
	9: { kind: 'enum', default: 1, label: 'Trigger mode',
		values: { 1: 'Detect + remove', 2: 'Detect only', 3: 'Remove only', 4: 'No triggers' } },
	10: { kind: 'enum', default: 1, label: 'Output format',
		values: { 1: 'UID', 2: 'Tag number', 3: 'Label 1', 4: 'Label 2', 5: 'Label 3',
			6: 'UID + nr + label 1', 7: 'Label 1+2+3', 8: 'Custom' } },
};

// Writable tag fields. The UID is burned into the chip, so it is read-only.
const NFC_FIELDS = [
	{ key: 'uid', label: 'UID', writable: false },
	{ key: 'tnr', label: 'Tag nr', writable: true, placeholder: '1-65535' },
	{ key: 'lb1', label: 'Label 1', writable: true, placeholder: '16 chars max' },
	{ key: 'lb2', label: 'Label 2', writable: true, placeholder: '16 chars max' },
	{ key: 'lb3', label: 'Label 3', writable: true, placeholder: '16 chars max' },
];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
	status: $('#status'),
	serialStatus: $('#serial-status'),
	clearHolds: $('#clear-holds'),
	scan: $('#scan'),
	devicePath: $('#device-path'),
	oscEnabled: $('#osc-enabled'),
	oscHost: $('#osc-host'),
	oscPort: $('#osc-port'),
	hexMode: $('#hex-mode'),
	paused: $('#paused'),
	rawForm: $('#raw-form'),
	rawCmd: $('#raw-cmd'),
	log: $('#log'),
	devices: $('#devices'),
};

let ws = null;
let reconnectTimer = null;
const cards = new Map(); // addr -> card DOM helpers
const pendingTouchClass = new Map(); // addr -> timeout id

// What the server is holding on our behalf and will re-send after every
// controller power cycle. The controller itself stores nothing.
let held = { leds: {}, settings: {} };

function connect() {
	const proto = location.protocol === 'https:' ? 'wss' : 'ws';
	ws = new WebSocket(`${proto}://${location.host}/ws`);
	setStatus('connecting…', '');
	ws.addEventListener('open', () => setStatus('connected', 'open'));
	ws.addEventListener('close', () => {
		setStatus('disconnected', 'closed');
		clearTimeout(reconnectTimer);
		reconnectTimer = setTimeout(connect, 1000);
	});
	ws.addEventListener('error', () => setStatus('error', 'closed'));
	ws.addEventListener('message', (ev) => onMessage(JSON.parse(ev.data)));
}

function setStatus(text, state) {
	els.status.textContent = text;
	els.status.dataset.state = state;
}

function send(obj) {
	if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function onMessage(msg) {
	if (msg.type === 'snapshot') {
		applyLink(msg.link || {});
		applyOscConfig(msg.osc);
		held = msg.held || held;
		(msg.devices || []).forEach(ensureCard);
		(msg.devices || []).forEach((d) => updateCardLast(d.addr, d));
		refreshHeld();
		return;
	}
	if (msg.type === 'link') { applyLink(msg); return; }
	if (msg.type === 'device') { onDevice(msg); return; }
	if (msg.type === 'scan') { onScan(msg); return; }
	if (msg.type === 'held') { held = msg.held || { leds: {}, settings: {} }; refreshHeld(); return; }
	if (msg.type === 'replay') {
		const text = msg.phase === 'scheduled'
			? `holding ${msg.count} command(s) — replaying in ${Math.round(msg.delay / 1000)}s (XT calibration window)`
			: `replayed ${msg.count} held command(s)`;
		logLine('replay', text, msg.ts);
		return;
	}
	if (msg.type === 'osc_config') { applyOscConfig(msg.osc); return; }
	if (msg.type === 'line')  { logLine('line', msg.line, msg.ts); return; }
	if (msg.type === 'raw')   { if (els.hexMode.checked) logLine('raw', `RAW ${msg.len}b: ${msg.hex}`, msg.ts); return; }
	if (msg.type === 'touch') { onTouch(msg); return; }
	if (msg.type === 'rfid')  { onRfid(msg); return; }
	if (msg.type === 'nfc')   { onNfc(msg); return; }
	if (msg.type === 'sent')  { logLine('sent', `>> ${msg.cmd}${msg.reason ? `  (${msg.reason})` : ''}`, msg.ts); return; }
	if (msg.type === 'error') { logLine('error', `ERR: ${msg.message}`, msg.ts); return; }
}

// A diagnostic reply told us what is on a channel. This is the path that puts a
// device on screen without anyone having triggered it.
function onDevice(msg) {
	ensureCard({ addr: msg.addr, type: msg.deviceType || 'unknown' });
	const c = cards.get(msg.addr);
	if (!c) return;
	if (msg.productCode) c.productCode = msg.productCode;
	if (msg.serial) c.serial = msg.serial;
	if (c.identity) {
		c.identity.textContent = [c.productCode, c.serial && `SN ${c.serial}`].filter(Boolean).join(' · ');
		c.identity.hidden = !c.identity.textContent;
	}
	if (c.badge && c.productCode) c.badge.textContent = c.productCode;
}

function onScan(msg) {
	if (msg.phase === 'scheduled') {
		logLine('scan', `scan scheduled in ${Math.round(msg.delay / 1000)}s (XT calibration window)`, msg.ts);
		return;
	}
	if (msg.phase === 'start') {
		els.scan.disabled = true;
		logLine('scan', `scanning X-talk channels 1-${msg.addresses} (${msg.reason})…`, msg.ts);
		return;
	}
	els.scan.disabled = false;
	logLine('scan', `scan found ${msg.found} element(s)${msg.added ? `, ${msg.added} new` : ''}`, msg.ts);
	(msg.devices || []).forEach((d) => onDevice({
		addr: d.addr, deviceType: d.type, productCode: d.productCode, serial: d.serial,
	}));
}

// The serial link is separate from the browser's websocket: the page can be
// happily connected while the controller is unplugged.
function applyLink(info) {
	if (info.connected) {
		els.serialStatus.textContent = 'serial: connected';
		els.serialStatus.dataset.state = 'open';
		els.scan.disabled = false;
		if (info.path) els.devicePath.textContent = info.path;
		return;
	}
	els.serialStatus.textContent = info.retryIn
		? `serial: reconnecting in ${Math.round(info.retryIn / 1000)}s`
		: 'serial: disconnected';
	els.serialStatus.dataset.state = 'closed';
	els.scan.disabled = true;
	if (info.reason) els.devicePath.textContent = info.reason;
}

// Mark which LED state each address is pinned to, so it is obvious what will
// come back after a power cycle.
function refreshHeld() {
	const anyHeld = Object.keys(held.leds || {}).length > 0 || Object.keys(held.settings || {}).length > 0;
	els.clearHolds.disabled = !anyHeld;

	for (const [addr, c] of cards) {
		const ledHold = (held.leds || {})[addr];
		if (c.ledButtons) {
			for (const [state, btn] of c.ledButtons) {
				btn.classList.toggle('held', Boolean(ledHold) && LED_MASKS[state] === ledHold.mask);
			}
		}
		if (!c.heldLine) continue;
		const parts = [];
		if (ledHold) parts.push(`LED ${ledHold.cmd}`);
		const settingHold = (held.settings || {})[addr];
		if (settingHold) {
			for (const [n, s] of Object.entries(settingHold)) parts.push(`S${n}=${s.value}`);
		}
		c.heldLine.textContent = parts.length ? `held: ${parts.join(', ')} — re-sent on reconnect` : '';
		c.heldLine.hidden = parts.length === 0;
		c.clearHold.hidden = parts.length === 0;
	}
}

function applyOscConfig(cfg) {
	if (!cfg) return;
	els.oscEnabled.checked = !!cfg.enabled;
	if (document.activeElement !== els.oscHost) els.oscHost.value = cfg.host || '';
	if (document.activeElement !== els.oscPort) els.oscPort.value = cfg.port || '';
}

function logLine(kind, text, ts) {
	if (els.paused.checked) return;
	const row = document.createElement('div');
	row.className = `row ${kind}`;
	const stamp = new Date(ts || Date.now()).toISOString().slice(11, 23);
	row.innerHTML = `<span class="ts">${stamp}</span>${escapeHtml(text)}`;
	els.log.appendChild(row);
	if (els.log.childElementCount > 500) els.log.firstChild.remove();
	els.log.scrollTop = els.log.scrollHeight;
}

function escapeHtml(s) {
	return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function onTouch(msg) {
	const evt = msg.evt; // 'press' | 'release'
	logLine(`touch ${evt}`, `${evt.toUpperCase()} addr=${msg.addr} val=${msg.value}${msg.buttonIndex ? ` btn${msg.buttonIndex}` : ''}`, msg.ts);
	const card = ensureCard({ addr: msg.addr, type: 'xtouch', lastValue: msg.value, lastSeen: msg.ts });
	flashTouch(msg.addr, evt === 'press');
	updateCardLast(msg.addr, { type: 'xtouch', lastValue: msg.value, lastSeen: msg.ts, lastEvt: evt, buttonIndex: msg.buttonIndex });
}

function onRfid(msg) {
	logLine('rfid', `${msg.action.toUpperCase()} addr=${msg.addr} tag=${msg.tag}`, msg.ts);
	ensureCard({ addr: msg.addr, type: 'rfid', lastSeen: msg.ts });
	updateCardLast(msg.addr, { type: 'rfid', lastSeen: msg.ts, lastTag: msg.tag, lastEvt: msg.action });
}

// A tag event and a reply to a data request arrive in the same shape, so both
// land here — on site you usually cannot tell them apart either, and the value
// is what matters.
function onNfc(msg) {
	const text = describeFields(msg.fields);
	logLine('nfc', `${msg.action.toUpperCase()} addr=${msg.addr} ${text}`, msg.ts);
	ensureCard({ addr: msg.addr, type: 'nfc', lastSeen: msg.ts });
	updateCardLast(msg.addr, { type: 'nfc', lastSeen: msg.ts, lastEvt: msg.action, fields: msg.fields });
	const c = cards.get(msg.addr);
	if (c && c.tagLine) {
		c.tagLine.textContent = text;
		c.tagLine.hidden = !text;
	}
	flashTouch(msg.addr, msg.action === 'detected');
}

function describeFields(fields) {
	const labels = { uid: 'UID', tnr: 'nr', lb1: 'L1', lb2: 'L2', lb3: 'L3' };
	return Object.keys(labels)
		.filter((k) => (fields || {})[k] !== undefined)
		.map((k) => `${labels[k]}=${fields[k] || '(empty)'}`)
		.join('  ');
}

function flashTouch(addr, on) {
	const card = cards.get(addr);
	if (!card) return;
	card.indicator.classList.toggle('live', on);
	clearTimeout(pendingTouchClass.get(addr));
	if (on) {
		pendingTouchClass.set(addr, setTimeout(() => card.indicator.classList.remove('live'), 1500));
	}
}

function ensureCard(d) {
	if (cards.has(d.addr)) {
		// Possibly upgrade type (unknown → xtouch/rfid)
		const c = cards.get(d.addr);
		if (d.type && d.type !== c.type) {
			rebuildCard(d.addr, d.type);
		}
		return cards.get(d.addr);
	}
	const root = document.createElement('div');
	root.className = 'card';
	const refs = {};
	cards.set(d.addr, { root, type: d.type || 'unknown', refs });
	els.devices.appendChild(root);
	rebuildCard(d.addr, d.type || 'unknown');
	return cards.get(d.addr);
}

function rebuildCard(addr, type) {
	const c = cards.get(addr);
	c.type = type;
	c.root.innerHTML = '';

	const indicator = document.createElement('span');
	indicator.className = 'touch-indicator';
	c.indicator = indicator;

	const h = document.createElement('h3');
	h.appendChild(indicator);
	const hText = document.createElement('span');
	hText.textContent = `Address ${String(addr).padStart(3, '0')}`;
	h.appendChild(hText);
	const badge = document.createElement('span');
	badge.className = `badge ${type}`;
	badge.textContent = c.productCode || type;
	h.appendChild(badge);
	c.badge = badge;
	c.root.appendChild(h);

	// Product code and serial, when a diagnostic scan has told us.
	const identity = document.createElement('div');
	identity.className = 'identity';
	identity.textContent = [c.productCode, c.serial && `SN ${c.serial}`].filter(Boolean).join(' · ');
	identity.hidden = !identity.textContent;
	c.root.appendChild(identity);
	c.identity = identity;

	const last = document.createElement('div');
	last.className = 'last';
	last.textContent = '—';
	c.root.appendChild(last);
	c.last = last;

	const heldLine = document.createElement('div');
	heldLine.className = 'held-line';
	heldLine.hidden = true;
	c.root.appendChild(heldLine);
	c.heldLine = heldLine;

	const clearHold = document.createElement('button');
	clearHold.className = 'action';
	clearHold.textContent = 'Clear hold';
	clearHold.hidden = true;
	clearHold.addEventListener('click', () => send({ action: 'clear_hold', addr }));
	heldLine.appendChild(document.createTextNode(' '));
	c.root.appendChild(clearHold);
	c.clearHold = clearHold;

	c.ledButtons = null;

	c.tagLine = null;

	if (type === 'xtouch') buildXTouch(c, addr);
	else if (type === 'rfid') buildRfid(c, addr);
	else if (type === 'nfc') buildNfc(c, addr);
	else buildUnknown(c, addr);

	refreshHeld();
}

function buildXTouch(c, addr) {
	// LED row
	const led = document.createElement('div');
	led.className = 'group';
	led.innerHTML = '<div class="group-label">LED (held — re-sent after every power cycle)</div>';
	const row = document.createElement('div');
	row.className = 'led-row';
	c.ledButtons = new Map();
	['off', 'fast', 'slow', 'on'].forEach((state) => {
		const btn = document.createElement('button');
		btn.className = 'action';
		btn.textContent = state.toUpperCase();
		btn.title = `X${String(addr).padStart(3, '0')}A[${LED_MASKS[state]}] — all four LEDs`;
		btn.addEventListener('click', () => send({ action: 'led', addr, state }));
		c.ledButtons.set(state, btn);
		row.appendChild(btn);
	});
	led.appendChild(row);
	c.root.appendChild(led);

	// Sensitivity settings
	const settings = document.createElement('div');
	settings.className = 'group';
	settings.innerHTML = '<div class="group-label">Sensitivity (held — re-sent after every power cycle)</div>';
	for (const n of [4, 5, 6]) settings.appendChild(buildSettingRow(addr, 'xtouch', n, XT_SETTINGS[n]));
	c.root.appendChild(settings);
}

function buildRfid(c, addr) {
	const settings = document.createElement('div');
	settings.className = 'group';
	settings.innerHTML = '<div class="group-label">RFID settings (held — re-sent after every power cycle)</div>';
	for (const n of [1, 4, 5, 6]) settings.appendChild(buildSettingRow(addr, 'rfid', n, RFID_SETTINGS[n]));
	c.root.appendChild(settings);
}

function buildNfc(c, addr) {
	const a3 = String(addr).padStart(3, '0');
	const nfcSend = (op, params, confirmText) => {
		if (confirmText && !window.confirm(confirmText)) return false;
		send({ action: 'nfc', op, addr, confirm: true, ...params });
		return true;
	};

	// Whatever the last tag event or data request reported, in full. The card's
	// "last:" line only has room for one field.
	const tagLine = document.createElement('div');
	tagLine.className = 'tag-line';
	tagLine.hidden = true;
	c.root.appendChild(tagLine);
	c.tagLine = tagLine;

	// Read — safe, and the only way to see a tag when trigger mode is 4.
	const read = document.createElement('div');
	read.className = 'group';
	read.innerHTML = '<div class="group-label">Read tag (reply arrives as an event)</div>';
	const readRow = document.createElement('div');
	readRow.className = 'led-row';
	for (const f of NFC_FIELDS) {
		const btn = document.createElement('button');
		btn.className = 'action';
		btn.textContent = f.label;
		btn.title = `X${a3}B[${f.key.toUpperCase()}?]`;
		btn.addEventListener('click', () => nfcSend('request', { field: f.key }));
		readRow.appendChild(btn);
	}
	read.appendChild(readRow);
	c.root.appendChild(read);

	// Write — one-off, never held: replaying a tag write on every reconnect
	// would stamp whatever tag happens to be sitting on the antenna.
	const write = document.createElement('div');
	write.className = 'group';
	write.innerHTML = '<div class="group-label">Write to the tag on the antenna (not held)</div>';
	for (const f of NFC_FIELDS.filter((x) => x.writable)) {
		const row = document.createElement('div');
		row.className = 'write-row';
		const label = document.createElement('label');
		label.textContent = f.label;
		const input = document.createElement('input');
		input.type = 'text';
		input.placeholder = f.placeholder;
		if (f.key !== 'tnr') input.maxLength = 16;
		const btn = document.createElement('button');
		btn.className = 'action primary';
		btn.textContent = 'Write';
		const submit = () => {
			if (!input.value.trim() && f.key === 'tnr') return;
			nfcSend('write', { field: f.key, value: f.key === 'tnr' ? Number(input.value) : input.value });
		};
		btn.addEventListener('click', submit);
		input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
		row.append(label, input, btn);
		write.appendChild(row);
	}
	c.root.appendChild(write);

	// Settings behave like every other Element setting: lost on power cycle,
	// so they are held and replayed.
	const settings = document.createElement('div');
	settings.className = 'group';
	settings.innerHTML = '<div class="group-label">NFC settings (held — re-sent after every power cycle)</div>';
	for (const n of [1, 4, 5, 6, 9, 10]) settings.appendChild(buildSettingRow(addr, 'nfc', n, NFC_SETTINGS[n]));
	c.root.appendChild(settings);

	// Everything below here changes the tag itself, not the reader, and several
	// of them cannot be undone — hence the confirmations.
	const danger = document.createElement('div');
	danger.className = 'group';
	danger.innerHTML = '<div class="group-label danger-label">Tag maintenance — destructive</div>';
	const dangerRow = document.createElement('div');
	dangerRow.className = 'led-row';
	const dangerOps = [
		['Erase all', 'erase', { scope: 'all' }, 'Erase the tag number AND all labels on the tag currently on the antenna?'],
		['Erase tag nr', 'erase', { scope: 'tagnr' }, 'Erase the tag number on the tag currently on the antenna?'],
		['Erase labels', 'erase', { scope: 'labels' }, 'Erase all three labels on the tag currently on the antenna?'],
		['Format NTAG', 'format', {}, 'Format the NTAG chip on the antenna? This wipes all NDEF data and cannot be undone.'],
		['Lock', 'lock', {}, 'Lock the tag with the password set on this reader? A locked tag needs the same password to unlock.'],
		['Unlock', 'unlock', {}, 'Unlock the tag using the password set on this reader?'],
		['Reload NDEF', 'reload', {}, null],
	];
	for (const [text, op, params, confirmText] of dangerOps) {
		const btn = document.createElement('button');
		btn.className = confirmText ? 'action danger' : 'action';
		btn.textContent = text;
		btn.addEventListener('click', () => nfcSend(op, params, confirmText));
		dangerRow.appendChild(btn);
	}
	danger.appendChild(dangerRow);

	const pwRow = document.createElement('div');
	pwRow.className = 'write-row';
	const pwLabel = document.createElement('label');
	pwLabel.textContent = 'Password';
	const pwInput = document.createElement('input');
	pwInput.type = 'text';
	pwInput.placeholder = '8 hex chars';
	pwInput.maxLength = 8;
	const pwBtn = document.createElement('button');
	pwBtn.className = 'action danger';
	pwBtn.textContent = 'Set';
	pwBtn.addEventListener('click', () => {
		if (!pwInput.value.trim()) return;
		nfcSend('password', { password: pwInput.value.trim() },
			'Set the lock password on this reader? Lose it and a locked tag stays locked.');
	});
	pwRow.append(pwLabel, pwInput, pwBtn);
	danger.appendChild(pwRow);
	c.root.appendChild(danger);
}

function buildUnknown(c, addr) {
	const note = document.createElement('div');
	note.className = 'group';
	note.innerHTML = '<div class="group-label">Unknown device — send raw command</div>';
	const f = document.createElement('form');
	f.style.display = 'flex';
	f.style.gap = '6px';
	const input = document.createElement('input');
	input.type = 'text';
	input.placeholder = `e.g. X${String(addr).padStart(3,'0')}A[3]`;
	input.style.flex = '1';
	input.style.background = 'var(--bg-2)';
	input.style.color = 'var(--fg)';
	input.style.border = '1px solid var(--border)';
	input.style.borderRadius = '4px';
	input.style.padding = '4px 6px';
	input.style.font = 'inherit';
	const btn = document.createElement('button');
	btn.className = 'action primary';
	btn.textContent = 'Send';
	btn.type = 'submit';
	f.append(input, btn);
	f.addEventListener('submit', (e) => {
		e.preventDefault();
		const cmd = input.value.trim();
		if (cmd) send({ action: 'raw', cmd });
		input.value = '';
	});
	note.appendChild(f);
	c.root.appendChild(note);
}

function buildSettingRow(addr, deviceType, n, spec) {
	const row = document.createElement('div');
	row.className = 'setting-row';

	const label = document.createElement('label');
	label.textContent = `${n}: ${spec.label}`;
	row.appendChild(label);

	let input, valueEl;

	if (spec.kind === 'range') {
		input = document.createElement('input');
		input.type = 'range';
		input.min = spec.min;
		input.max = spec.max;
		input.value = spec.default;
		valueEl = document.createElement('span');
		valueEl.className = 'value';
		valueEl.textContent = spec.default;
		input.addEventListener('input', () => { valueEl.textContent = input.value; });
		row.append(input, valueEl);
	} else {
		input = document.createElement('select');
		for (const [v, lbl] of Object.entries(spec.values)) {
			const o = document.createElement('option');
			o.value = v;
			o.textContent = lbl;
			if (Number(v) === spec.default) o.selected = true;
			input.appendChild(o);
		}
		valueEl = document.createElement('span');
		valueEl.className = 'value';
		valueEl.textContent = '';
		row.append(input, valueEl);
	}

	const apply = document.createElement('button');
	apply.className = 'action primary';
	apply.textContent = 'Apply';
	apply.addEventListener('click', () => {
		const v = Number(input.value);
		send({ action: 'setting', deviceType, addr, n, v });
	});
	row.appendChild(apply);

	return row;
}

function updateCardLast(addr, info) {
	const c = cards.get(addr);
	if (!c || !c.last) return;
	const ago = info.lastSeen ? `${Math.max(0, Math.round((Date.now() - info.lastSeen) / 100) / 10)}s ago` : '';
	if (info.type === 'xtouch') {
		const btn = info.buttonIndex ? `button ${info.buttonIndex}` : (info.lastValue === 0 ? 'released' : `value ${info.lastValue}`);
		c.last.textContent = `last: ${info.lastEvt || '—'} (${btn}) ${ago}`;
	} else if (info.type === 'rfid') {
		c.last.textContent = `last: ${info.lastEvt || '—'} tag ${info.lastTag ?? '—'} ${ago}`;
	} else if (info.type === 'nfc') {
		const what = describeFields(info.fields) || '—';
		c.last.textContent = `last: ${info.lastEvt || '—'} ${what} ${ago}`;
	} else {
		c.last.textContent = `last seen: ${ago}`;
	}
}

// ---- top bar wiring ---------------------------------------------------------

function pushOscConfig() {
	send({
		action: 'osc',
		enabled: els.oscEnabled.checked,
		host: els.oscHost.value || undefined,
		port: els.oscPort.value ? Number(els.oscPort.value) : undefined,
	});
}

els.oscEnabled.addEventListener('change', pushOscConfig);
els.oscHost.addEventListener('change', pushOscConfig);
els.oscPort.addEventListener('change', pushOscConfig);

els.clearHolds.addEventListener('click', () => send({ action: 'clear_hold' }));
els.scan.addEventListener('click', () => send({ action: 'scan' }));

els.rawForm.addEventListener('submit', (e) => {
	e.preventDefault();
	const cmd = els.rawCmd.value.trim();
	if (!cmd) return;
	send({ action: 'raw', cmd });
	els.rawCmd.value = '';
});

connect();
