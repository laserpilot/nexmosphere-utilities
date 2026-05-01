/* Nexmosphere Utility — frontend */

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

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
	status: $('#status'),
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
		els.devicePath.textContent = msg.devicePath || '—';
		applyOscConfig(msg.osc);
		(msg.devices || []).forEach(ensureCard);
		(msg.devices || []).forEach((d) => updateCardLast(d.addr, d));
		return;
	}
	if (msg.type === 'osc_config') { applyOscConfig(msg.osc); return; }
	if (msg.type === 'line')  { logLine('line', msg.line, msg.ts); return; }
	if (msg.type === 'raw')   { if (els.hexMode.checked) logLine('raw', `RAW ${msg.len}b: ${msg.hex}`, msg.ts); return; }
	if (msg.type === 'touch') { onTouch(msg); return; }
	if (msg.type === 'rfid')  { onRfid(msg); return; }
	if (msg.type === 'sent')  { logLine('sent', `>> ${msg.cmd}  (${msg.reason})`, msg.ts); return; }
	if (msg.type === 'error') { logLine('error', `ERR: ${msg.message}`, msg.ts); return; }
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
	badge.textContent = type;
	h.appendChild(badge);
	c.root.appendChild(h);

	const last = document.createElement('div');
	last.className = 'last';
	last.textContent = '—';
	c.root.appendChild(last);
	c.last = last;

	if (type === 'xtouch') buildXTouch(c, addr);
	else if (type === 'rfid') buildRfid(c, addr);
	else buildUnknown(c, addr);
}

function buildXTouch(c, addr) {
	// LED row
	const led = document.createElement('div');
	led.className = 'group';
	led.innerHTML = '<div class="group-label">LED</div>';
	const row = document.createElement('div');
	row.className = 'led-row';
	['off', 'fast', 'slow', 'on'].forEach((state) => {
		const btn = document.createElement('button');
		btn.className = 'action';
		btn.textContent = state.toUpperCase();
		btn.addEventListener('click', () => send({ action: 'led', addr, state }));
		row.appendChild(btn);
	});
	led.appendChild(row);
	c.root.appendChild(led);

	// Sensitivity settings
	const settings = document.createElement('div');
	settings.className = 'group';
	settings.innerHTML = '<div class="group-label">Sensitivity (resets on power cycle)</div>';
	for (const n of [4, 5, 6]) settings.appendChild(buildSettingRow(addr, 'xtouch', n, XT_SETTINGS[n]));
	c.root.appendChild(settings);
}

function buildRfid(c, addr) {
	const settings = document.createElement('div');
	settings.className = 'group';
	settings.innerHTML = '<div class="group-label">RFID settings (resets on power cycle)</div>';
	for (const n of [1, 4, 5, 6]) settings.appendChild(buildSettingRow(addr, 'rfid', n, RFID_SETTINGS[n]));
	c.root.appendChild(settings);
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

els.rawForm.addEventListener('submit', (e) => {
	e.preventDefault();
	const cmd = els.rawCmd.value.trim();
	if (!cmd) return;
	send({ action: 'raw', cmd });
	els.rawCmd.value = '';
});

connect();
