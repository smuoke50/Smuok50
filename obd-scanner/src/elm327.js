// ELM327 protocol layer — transport-agnostic.
// A transport exposes: write(string): Promise<void>, onData: (string) => void, close(): Promise<void>.
// The ELM327 is a strictly serial device: one command in flight, response ends with '>'.

export class ElmError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ElmError';
    this.code = code;
  }
}

// Responses that mean "no answer from the vehicle" (not a transport failure).
const NO_DATA = ['NO DATA', 'STOPPED', 'NODATA'];
// Responses that mean the bus or the adapter could not reach the vehicle.
const BUS_ERRORS = [
  'UNABLE TO CONNECT', 'UNABLETOCONNECT', 'CAN ERROR', 'BUS ERROR', 'BUS INIT: ...ERROR',
  'BUSINIT:...ERROR', 'DATA ERROR', 'BUFFER FULL', 'FB ERROR', 'LV RESET', 'ACT ALERT', 'ERR',
];

const CAN_PROTOCOLS = new Set(['6', '7', '8', '9', 'A', 'B', 'C']);

/** Split raw adapter output into meaningful lines, dropping echo and status noise. */
export function cleanLines(raw, cmd = '') {
  const echo = cmd.replace(/\s+/g, '').toUpperCase();
  return raw
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => l.replace(/\s+/g, '').toUpperCase() !== echo)
    .filter((l) => !/^SEARCHING/i.test(l))
    .filter((l) => !/^BUS INIT:?\s*\.*\s*OK$/i.test(l));
}

export function classify(lines) {
  const joined = lines.join(' ').toUpperCase();
  if (lines.length === 0) return 'empty';
  if (lines.length === 1 && lines[0] === '?') return 'unknown-command';
  if (NO_DATA.some((m) => joined.includes(m))) return 'no-data';
  if (BUS_ERRORS.some((m) => joined.includes(m))) return 'bus-error';
  return 'ok';
}

const hexToBytes = (hex) => {
  const out = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
};

/**
 * Turn cleaned lines into messages (byte arrays).
 * Handles ISO-TP multi-frame output as printed by the ELM327 with headers off:
 *   014            <- total byte count (hex)
 *   0:490201314434 <- frame index : payload
 *   1:4750303052...
 * Single-frame lines from one or more ECUs become one message each.
 */
export function assembleMessages(lines) {
  let total = null;
  const frames = [];
  const singles = [];
  for (const line of lines) {
    const l = line.replace(/\s+/g, '').toUpperCase();
    if (/^[0-9A-F]{3}$/.test(l)) { total = parseInt(l, 16); continue; }
    const m = /^([0-9A-F]):([0-9A-F]+)$/.exec(l);
    if (m) { frames.push(m[2]); continue; }
    if (/^[0-9A-F]+$/.test(l) && l.length % 2 === 0) singles.push(hexToBytes(l));
  }
  const messages = [];
  if (frames.length) {
    let bytes = hexToBytes(frames.join(''));
    if (total !== null) bytes = bytes.slice(0, total);
    messages.push(bytes);
  }
  return messages.concat(singles);
}

/** Format two DTC bytes as SAE J2012 code (e.g. 0x01,0x33 -> P0133). */
export function formatDtc(a, b) {
  const system = 'PCBU'[a >> 6];
  return (
    system +
    ((a >> 4) & 0x3).toString(16) +
    (a & 0xf).toString(16) +
    b.toString(16).padStart(2, '0')
  ).toUpperCase();
}

/**
 * Decode a mode 03/07/0A response. respSid is 0x43, 0x47 or 0x4A.
 * CAN responses carry a count byte after the SID; legacy (ISO/KWP/J1850) do not and are padded with zeros.
 */
export function decodeDtcs(messages, respSid, isCan) {
  const codes = new Set();
  for (const msg of messages) {
    if (msg[0] !== respSid) continue;
    let data = msg.slice(1);
    const looksCan = data.length % 2 === 1 && data[0] * 2 <= data.length - 1;
    if (isCan === true || (isCan == null && looksCan)) {
      const count = data[0];
      data = data.slice(1, 1 + count * 2);
    }
    for (let i = 0; i + 1 < data.length; i += 2) {
      if (data[i] === 0 && data[i + 1] === 0) continue;
      codes.add(formatDtc(data[i], data[i + 1]));
    }
  }
  return [...codes];
}

/** Decode VIN from mode 09 PID 02 (CAN single message, or legacy 4-byte chunks with sequence numbers). */
export function decodeVin(messages) {
  const parts = messages.filter((m) => m[0] === 0x49 && m[1] === 0x02);
  if (!parts.length) return null;
  let bytes;
  if (parts.length === 1 && parts[0].length >= 20) {
    bytes = parts[0].slice(3);
  } else {
    bytes = parts
      .slice()
      .sort((a, b) => a[2] - b[2])
      .flatMap((m) => m.slice(3));
  }
  const vin = String.fromCharCode(...bytes.filter((b) => b >= 0x30 && b <= 0x5a));
  return vin.length >= 17 ? vin.slice(-17) : vin || null;
}

/** Parse a supported-PIDs bitmap (4 bytes) for base PID (0x00, 0x20, ...). */
export function decodeSupported(base, data) {
  const out = [];
  for (let i = 0; i < 32; i++) {
    if (data[i >> 3] & (0x80 >> (i & 7))) out.push(base + i + 1);
  }
  return out;
}

export class Elm327 {
  constructor(transport, { timeoutMs = 4000, onLog = null } = {}) {
    this.t = transport;
    this.timeoutMs = timeoutMs;
    this.onLog = onLog;
    this.buf = '';
    this.pending = null;
    this.chain = Promise.resolve();
    this.stale = false;
    this.isCan = null;
    this.protocol = null;
    this.version = null;
    this.supported = new Set();
    this.closed = false;
    transport.onData = (chunk) => this._onData(chunk);
  }

  _onData(chunk) {
    this.buf += chunk;
    const i = this.buf.indexOf('>');
    if (i < 0) return;
    const raw = this.buf.slice(0, i);
    this.buf = this.buf.slice(i + 1);
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      clearTimeout(p.timer);
      p.resolve(raw);
    }
  }

  _exchange(cmd, timeoutMs) {
    return new Promise((resolve, reject) => {
      this.buf = '';
      const timer = setTimeout(() => {
        if (this.pending && this.pending.timer === timer) {
          this.pending = null;
          this.stale = true; // a late '>' may still arrive; resync before the next command
          reject(new ElmError('TIMEOUT', `انتهت مهلة الأمر ${cmd}`));
        }
      }, timeoutMs);
      this.pending = { resolve, reject, timer };
      this.t.write(cmd + '\r').catch((err) => {
        clearTimeout(timer);
        this.pending = null;
        reject(new ElmError('TRANSPORT', err?.message || 'فشل الإرسال'));
      });
    });
  }

  /** Send a raw command; returns cleaned lines. Serialized: callers never interleave. */
  send(cmd, timeoutMs = this.timeoutMs) {
    const run = async () => {
      if (this.closed) throw new ElmError('CLOSED', 'الاتصال مغلق');
      if (this.stale) {
        this.stale = false;
        // ATI is harmless; a bare CR would repeat the previous command.
        await this._exchange('ATI', 1500).catch(() => {});
      }
      const raw = await this._exchange(cmd, timeoutMs);
      const lines = cleanLines(raw, cmd);
      this.onLog?.(cmd, lines);
      return lines;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async init() {
    // ATZ resets the chip and may take ~1s; some clones answer slowly.
    await this.send('ATZ', 5000).catch(() => {});
    for (const c of ['ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATAT1', 'ATSP0']) {
      const lines = await this.send(c, 2000);
      if (classify(lines) === 'unknown-command' && c !== 'ATAT1') {
        throw new ElmError('NOT_ELM', `المحوّل لم يقبل ${c}`);
      }
    }
    this.version = (await this.send('ATI').catch(() => ['']))[0] || 'ELM327';
    // First OBD request triggers protocol search: allow a long timeout.
    const first = await this.send('0100', 15000);
    const kind = classify(first);
    if (kind === 'bus-error' || kind === 'no-data') {
      throw new ElmError('NO_ECU', 'تعذّر الوصول إلى كمبيوتر السيارة. تأكد أن المفتاح على وضع التشغيل.');
    }
    await this._readProtocol();
    this.supported = await this._readSupported(first);
    return { version: this.version, protocol: this.protocol, supported: this.supported };
  }

  async _readProtocol() {
    const dpn = (await this.send('ATDPN').catch(() => ['']))[0] || '';
    const n = dpn.replace(/^A/i, '').trim().toUpperCase();
    this.isCan = CAN_PROTOCOLS.has(n);
    const dp = (await this.send('ATDP').catch(() => ['']))[0] || '';
    this.protocol = dp.replace(/^AUTO,\s*/i, '') || `#${n}`;
  }

  async _readSupported(firstLines) {
    const set = new Set();
    let lines = firstLines;
    for (let base = 0x00; base <= 0xc0; base += 0x20) {
      if (base > 0) lines = await this.send('01' + base.toString(16).padStart(2, '0').toUpperCase());
      const data = this._pickData(assembleMessages(lines), 0x41, base);
      if (!data || data.length < 4) break;
      decodeSupported(base, data).forEach((p) => set.add(p));
      if (!set.has(base + 0x20)) break;
    }
    return set;
  }

  _pickData(messages, sid, pid) {
    // Several ECUs may answer; prefer the first that responds to this exact PID.
    const msg = messages.find((m) => m[0] === sid && m[1] === pid);
    return msg ? msg.slice(2) : null;
  }

  /** Mode 01 request. Returns data bytes after SID+PID, or null when unsupported/no data. */
  async readPid(pid) {
    const cmd = '01' + pid.toString(16).padStart(2, '0').toUpperCase();
    const lines = await this.send(cmd);
    const kind = classify(lines);
    if (kind === 'bus-error') throw new ElmError('BUS', lines.join(' '));
    if (kind !== 'ok') return null;
    return this._pickData(assembleMessages(lines), 0x41, pid);
  }

  async readVoltage() {
    const line = (await this.send('ATRV'))[0] || '';
    const v = parseFloat(line.replace(/[^\d.]/g, ''));
    return Number.isFinite(v) ? v : null;
  }

  async readVin() {
    const lines = await this.send('0902', 6000);
    if (classify(lines) !== 'ok') return null;
    return decodeVin(assembleMessages(lines));
  }

  async readDtcs(mode) {
    const sid = { '03': 0x43, '07': 0x47, '0A': 0x4a }[mode];
    const lines = await this.send(mode, 8000);
    const kind = classify(lines);
    if (kind === 'no-data') return [];
    if (kind !== 'ok') throw new ElmError('DTC', `فشل قراءة الأعطال (${lines.join(' ')})`);
    return decodeDtcs(assembleMessages(lines), sid, this.isCan);
  }

  async clearDtcs() {
    const lines = await this.send('04', 8000);
    const ok = assembleMessages(lines).some((m) => m[0] === 0x44);
    if (!ok) throw new ElmError('CLEAR', 'السيارة رفضت المسح. أطفئ المحرك واترك المفتاح على وضع التشغيل.');
    return true;
  }

  async close() {
    this.closed = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new ElmError('CLOSED', 'الاتصال مغلق'));
      this.pending = null;
    }
    await this.t.close?.();
  }
}
