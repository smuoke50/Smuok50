import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Elm327 } from '../src/elm327.js';
import { createSimTransport } from '../src/transport-sim.js';

// Fake of the Kotlin BtBridge: same JS-facing contract, events delivered asynchronously
// on window.FahisNativeEvents like evaluateJavascript would.
function installFakeNative({ failConnect = false } = {}) {
  const sim = createSimTransport({ delayMs: 0 });
  const calls = [];
  const fire = (name, arg) => setTimeout(() => globalThis.window.FahisNativeEvents?.[name]?.(arg), 1);
  sim.onData = (s) => fire('data', s);
  globalThis.window = {
    FahisNative: {
      scan() { calls.push('scan'); fire('devices', JSON.stringify([
        { name: 'Headphones', address: 'AA:00', kind: 'classic', paired: true },
        { name: 'OBDII', address: 'AA:01', kind: 'classic', paired: true },
      ])); },
      connect(address, kind) {
        calls.push(`connect ${address} ${kind}`);
        if (failConnect) fire('error', 'تعذّر الاتصال');
        else fire('connected', 'OBDII');
      },
      write(s) { sim.write(s); },
      disconnect() { calls.push('disconnect'); },
      saveFile(name) { calls.push(`save ${name}`); },
    },
  };
  return { calls, sim };
}

test('native: scan sorts OBD adapters first', async () => {
  installFakeNative();
  const { scanNative } = await import('../src/transport-native.js');
  const list = await scanNative();
  assert.equal(list[0].name, 'OBDII');
  assert.equal(list.length, 2);
});

test('native: connect, full ELM session over the bridge, disconnect events', async () => {
  const { calls } = installFakeNative();
  const { connectNative } = await import('../src/transport-native.js');
  let lost = 0;
  const t = await connectNative({ address: 'AA:01', kind: 'classic', name: 'OBDII' }, { onDisconnect: () => lost++ });
  assert.equal(t.name, 'OBDII');
  const elm = new Elm327(t);
  await elm.init();
  assert.equal(await elm.readVin(), 'JTDBR32E720045631');
  assert.deepEqual(await elm.readDtcs('03'), ['P0171', 'P0420']);
  globalThis.window.FahisNativeEvents.disconnected();
  assert.equal(lost, 1);
  await elm.close();
  assert.ok(calls.includes('connect AA:01 classic'));
  assert.ok(calls.includes('disconnect'));
});

test('native: connect error rejects with the bridge message', async () => {
  installFakeNative({ failConnect: true });
  const { connectNative } = await import('../src/transport-native.js');
  await assert.rejects(connectNative({ address: 'AA:01', kind: 'ble' }), /تعذّر الاتصال/);
});
