// Simulated ELM327 + vehicle (CAN 11-bit 500k). Used for the demo mode and the tests.
// The vehicle tells one consistent story: a small vacuum leak (lean at idle -> P0171),
// a tired catalyst (P0420, also permanent) and a pending random misfire (P0300).

const hex = (n, w = 2) => n.toString(16).toUpperCase().padStart(w, '0');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const SUPPORTED = [0x01, 0x04, 0x05, 0x06, 0x07, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x1f, 0x20, 0x21, 0x2f, 0x30, 0x31, 0x33, 0x40, 0x42, 0x46, 0x4e, 0x5c];

function bitmap(base) {
  const b = [0, 0, 0, 0];
  for (const p of SUPPORTED) {
    if (p > base && p <= base + 0x20) {
      const i = p - base - 1;
      b[i >> 3] |= 0x80 >> (i & 7);
    }
  }
  return b;
}

/** Format a payload the way an ELM327 prints it with ATH0 ATS0 (ISO-TP multi-frame when > 7 bytes). */
function canFormat(bytes) {
  if (bytes.length <= 7) return bytes.map((b) => hex(b)).join('');
  const lines = [hex(bytes.length, 3)];
  let idx = 0;
  lines.push(`${idx++ & 0xf}:` + bytes.slice(0, 6).map((b) => hex(b)).join(''));
  for (let i = 6; i < bytes.length; i += 7) {
    const chunk = bytes.slice(i, i + 7);
    while (chunk.length < 7) chunk.push(0xaa); // padding the ELM shows; trimmed by total length
    lines.push(`${idx++ & 0xf}:` + chunk.map((b) => hex(b)).join(''));
  }
  return lines.join('\r');
}

const dtcBytes = (code) => {
  const sys = 'PCBU'.indexOf(code[0]);
  const v = parseInt(code.slice(1), 16);
  return [(sys << 6) | (v >> 8), v & 0xff];
};

export function createSimTransport({ delayMs = 18, now = () => Date.now() } = {}) {
  const t0 = now();
  const state = {
    echo: true,
    stored: ['P0171', 'P0420'],
    pending: ['P0300'],
    permanent: ['P0420'],
    clearedAt: t0 - 9 * 24 * 3600 * 1000,
    distAtClear: 0,
    odo: 412,
    lastTick: t0,
  };

  // A repeating 60 s drive cycle: idle, accelerate, cruise, brake.
  function vehicle() {
    const t = (now() - t0) / 1000;
    const c = t % 60;
    let speed;
    if (c < 8) speed = 0;
    else if (c < 20) speed = ((c - 8) / 12) * 100;
    else if (c < 45) speed = 100 + 8 * Math.sin(c / 3);
    else speed = Math.max(0, 100 - ((c - 45) / 15) * 100);
    const gear = speed < 1 ? 0 : Math.min(6, 1 + Math.floor(speed / 22));
    const rpm = gear === 0 ? 780 + 25 * Math.sin(t * 2) : 1200 + (speed % 22) * 120 + (c < 20 ? 900 : 0);
    const accel = c >= 8 && c < 20;
    const load = gear === 0 ? 22 : accel ? 78 : 38;
    const idle = gear === 0;
    const coolant = clamp(35 + t * 0.9, 35, 91);
    const dt = (now() - state.lastTick) / 3600000;
    state.lastTick = now();
    state.odo += speed * dt;
    return {
      speed,
      rpm,
      load,
      coolant,
      iat: 34,
      throttle: idle ? 3.5 : accel ? 62 : 21,
      maf: (rpm * load) / 7000, // ~1.6 L engine: ~2.5 g/s idle, ~14 g/s cruise
      map: idle ? 32 : accel ? 92 : 55,
      timing: idle ? 8 : accel ? 18 : 28,
      stft: (idle ? 6 : 1) + 2 * Math.sin(t * 3.1),
      ltft: idle ? 13 : 4,
      oil: clamp(30 + t * 0.7, 30, 102),
      fuel: 63,
      volt: gear === 0 && t < 2 ? 12.4 : 14.2,
      runtime: Math.floor(t),
    };
  }

  function obd(cmd) {
    const mode = cmd.slice(0, 2);
    const pid = parseInt(cmd.slice(2, 4) || '0', 16);
    const v = vehicle();
    const reply = (...data) => canFormat([parseInt(mode, 16) + 0x40, pid, ...data]);
    const u16 = (x) => [(x >> 8) & 0xff, x & 0xff];
    if (mode === '01') {
      if ([0x00, 0x20, 0x40].includes(pid)) return reply(...bitmap(pid));
      if (!SUPPORTED.includes(pid)) return 'NO DATA';
      const sinceClearKm = Math.round(state.odo - state.distAtClear);
      const cleared = state.stored.length === 0;
      switch (pid) {
        case 0x01: {
          const a = (state.stored.length ? 0x80 : 0) | state.stored.length;
          const incomplete = cleared && sinceClearKm < 50;
          return reply(a, 0x07 | (incomplete ? 0x40 : 0), 0x65, incomplete ? 0x65 : 0x00);
        }
        case 0x04: return reply(Math.round((v.load * 255) / 100));
        case 0x05: return reply(Math.round(v.coolant + 40));
        case 0x06: return reply(clamp(Math.round((v.stft * 128) / 100 + 128), 0, 255));
        case 0x07: return reply(clamp(Math.round((v.ltft * 128) / 100 + 128), 0, 255));
        case 0x0b: return reply(Math.round(v.map));
        case 0x0c: return reply(...u16(Math.round(v.rpm * 4)));
        case 0x0d: return reply(Math.round(v.speed));
        case 0x0e: return reply(Math.round((v.timing + 64) * 2));
        case 0x0f: return reply(v.iat + 40);
        case 0x10: return reply(...u16(Math.round(v.maf * 100)));
        case 0x11: return reply(Math.round((v.throttle * 255) / 100));
        case 0x1f: return reply(...u16(v.runtime));
        case 0x21: return reply(...u16(state.stored.length ? 37 : 0));
        case 0x2f: return reply(Math.round((v.fuel * 255) / 100));
        case 0x30: return reply(cleared ? 0 : 41);
        case 0x31: return reply(...u16(sinceClearKm));
        case 0x33: return reply(101);
        case 0x42: return reply(...u16(Math.round(v.volt * 1000)));
        case 0x46: return reply(38 + 40);
        case 0x4e: return reply(...u16(Math.floor((now() - state.clearedAt) / 60000) & 0xffff));
        case 0x5c: return reply(Math.round(v.oil + 40));
        default: return 'NO DATA';
      }
    }
    if (mode === '02') {
      // Freeze frame #0 captured when P0171 was stored: warm engine at idle, lean.
      if (!state.stored.length) return 'NO DATA';
      const ff = { 0x02: dtcBytes('P0171'), 0x04: [56], 0x05: [88 + 40], 0x06: [146], 0x07: [145], 0x0c: [0x0c, 0x30], 0x0d: [0], 0x0f: [36 + 40], 0x11: [9] };
      if (pid === 0x00) {
        const b = [0, 0, 0, 0];
        for (const p of Object.keys(ff).map(Number)) { const i = p - 1; b[i >> 3] |= 0x80 >> (i & 7); }
        return canFormat([0x42, 0x00, 0x00, ...b]);
      }
      return ff[pid] ? canFormat([0x42, pid, 0x00, ...ff[pid]]) : 'NO DATA';
    }
    if (mode === '06') {
      // MIDs 01 (O2 B1S1), 21 (catalyst B1, failing -> P0420), A2..A5 (misfire cyl 1-4).
      const tests = {
        0x01: [[0x01, 0x0a, 0x0190, 0x0100, 0x0300], [0x05, 0x10, 0x0050, 0x0000, 0x0096]],
        0x21: [[0x80, 0x01, 0x0410, 0x0000, 0x0320]],
        0xa2: [[0x0b, 0x24, 0x0000, 0x0000, 0x0014]],
        0xa3: [[0x0b, 0x24, 0x0003, 0x0000, 0x0014]],
        0xa4: [[0x0b, 0x24, 0x0001, 0x0000, 0x0014]],
        0xa5: [[0x0b, 0x24, 0x0000, 0x0000, 0x0014]],
      };
      if (pid % 0x20 === 0) {
        const b = [0, 0, 0, 0];
        for (const m of Object.keys(tests).map(Number)) {
          if (m > pid && m <= pid + 0x20) { const i = m - pid - 1; b[i >> 3] |= 0x80 >> (i & 7); }
        }
        const higher = Object.keys(tests).map(Number).some((m) => m > pid + 0x20);
        if (higher) b[3] |= 0x01; // next range supported
        return canFormat([0x46, pid, ...b]);
      }
      const recs = tests[pid];
      if (!recs) return 'NO DATA';
      const u16 = (x) => [(x >> 8) & 0xff, x & 0xff];
      return canFormat([0x46, ...recs.flatMap(([tid, uas, v, mn, mx]) => [pid, tid, uas, ...u16(v), ...u16(mn), ...u16(mx)])]);
    }
    if (mode === '03' || mode === '07' || mode === '0A') {
      const list = { '03': state.stored, '07': state.pending, '0A': state.permanent }[mode];
      const sid = parseInt(mode, 16) + 0x40;
      return canFormat([sid, list.length, ...list.flatMap(dtcBytes)]);
    }
    if (mode === '04') {
      state.stored = [];
      state.pending = [];
      state.clearedAt = now();
      state.distAtClear = state.odo;
      return '44';
    }
    if (mode === '09' && pid === 0x02) {
      const vin = 'JTDBR32E720045631';
      return canFormat([0x49, 0x02, 0x01, ...[...vin].map((ch) => ch.charCodeAt(0))]);
    }
    return 'NO DATA';
  }

  function at(cmd) {
    const c = cmd.slice(2);
    if (c === 'Z') { state.echo = true; return '\r\rELM327 v1.5'; }
    if (c === 'I') return 'ELM327 v1.5';
    if (c === 'E0') { state.echo = false; return 'OK'; }
    if (c === 'E1') { state.echo = true; return 'OK'; }
    if (c === 'RV') return `${vehicle().volt.toFixed(1)}V`;
    if (c === 'DPN') return 'A6';
    if (c === 'DP') return 'AUTO, ISO 15765-4 (CAN 11/500)';
    if (/^(L[01]|S[01]|H[01]|AT[012]|SP[0-9A-C]|ST[0-9A-F]{2}|D)$/.test(c)) return 'OK';
    return '?';
  }

  function respond(raw) {
    const cmd = raw.replace(/\s+/g, '').toUpperCase();
    if (!cmd) return '';
    if (cmd.startsWith('AT')) return at(cmd);
    if (/^[0-9A-F]+$/.test(cmd)) return obd(cmd);
    return '?';
  }

  let inbox = '';
  const transport = {
    name: 'سيارة تجريبية',
    simulated: true,
    onData: () => {},
    async write(str) {
      inbox += str;
      let i;
      while ((i = inbox.indexOf('\r')) >= 0) {
        const cmd = inbox.slice(0, i);
        inbox = inbox.slice(i + 1);
        const out = (state.echo ? cmd + '\r' : '') + respond(cmd) + '\r\r>';
        const deliver = () => transport.onData(out);
        if (delayMs > 0) setTimeout(deliver, delayMs);
        else queueMicrotask(deliver);
      }
    },
    async close() {},
    _state: state,
  };
  return transport;
}
