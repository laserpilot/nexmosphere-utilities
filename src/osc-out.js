const osc = require('osc');

function createOscSender() {
	let udp = null;
	let config = { enabled: false, host: '127.0.0.1', port: 8000 };

	function open() {
		close();
		udp = new osc.UDPPort({
			localAddress: '0.0.0.0',
			localPort: 0,
			remoteAddress: config.host,
			remotePort: config.port,
			metadata: false,
		});
		udp.on('error', (err) => {
			console.error('[osc] error:', err.message);
		});
		udp.open();
	}

	function close() {
		if (udp) {
			try { udp.close(); } catch (_) { /* ignore */ }
			udp = null;
		}
	}

	function configure({ enabled, host, port }) {
		const next = {
			enabled: enabled ?? config.enabled,
			host: host || config.host,
			port: port || config.port,
		};
		const changed =
			next.enabled !== config.enabled ||
			next.host !== config.host ||
			next.port !== config.port;
		config = next;
		if (!changed) return config;
		if (config.enabled) open();
		else close();
		return config;
	}

	function send(address, ...args) {
		if (!udp || !config.enabled) return;
		try {
			udp.send({ address, args });
		} catch (err) {
			console.error('[osc] send failed:', err.message);
		}
	}

	function getConfig() {
		return { ...config };
	}

	return { configure, send, close, getConfig };
}

module.exports = { createOscSender };
