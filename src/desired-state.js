const fs = require('fs');

// The Nexmosphere platform has no persistent storage. The X-Script API manual
// (p.11, "Element settings") is explicit: "Element settings are always restored
// to the default value after a power cycle" — and LED output is an *action*
// command, more volatile still. The complete System command set (p.44) is two
// commands, neither of which stores anything. So nothing on the controller
// remembers what we asked for, and the host has to.
//
// This is that memory: what we want each address to look like. The server
// replays it after every reconnect, which is the only way to make an LED
// "stay on" across a controller power cycle.
class DesiredState {
	constructor({ file = null } = {}) {
		this.file = file;
		this.leds = new Map(); // addr -> { mask, cmd }
		this.settings = new Map(); // addr -> Map(n -> { deviceType, value, cmd })
		if (this.file) this.load();
	}

	setLed(addr, mask, cmd) {
		this.leds.set(Number(addr), { mask, cmd });
		this.save();
	}

	setSetting(addr, n, deviceType, value, cmd) {
		const a = Number(addr);
		if (!this.settings.has(a)) this.settings.set(a, new Map());
		this.settings.get(a).set(Number(n), { deviceType, value, cmd });
		this.save();
	}

	// Forget one address, or everything. Held state we no longer want replayed
	// is worse than none — it would fight whatever the operator does next.
	clear(addr) {
		if (addr === undefined) {
			this.leds.clear();
			this.settings.clear();
		} else {
			const a = Number(addr);
			this.leds.delete(a);
			this.settings.delete(a);
		}
		this.save();
	}

	isEmpty() {
		return this.leds.size === 0 && this.settings.size === 0;
	}

	// Commands to reassert everything, settings before LEDs so that a board is
	// configured before it is lit.
	replayCommands() {
		const out = [];
		for (const byNumber of this.settings.values()) {
			for (const s of byNumber.values()) out.push(s.cmd);
		}
		for (const led of this.leds.values()) out.push(led.cmd);
		return out;
	}

	snapshot() {
		const leds = {};
		for (const [addr, v] of this.leds) leds[addr] = v;
		const settings = {};
		for (const [addr, byNumber] of this.settings) {
			settings[addr] = Object.fromEntries(byNumber);
		}
		return { leds, settings };
	}

	load() {
		let parsed;
		try {
			parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
		} catch (err) {
			// A missing file is the normal first-run case; a corrupt one should
			// not stop the tool from starting on site.
			if (err.code !== 'ENOENT') {
				console.error(`[state] ignoring unreadable ${this.file}: ${err.message}`);
			}
			return;
		}
		for (const [addr, v] of Object.entries(parsed.leds || {})) {
			if (v && typeof v.cmd === 'string') this.leds.set(Number(addr), v);
		}
		for (const [addr, byNumber] of Object.entries(parsed.settings || {})) {
			const m = new Map();
			for (const [n, v] of Object.entries(byNumber || {})) {
				if (v && typeof v.cmd === 'string') m.set(Number(n), v);
			}
			if (m.size) this.settings.set(Number(addr), m);
		}
	}

	save() {
		if (!this.file) return;
		try {
			fs.writeFileSync(this.file, JSON.stringify(this.snapshot(), null, 2) + '\n');
		} catch (err) {
			console.error(`[state] could not write ${this.file}: ${err.message}`);
		}
	}
}

module.exports = { DesiredState };
