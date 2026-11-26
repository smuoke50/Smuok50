// Web Bluetooth (BLE) transport for ELM327-compatible adapters.
// Classic Bluetooth (SPP) adapters are not reachable from the browser: users need a BLE adapter.

const KNOWN_SERVICES = [
  0xfff0, // common clones (Vgate, Konnwei...): FFF1 notify / FFF2 write
  0xffe0, // HM-10 style: FFE1 notify+write
  0x18f0, // vLinker / iCar Pro: 2AF0 notify / 2AF1 write
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // OBDLink CX, Veepeak BLE+
];

const NAME_PREFIXES = ['OBD', 'V-LINK', 'Vgate', 'vLinker', 'IOS-Vlink', 'Android-Vlink', 'VEEPEAK', 'KONNWEI', 'Viecar', 'ELM'];

export const bleSupported = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

export async function connectBle({ onDisconnect } = {}) {
  if (!bleSupported()) throw new Error('المتصفح لا يدعم Web Bluetooth. استخدم Chrome على أندرويد أو الكمبيوتر.');
  const device = await navigator.bluetooth.requestDevice({
    filters: [...KNOWN_SERVICES.map((s) => ({ services: [s] })), ...NAME_PREFIXES.map((namePrefix) => ({ namePrefix }))],
    optionalServices: KNOWN_SERVICES,
  });
  const server = await device.gatt.connect();

  let rx = null;
  let tx = null;
  for (const uuid of KNOWN_SERVICES) {
    let service;
    try { service = await server.getPrimaryService(uuid); } catch { continue; }
    const chars = await service.getCharacteristics();
    rx = chars.find((c) => c.properties.notify || c.properties.indicate) || null;
    tx = chars.find((c) => c.properties.writeWithoutResponse) || chars.find((c) => c.properties.write) || null;
    if (rx && tx) break;
  }
  if (!rx || !tx) {
    server.disconnect();
    throw new Error('تم الاتصال لكن لم نجد خدمة OBD معروفة في هذا المحوّل.');
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const noResponse = tx.properties.writeWithoutResponse;

  const transport = {
    name: device.name || 'محوّل BLE',
    onData: () => {},
    async write(str) {
      const bytes = encoder.encode(str);
      // Stay within the default ATT MTU (23 bytes => 20 bytes payload).
      for (let i = 0; i < bytes.length; i += 20) {
        const chunk = bytes.slice(i, i + 20);
        if (noResponse) await tx.writeValueWithoutResponse(chunk);
        else await tx.writeValueWithResponse(chunk);
      }
    },
    async close() {
      try { await rx.stopNotifications(); } catch { /* already gone */ }
      rx.removeEventListener('characteristicvaluechanged', onValue);
      device.removeEventListener('gattserverdisconnected', onGone);
      if (device.gatt.connected) device.gatt.disconnect();
    },
  };

  function onValue(e) {
    transport.onData(decoder.decode(e.target.value, { stream: true }));
  }
  function onGone() {
    onDisconnect?.();
  }

  rx.addEventListener('characteristicvaluechanged', onValue);
  device.addEventListener('gattserverdisconnected', onGone);
  await rx.startNotifications();
  return transport;
}
