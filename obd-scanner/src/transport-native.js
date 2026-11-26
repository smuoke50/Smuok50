// Transport over the Android app's native Bluetooth bridge (window.FahisNative).
// Supports Classic SPP adapters (paired in Android settings) and BLE adapters.

export const nativeAvailable = () => typeof window !== 'undefined' && !!window.FahisNative;

const events = () => (window.FahisNativeEvents ||= {});

function once(okName, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ev = events();
    const timer = setTimeout(() => { cleanup(); reject(new Error('انتهت المهلة. حاول مرة أخرى.')); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); ev[okName] = null; ev.error = null; };
    ev[okName] = (arg) => { cleanup(); resolve(arg); };
    ev.error = (msg) => { cleanup(); reject(new Error(msg)); };
  });
}

/** Paired devices + BLE devices found in a 5 s scan: [{name, address, kind: 'ble'|'classic', paired}] */
export async function scanNative() {
  const p = once('devices', 20000);
  window.FahisNative.scan();
  const json = await p;
  const list = JSON.parse(json);
  // Likely OBD adapters first.
  const score = (d) => (/obd|elm|v-?link|vgate|veepeak|konnwei|obdlink|viecar|icar/i.test(d.name) ? 0 : 1);
  return list.sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
}

export async function connectNative(device, { onDisconnect } = {}) {
  const p = once('connected', 25000);
  window.FahisNative.connect(device.address, device.kind);
  const name = await p;
  const transport = {
    name: name || device.name,
    onData: () => {},
    async write(str) { window.FahisNative.write(str); },
    async close() {
      const ev = events();
      ev.data = null;
      ev.disconnected = null;
      window.FahisNative.disconnect();
    },
  };
  const ev = events();
  ev.data = (chunk) => transport.onData(chunk);
  ev.disconnected = () => onDisconnect?.();
  return transport;
}

export function shareNative(name, text) {
  window.FahisNative.saveFile(name, text);
}
