import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Elm327, ElmError, assembleMessages, cleanLines, classify, decodeDtcs, decodeSupported, decodeVin, formatDtc,
} from '../src/elm327.js';
import { createSimTransport } from '../src/transport-sim.js';
import { decodeMonitorStatus, decodePid } from '../src/pids.js';
import { describeDtc } from '../src/dtc-db.js';
import { TrimAnalyzer, fuelLphFromMaf, inspectionVerdict, lPer100, SprintTimer } from '../src/analysis.js';

test('formatDtc covers all four systems', () => {
  assert.equal(formatDtc(0x01, 0x33), 'P0133');
  assert.equal(formatDtc(0x41, 0x23), 'C0123');
  assert.equal(formatDtc(0x92, 0x34), 'B1234');
  assert.equal(formatDtc(0xc1, 0x00), 'U0100');
  assert.equal(formatDtc(0x0a, 0xbc), 'P0ABC');
});

test('cleanLines drops echo, SEARCHING and BUS INIT noise', () => {
  const lines = cleanLines('0100\rSEARCHING...\rBUS INIT: ...OK\r41 00 BE 3F A8 13\r\r', '0100');
  assert.deepEqual(lines, ['41 00 BE 3F A8 13']);
});

test('classify recognises adapter states', () => {
  assert.equal(classify(['NO DATA']), 'no-data');
  assert.equal(classify(['UNABLE TO CONNECT']), 'bus-error');
  assert.equal(classify(['?']), 'unknown-command');
  assert.equal(classify(['410C1AF8']), 'ok');
});

test('assembleMessages: multi-frame ISO-TP with spaces and padding', () => {
  const msgs = assembleMessages([
    '014',
    '0: 49 02 01 31 44 34',
    '1: 47 50 30 30 52 35 35',
    '2: 42 31 32 33 34 35 36',
  ]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].length, 0x14);
  assert.equal(decodeVin(msgs), '1D4GP00R55B123456');
});

test('assembleMessages: two ECUs answering the same PID', () => {
  const msgs = assembleMessages(['410C1AF8', '410C1AF0']);
  assert.equal(msgs.length, 2);
  assert.equal(decodePid(0x0c, msgs[0].slice(2)), 1726);
});

test('decodeVin: legacy (non-CAN) 5-part response out of order', () => {
  const lines = [
    '490202474D4643',
    '49020100000031',
    '49020355313636',
    '49020438363236',
    '49020535313433',
  ];
  assert.equal(decodeVin(assembleMessages(lines)), '1GMFCU16686265143'.slice(0, 17));
});

test('decodeDtcs: CAN with count byte, multi-frame', () => {
  const msgs = assembleMessages(['00A', '0:430401710420', '1:0103C101AAAAAA']);
  assert.deepEqual(decodeDtcs(msgs, 0x43, true), ['P0171', 'P0420', 'P0103', 'U0101']);
});

test('decodeDtcs: legacy padding zeros and no codes', () => {
  assert.deepEqual(decodeDtcs(assembleMessages(['430133000000000']), 0x43, false), []); // odd length -> ignored line
  assert.deepEqual(decodeDtcs(assembleMessages(['430133030000']), 0x43, false), ['P0133', 'P0300']);
  assert.deepEqual(decodeDtcs(assembleMessages(['430000000000']), 0x43, false), []);
});

test('decodeDtcs: CAN with zero codes', () => {
  assert.deepEqual(decodeDtcs(assembleMessages(['4300']), 0x43, true), []);
});

test('decodeSupported reads the bitmap MSB-first', () => {
  const pids = decodeSupported(0x00, [0xbe, 0x1f, 0xa8, 0x13]);
  assert.ok(pids.includes(0x01));
  assert.ok(!pids.includes(0x02));
  assert.ok(pids.includes(0x0c));
  assert.ok(pids.includes(0x20));
});

test('decodeMonitorStatus: MIL on, spark engine, catalyst incomplete', () => {
  const s = decodeMonitorStatus([0x82, 0x07, 0x65, 0x01]);
  assert.equal(s.mil, true);
  assert.equal(s.dtcCount, 2);
  assert.equal(s.diesel, false);
  const cat = s.monitors.find((m) => m.name.includes('المحفّز (الدبّة)'));
  assert.equal(cat.ready, false);
  assert.equal(s.monitors.filter((m) => m.ready).length, s.monitors.length - 1);
});

test('PID decoders', () => {
  assert.equal(decodePid(0x05, [0x7b]), 83);
  assert.equal(decodePid(0x06, [0x80]), 0);
  assert.equal(decodePid(0x10, [0x01, 0xf4]), 5);
  assert.equal(decodePid(0x42, [0x37, 0x6e]), 14.19);
});

test('describeDtc: known, generic group and manufacturer-specific', () => {
  assert.equal(describeDtc('P0420').known, true);
  assert.ok(describeDtc('P0420').guide);
  const g = describeDtc('P0399');
  assert.equal(g.known, false);
  assert.match(g.title, /الإشعال/);
  assert.equal(describeDtc('P1234').manufacturerSpecific, true);
  assert.equal(describeDtc('P2096').generic, true);
  assert.equal(describeDtc('U0100').generic, true);
});

test('end-to-end against simulator: init, VIN, DTCs, clear, live PID', async () => {
  const elm = new Elm327(createSimTransport({ delayMs: 0 }));
  const info = await elm.init();
  assert.equal(elm.isCan, true);
  assert.match(info.protocol, /15765/);
  assert.ok(info.supported.has(0x0c));
  assert.ok(info.supported.has(0x5c), 'should follow the bitmap chain to 0x41-0x60');

  assert.equal(await elm.readVin(), 'JTDBR32E720045631');
  assert.deepEqual(await elm.readDtcs('03'), ['P0171', 'P0420']);
  assert.deepEqual(await elm.readDtcs('07'), ['P0300']);
  assert.deepEqual(await elm.readDtcs('0A'), ['P0420']);

  const status = decodeMonitorStatus(await elm.readPid(0x01));
  assert.equal(status.mil, true);

  assert.equal(await elm.clearDtcs(), true);
  assert.deepEqual(await elm.readDtcs('03'), []);
  assert.deepEqual(await elm.readDtcs('0A'), ['P0420'], 'permanent codes survive a clear');
  const after = decodeMonitorStatus(await elm.readPid(0x01));
  assert.equal(after.mil, false);
  assert.ok(after.monitors.some((m) => !m.ready), 'monitors reset after clear');

  const rpm = decodePid(0x0c, await elm.readPid(0x0c));
  assert.ok(rpm > 500 && rpm < 8000);
  assert.equal(await elm.readPid(0x0a), null, 'unsupported PID -> null');
  const v = await elm.readVoltage();
  assert.ok(v > 11 && v < 15);
  await elm.close();
});

test('commands are serialized even when fired concurrently', async () => {
  const elm = new Elm327(createSimTransport({ delayMs: 2 }));
  await elm.init();
  const [a, b, c] = await Promise.all([elm.readPid(0x05), elm.readPid(0x0d), elm.readPid(0x0c)]);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(c.length, 2);
});

test('timeout rejects and the next command still resyncs', async () => {
  let swallow = true;
  const sim = createSimTransport({ delayMs: 0 });
  const realWrite = sim.write.bind(sim);
  const flaky = {
    set onData(fn) { sim.onData = fn; },
    get onData() { return sim.onData; },
    async write(s) { if (swallow) { swallow = false; return; } return realWrite(s); },
    async close() {},
  };
  const elm = new Elm327(flaky, { timeoutMs: 50 });
  await assert.rejects(elm.send('ATI'), (e) => e instanceof ElmError && e.code === 'TIMEOUT');
  const lines = await elm.send('ATI');
  assert.match(lines.join(''), /ELM327/);
});

test('fuel math', () => {
  const lph = fuelLphFromMaf(10);
  assert.ok(Math.abs(lph - 3.287) < 0.01);
  assert.equal(lPer100(lph, 0), null);
  assert.ok(Math.abs(lPer100(3.287, 100) - 3.287) < 0.01);
});

test('TrimAnalyzer recognises vacuum-leak pattern', () => {
  const a = new TrimAnalyzer();
  for (let i = 0; i < 20; i++) a.add({ rpm: 780, speed: 0, stft: 5, ltft: 12 });
  for (let i = 0; i < 20; i++) a.add({ rpm: 2500, speed: 60, stft: 1, ltft: 3 });
  const v = a.verdict();
  assert.equal(v.level, 'warn');
  assert.match(v.text, /فاكيوم/);
});

test('inspectionVerdict flags recently cleared codes', () => {
  const v = inspectionVerdict({
    status: { mil: false, monitors: [{ name: 'x', ready: false }] },
    distClear: 12, warmups: 2, timeClear: 30, permanentCount: 0,
  });
  assert.equal(v.level, 'warn');
  assert.ok(v.flags.length >= 3);
  assert.equal(inspectionVerdict({ status: { mil: false, monitors: [] }, distClear: 5000, warmups: 200, timeClear: 9000, permanentCount: 0 }).level, 'ok');
});

test('SprintTimer measures 0-100', () => {
  const s = new SprintTimer(100);
  s.update(0, 0);
  s.update(5, 1000);
  s.update(60, 4000);
  s.update(101, 8500);
  assert.equal(s.state, 'done');
  assert.equal(s.result, 7.5);
});

test('TrimAnalyzer does not conclude "lean everywhere" from idle samples alone', () => {
  const a = new TrimAnalyzer();
  for (let i = 0; i < 20; i++) a.add({ rpm: 780, speed: 0, stft: 6, ltft: 12 });
  const v = a.verdict();
  assert.equal(v.level, 'warn');
  assert.match(v.text, /2500/);
  assert.doesNotMatch(v.text, /كل الحالات/);
});

test('decodeMode06: unsigned and signed records, pass/fail on raw values', async () => {
  const { decodeMode06 } = await import('../src/elm327.js');
  const msg = [0x46, 0x21, 0x80, 0x01, 0x04, 0x10, 0x00, 0x00, 0x03, 0x20,
    0x21, 0x81, 0x81, 0xff, 0xf6, 0xff, 0xec, 0x00, 0x0a];
  const r = decodeMode06(msg, 0x21);
  assert.equal(r.length, 2);
  assert.deepEqual([r[0].value, r[0].max, r[0].pass], [0x410, 0x320, false]);
  assert.deepEqual([r[1].value, r[1].min, r[1].max, r[1].pass], [-10, -20, 10, true]);
});

test('freeze frame and mode 06 against simulator', async () => {
  const elm = new Elm327(createSimTransport({ delayMs: 0 }));
  await elm.init();
  const ff = await elm.readFreezeFrame();
  assert.equal(ff.dtc, 'P0171');
  assert.equal(decodePid(0x05, ff.values[0x05]), 88);
  assert.equal(decodePid(0x0c, ff.values[0x0c]), 780);
  const tests = await elm.readMonitorTests();
  assert.equal(tests.length, 7);
  const cat = tests.find((t) => t.mid === 0x21);
  assert.equal(cat.pass, false, 'catalyst test fails, matching P0420');
  assert.ok(tests.filter((t) => t.mid >= 0xa2).every((t) => t.pass));
  await elm.clearDtcs();
  assert.equal(await elm.readFreezeFrame(), null, 'no freeze frame after clear');
});

test('midName', async () => {
  const { midName } = await import('../src/pids.js');
  assert.match(midName(0x21), /المحفّز/);
  assert.match(midName(0xa3), /السلندر 2/);
  assert.match(midName(0x05), /بنك 2، حساس 1/);
});
