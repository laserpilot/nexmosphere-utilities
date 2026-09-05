const HISTORY_CAP = 20;

class Registry {
	constructor() {
		this.devices = new Map(); // addr -> { type, lastSeen, lastValue, history }
	}

	_get(addr) {
		let d = this.devices.get(addr);
		if (!d) {
			d = { addr, type: 'unknown', lastSeen: 0, lastValue: null, history: [] };
			this.devices.set(addr, d);
		}
		return d;
	}

	record(addr, evt) {
		const d = this._get(addr);
		d.lastSeen = Date.now();
		if ('value' in evt) d.lastValue = evt.value;
		d.history.push({ ts: d.lastSeen, ...evt });
		if (d.history.length > HISTORY_CAP) d.history.shift();
		return d;
	}

	// Identity learned from a diagnostic scan rather than from traffic — this is
	// how an Element that has never been triggered gets into the list at all.
	describe(addr, { productCode, serial } = {}) {
		const d = this._get(addr);
		if (productCode) d.productCode = productCode;
		if (serial) d.serial = serial;
		d.discovered = true;
		return d;
	}

	promoteType(addr, type) {
		const d = this._get(addr);
		// Don't downgrade away from a known type.
		if (d.type === 'unknown' || d.type === type) {
			d.type = type;
		}
		return d;
	}

	snapshot() {
		return Array.from(this.devices.values()).map((d) => ({ ...d, history: d.history.slice() }));
	}
}

module.exports = { Registry };
