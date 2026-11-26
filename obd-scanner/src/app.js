import { Elm327 } from './elm327.js';
import { connectBle, bleSupported } from './transport-ble.js';
import { createSimTransport } from './transport-sim.js';
import { PIDS, LIVE_PIDS, DEFAULT_LIVE, decodePid, decodeMonitorStatus } from './pids.js';
import { describeDtc } from './dtc-db.js';
import { TrimAnalyzer, fuelLphFromMaf, lPer100, inspectionVerdict, SprintTimer } from './analysis.js';

// ---------- tiny DOM helpers (text only; never innerHTML with data) ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = {
  get(k, d) { try { const v = localStorage.getItem('fahis:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('fahis:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// ---------- state ----------
const state = {
  tab: 'home',
  conn: 'off', // off | connecting | on
  elm: null,
  transport: null,
  info: null,
  vin: null,
  volt: null,
  status: null,
  dtcs: null, // { stored, pending, permanent }
  busy: null, // label of running operation
  live: {},
  selected: store.get('live', DEFAULT_LIVE),
  polling: false,
  hz: 0,
  recording: false,
  log: [],
  trims: new TrimAnalyzer(),
  trip: newTrip(),
  sprint: new SprintTimer(100),
  fuelPrice: store.get('fuelPrice', null),
  inspection: null,
};
function newTrip() { return { dist: 0, fuel: 0, startT: null, lastT: null }; }

const view = document.getElementById('view');
const pill = document.getElementById('conn-pill');
let liveEls = {};
let wakeLock = null;
let pollGen = 0;

// ---------- UI primitives ----------
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3800);
}

function confirmDialog(title, bodyNodes, okLabel = 'تأكيد') {
  const dlg = document.getElementById('confirm');
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-body').replaceChildren(...bodyNodes);
  document.getElementById('confirm-ok').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

function setPill() {
  const map = { off: ['غير متصل', 'pill-off'], connecting: ['جارِ الاتصال…', 'pill-busy'], on: [state.transport?.name || 'متصل', 'pill-on'] };
  const [text, cls] = map[state.conn];
  pill.textContent = text;
  pill.className = 'pill ' + cls;
}

async function run(label, fn) {
  if (state.busy) return;
  state.busy = label;
  render();
  try { await fn(); }
  catch (e) {
    toast(e?.message || 'حدث خطأ غير متوقع');
    if (e?.code === 'CLOSED' || e?.code === 'TRANSPORT') await disconnect(true);
  }
  finally { state.busy = null; render(); }
}

const requireConn = () => {
  if (state.conn === 'on') return null;
  return h('div', { class: 'card' },
    h('p', {}, 'اتصل بالمحوّل أولاً من الصفحة الرئيسية، أو جرّب السيارة التجريبية.'),
    h('button', { class: 'btn btn-primary', onclick: () => go('home') }, 'إلى الاتصال'));
};

const busyBtn = (label, busyLabel, onclick, cls = 'btn btn-primary') =>
  h('button', { class: cls, disabled: !!state.busy, onclick },
    state.busy === busyLabel ? [h('span', { class: 'spinner' }), ' ', busyLabel] : label);

// ---------- connection ----------
async function connect(kind) {
  if (state.conn !== 'off') return;
  state.conn = 'connecting';
  setPill();
  render();
  try {
    const transport = kind === 'sim'
      ? createSimTransport()
      : await connectBle({ onDisconnect: () => { if (state.conn === 'on') { toast('انقطع الاتصال بالمحوّل.'); disconnect(true); } } });
    state.transport = transport;
    state.elm = new Elm327(transport);
    state.info = await state.elm.init();
    state.conn = 'on';
    setPill();
    render();
    state.volt = await state.elm.readVoltage().catch(() => null);
    state.vin = await state.elm.readVin().catch(() => null);
    const st = await state.elm.readPid(0x01).catch(() => null);
    state.status = st ? decodeMonitorStatus(st) : null;
    toast(kind === 'sim' ? 'أنت الآن على سيارة تجريبية.' : 'تم الاتصال بالسيارة.');
  } catch (e) {
    if (e?.name !== 'NotFoundError') toast(e?.message || 'فشل الاتصال');
    await disconnect(true);
  } finally {
    setPill();
    render();
  }
}

async function disconnect(silent = false) {
  stopPolling();
  const elm = state.elm;
  Object.assign(state, { elm: null, transport: null, info: null, vin: null, volt: null, status: null, dtcs: null, inspection: null, conn: 'off', live: {} });
  state.trims.reset();
  try { await elm?.close(); } catch { /* ignore */ }
  setPill();
  render();
  if (!silent) toast('تم قطع الاتصال.');
}

// ---------- operations ----------
async function scanDtcs() {
  await run('جارِ الفحص…', async () => {
    const elm = state.elm;
    const stored = await elm.readDtcs('03');
    const pending = await elm.readDtcs('07').catch(() => []);
    const permanent = await elm.readDtcs('0A').catch(() => []);
    const st = await elm.readPid(0x01).catch(() => null);
    if (st) state.status = decodeMonitorStatus(st);
    state.dtcs = { stored, pending, permanent, at: new Date() };
    const n = stored.length + pending.length;
    toast(n ? `وُجد ${n} عطل.` : 'لا توجد أعطال مخزّنة.');
  });
}

async function clearDtcs() {
  const ok = await confirmDialog('مسح الأعطال؟', [
    h('p', {}, 'قبل المسح:'),
    h('ul', {},
      h('li', {}, 'أطفئ المحرك واترك المفتاح على وضع التشغيل.'),
      h('li', {}, 'المسح لا يُصلح العطل: إذا بقي السبب سيعود الرمز.'),
      h('li', {}, 'تُصفَّر أنظمة المراقبة، وقد ترسب السيارة في الفحص الدوري حتى تُكمِل دورات القيادة.')),
  ], 'امسح');
  if (!ok) return;
  await run('جارِ المسح…', async () => {
    await state.elm.clearDtcs();
    toast('تم مسح الأعطال.');
  });
  if (state.conn === 'on') await scanDtcs();
}

async function runInspection() {
  await run('جارِ الفحص…', async () => {
    const elm = state.elm;
    const read = async (pid) => decodePid(pid, await elm.readPid(pid).catch(() => null));
    const st = await elm.readPid(0x01);
    state.status = st ? decodeMonitorStatus(st) : null;
    const permanent = await elm.readDtcs('0A').catch(() => []);
    const data = {
      status: state.status,
      distMil: await read(0x21),
      warmups: await read(0x30),
      distClear: await read(0x31),
      timeClear: await read(0x4e),
      permanent,
      permanentCount: permanent.length,
    };
    state.inspection = { ...data, verdict: inspectionVerdict(data) };
  });
}

// ---------- polling ----------
function neededPids() {
  const sup = state.info?.supported || new Set();
  let list = [];
  if (state.tab === 'live') list = [...state.selected, 0x06, 0x07, 0x0c, 0x0d];
  else if (state.tab === 'trip') list = [0x0d, 0x0c, sup.has(0x5e) ? 0x5e : 0x10];
  return [...new Set(list)].filter((p) => sup.has(p));
}

async function startPolling() {
  if (state.polling || state.conn !== 'on') return;
  state.polling = true;
  const gen = ++pollGen;
  const alive = () => state.polling && state.elm && gen === pollGen;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
  let cycles = 0;
  let windowStart = performance.now();
  while (alive()) {
    const pids = neededPids();
    if (!pids.length || state.busy) { await sleep(250); continue; }
    for (const pid of pids) {
      if (!alive()) break;
      try {
        const v = decodePid(pid, await state.elm.readPid(pid));
        if (v != null) state.live[pid] = v;
      } catch (e) {
        if (e?.code === 'CLOSED' || e?.code === 'TRANSPORT') { toast('انقطع الاتصال.'); await disconnect(true); return; }
      }
    }
    if (!alive()) break;
    onSample(performance.now());
    cycles++;
    const span = performance.now() - windowStart;
    if (span > 2000) { state.hz = (cycles * 1000) / span; cycles = 0; windowStart = performance.now(); }
  }
}

function stopPolling() {
  state.polling = false;
  pollGen++;
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
}

function currentLph() {
  if (Number.isFinite(state.live[0x5e])) return state.live[0x5e];
  return fuelLphFromMaf(state.live[0x10]);
}

function onSample(t) {
  const L = state.live;
  state.trims.add({ rpm: L[0x0c], speed: L[0x0d], stft: L[0x06], ltft: L[0x07] });
  if (state.tab === 'trip') {
    const trip = state.trip;
    if (trip.startT == null) trip.startT = t;
    if (trip.lastT != null) {
      const dtH = Math.min(t - trip.lastT, 5000) / 3600000; // cap gaps (e.g. app in background)
      trip.dist += (L[0x0d] || 0) * dtH;
      const lph = currentLph();
      if (Number.isFinite(lph)) trip.fuel += lph * dtH;
    }
    trip.lastT = t;
    state.sprint.update(L[0x0d], t);
  }
  if (state.recording) {
    if (state.log.length >= 36000) { state.recording = false; toast('امتلأ السجل (36 ألف صف). صدّره ثم ابدأ من جديد.'); }
    else state.log.push({ t: Date.now(), ...Object.fromEntries(Object.entries(L).map(([k, v]) => [PIDS[k]?.key || k, v])) });
  }
  updateLive();
}

// ---------- CSV ----------
function exportCsv() {
  if (!state.log.length) return toast('السجل فارغ.');
  const keys = [...new Set(state.log.flatMap((r) => Object.keys(r)))];
  const esc = (v) => (v == null ? '' : typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(3)) : `"${String(v).replace(/"/g, '""')}"`);
  const rows = [keys.join(','), ...state.log.map((r) => keys.map((k) => (k === 't' ? new Date(r.t).toISOString() : esc(r[k]))).join(','))];
  const blob = new Blob(['﻿' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `fahis-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------- views ----------
function homeView() {
  if (state.conn !== 'on') {
    const ble = bleSupported();
    return [
      h('section', { class: 'hero' },
        h('img', { class: 'logo', src: 'icons/icon.svg', alt: '' }),
        h('h1', {}, 'افحص سيارتك بنفسك'),
        h('p', { class: 'muted' }, 'اقرأ رموز الأعطال وافهمها، وامسحها، وتابع حرارة المحرك واستهلاك الوقود مباشرة، وافحص أي سيارة مستعملة قبل شرائها.')),
      h('div', { class: 'card stack' },
        h('button', { class: 'btn btn-primary btn-block', disabled: !ble || state.conn === 'connecting', onclick: () => connect('ble') },
          state.conn === 'connecting' ? [h('span', { class: 'spinner' }), ' جارِ الاتصال…'] : 'اتصل بمحوّل OBD2 (بلوتوث)'),
        h('button', { class: 'btn btn-block', disabled: state.conn === 'connecting', onclick: () => connect('sim') }, 'جرّب على سيارة تجريبية'),
        !ble && h('p', { class: 'notice' }, 'هذا المتصفح لا يدعم البلوتوث من الويب. على أندرويد استخدم Chrome، وعلى آيفون استخدم متصفحاً يدعم Web Bluetooth مثل Bluefy.')),
      h('div', { class: 'card' },
        h('h2', {}, 'قبل أن تبدأ'),
        h('ol', { class: 'small' },
          h('li', {}, 'ركّب محوّل ELM327 من نوع BLE (بلوتوث منخفض الطاقة) في منفذ OBD2 تحت الطبلون.'),
          h('li', {}, 'شغّل المحرك أو اجعل المفتاح على وضع التشغيل.'),
          h('li', {}, 'لا تقرنه من إعدادات الجوال: اضغط "اتصل" واختره من القائمة.')),
        h('p', { class: 'small muted' }, 'المحوّلات التي تعمل بالبلوتوث الكلاسيكي فقط (SPP) لا يمكن الوصول إليها من المتصفح. يعمل مع السيارات البنزين من 2001 تقريباً والديزل من 2004.')),
    ];
  }
  const st = state.status;
  return [
    h('div', { class: `card ${st?.mil ? 'tone-bad' : 'tone-ok'}` },
      h('div', { class: 'row spread' },
        h('h2', {}, st?.mil ? 'لمبة فحص المحرك مضاءة' : 'لمبة فحص المحرك مطفأة'),
        st && h('span', { class: `badge ${st.dtcCount ? 'bad' : 'ok'}` }, `${st.dtcCount} عطل مؤكَّد`)),
      h('p', { class: 'muted small' }, st?.mil ? 'افحص الأعطال لمعرفة السبب.' : 'يُنصح بفحص الأعطال المعلّقة أيضاً.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-primary', onclick: () => { go('faults'); scanDtcs(); } }, 'افحص الأعطال'),
        h('button', { class: 'btn', onclick: () => go('live') }, 'البيانات المباشرة'))),
    h('div', { class: 'card' },
      h('h2', {}, 'السيارة'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'رقم الهيكل'), h('dd', { class: 'num' }, state.vin || 'غير متاح'),
        h('dt', {}, 'البروتوكول'), h('dd', {}, state.info?.protocol || '—'),
        h('dt', {}, 'المحوّل'), h('dd', {}, `${state.transport?.name || ''} · ${state.info?.version || ''}`),
        h('dt', {}, 'جهد البطارية'), h('dd', { class: 'num' }, state.volt ? `${fmt(state.volt, 1)} V` : '—'),
        h('dt', {}, 'البيانات المدعومة'), h('dd', {}, `${state.info?.supported?.size || 0} قراءة`)),
      state.volt && h('p', { class: 'small muted' }, batteryHint(state.volt))),
    h('button', { class: 'btn btn-ghost btn-block', onclick: () => disconnect() }, 'قطع الاتصال'),
  ];
}

function batteryHint(v) {
  if (v >= 13.4) return 'الدينمو يشحن بشكل طبيعي.';
  if (v >= 12.4) return 'البطارية جيدة (المحرك متوقف).';
  if (v >= 12.0) return 'البطارية متوسطة الشحن.';
  return 'البطارية ضعيفة: قد تواجه صعوبة في التشغيل.';
}

function dtcItem(code, kind) {
  const d = describeDtc(code);
  const g = d.guide;
  return h('details', { class: 'dtc' },
    h('summary', {}, h('span', { class: 'code' }, d.code), h('span', {}, d.title)),
    h('div', { class: 'body small' },
      h('p', {},
        h('span', { class: 'badge' }, d.system), ' ',
        h('span', { class: 'badge' }, d.generic ? 'رمز قياسي' : 'خاص بالشركة المصنّعة'), ' ',
        h('span', { class: `badge ${kind === 'stored' ? 'bad' : 'warn'}` }, { stored: 'مؤكَّد', pending: 'معلّق', permanent: 'دائم' }[kind])),
      g ? [
        h('p', {}, h('strong', {}, 'الخطورة: '), g.urgency),
        h('strong', {}, 'الأسباب المحتملة'), h('ul', {}, g.causes.map((c) => h('li', {}, c))),
        h('strong', {}, 'ابدأ بـ'), h('ul', {}, g.checks.map((c) => h('li', {}, c))),
      ] : h('p', { class: 'muted' }, d.manufacturerSpecific
        ? 'هذا رمز خاص بالشركة المصنّعة؛ معناه الدقيق يختلف حسب الماركة. راجع الوكالة أو دليل الصيانة.'
        : 'لا يوجد دليل تفصيلي لهذا الرمز بعد. ابدأ بفحص الفيش والأسلاك للمكوّن المذكور.'),
      kind === 'pending' && h('p', { class: 'muted' }, 'العطل المعلّق اكتُشف مرة واحدة ولم يُشعل اللمبة بعد. إذا تكرر يصبح مؤكَّداً.'),
      kind === 'permanent' && h('p', { class: 'muted' }, 'العطل الدائم لا يُمسح بالجهاز: يزول تلقائياً بعد إصلاح السبب وقيادة السيارة.')));
}

function faultsView() {
  const gate = requireConn();
  if (gate) return [h('h1', {}, 'الأعطال'), gate];
  const r = state.dtcs;
  const group = (title, list, kind) => list?.length
    ? h('div', { class: 'card' }, h('h2', {}, `${title} (${list.length})`), list.map((c) => dtcItem(c, kind)))
    : null;
  return [
    h('h1', {}, 'الأعطال'),
    h('div', { class: 'card' },
      h('div', { class: 'row' },
        busyBtn(r ? 'أعد الفحص' : 'افحص الآن', 'جارِ الفحص…', scanDtcs),
        r && (r.stored.length || r.pending.length) ? busyBtn('امسح الأعطال', 'جارِ المسح…', clearDtcs, 'btn btn-danger') : null),
      h('p', { class: 'small muted' }, 'يفحص كمبيوتر المحرك والقير (الأعطال القياسية). وحدات ABS والوسائد والهيكل تحتاج بروتوكولات خاصة بكل شركة.'),
      r && h('p', { class: 'small muted' }, `آخر فحص: ${r.at.toLocaleTimeString('ar-SA')}`)),
    r && !r.stored.length && !r.pending.length && !r.permanent.length
      ? h('div', { class: 'card tone-ok' }, h('h2', {}, 'لا توجد أعطال'), h('p', { class: 'muted' }, 'لم يسجّل كمبيوتر المحرك أي رمز.'))
      : null,
    group('أعطال مؤكَّدة', r?.stored, 'stored'),
    group('أعطال معلّقة', r?.pending, 'pending'),
    group('أعطال دائمة', r?.permanent, 'permanent'),
  ];
}

function gauge(pid, big = false) {
  const def = PIDS[pid];
  const val = h('span', { class: 'val' }, '—');
  const bar = h('i');
  const el = h('div', { class: 'gauge' + (big ? ' big' : '') },
    h('div', { class: 'label' }, def.name),
    h('div', {}, val, h('span', { class: 'unit' }, def.unit)),
    h('div', { class: 'bar' }, bar));
  liveEls[pid] = { el, val, bar, def };
  return el;
}

function liveView() {
  const gate = requireConn();
  if (gate) return [h('h1', {}, 'البيانات المباشرة'), gate];
  const sup = state.info.supported;
  const available = LIVE_PIDS.filter((p) => sup.has(p));
  const shown = state.selected.filter((p) => sup.has(p));
  const editing = state.editingGauges;
  const analysis = h('p', { id: 'trim-text', class: 'small' }, state.trims.verdict().text);
  liveEls = { analysis };
  return [
    h('div', { class: 'row spread' },
      h('h1', {}, 'البيانات المباشرة'),
      h('span', { id: 'hz', class: 'muted small num' }, `${fmt(state.hz, 1)} Hz`)),
    h('div', { class: 'row', style: null },
      h('button', { class: 'btn', onclick: () => { state.editingGauges = !editing; render(); } }, editing ? 'تم' : 'تخصيص'),
      h('button', { class: `btn ${state.recording ? 'btn-danger' : ''}`, onclick: () => { state.recording = !state.recording; if (state.recording) state.log = []; render(); } },
        state.recording ? `إيقاف التسجيل` : 'سجّل'),
      h('button', { class: 'btn', disabled: !state.log.length, onclick: exportCsv }, `تصدير CSV (${state.log.length})`)),
    editing && h('div', { class: 'card' },
      h('p', { class: 'small muted' }, 'اختر القراءات المعروضة. كل قراءة إضافية تُبطئ التحديث قليلاً.'),
      h('div', { class: 'chips' }, available.map((p) => h('button', {
        class: 'chip', 'aria-pressed': String(state.selected.includes(p)),
        onclick: () => {
          state.selected = state.selected.includes(p) ? state.selected.filter((x) => x !== p) : [...state.selected, p];
          store.set('live', state.selected);
          render();
        },
      }, PIDS[p].name)))),
    h('div', { class: 'gauges', style: null }, shown.map((p, i) => gauge(p, i < 2 && (p === 0x0c || p === 0x0d)))),
    !shown.length && h('p', { class: 'muted' }, 'لم تختر أي قراءة.'),
    (sup.has(0x06) && sup.has(0x07)) && h('div', { class: 'card', style: null },
      h('h2', {}, 'تحليل خليط الوقود'),
      analysis,
      h('p', { class: 'small muted' }, 'يقارن تصحيح الوقود في السلانسيه وتحت الحِمل لتمييز تسريب الفاكيوم عن ضعف ضخ الوقود.'),
      h('button', { class: 'btn btn-ghost', onclick: () => { state.trims.reset(); updateLive(); } }, 'ابدأ التحليل من جديد')),
  ];
}

function tripView() {
  const gate = requireConn();
  if (gate) return [h('h1', {}, 'الرحلة'), gate];
  const sup = state.info.supported;
  const canFuel = sup.has(0x5e) || sup.has(0x10);
  const priceInput = h('input', {
    type: 'number', inputmode: 'decimal', step: '0.01', min: '0', placeholder: 'سعر اللتر',
    value: state.fuelPrice ?? '', 'aria-label': 'سعر لتر الوقود',
    oninput: (e) => { const v = parseFloat(e.target.value); state.fuelPrice = Number.isFinite(v) && v > 0 ? v : null; store.set('fuelPrice', state.fuelPrice); updateLive(); },
  });
  const stat = (id, label) => h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value num', id }, '—'));
  return [
    h('h1', {}, 'كمبيوتر الرحلة'),
    !canFuel && h('p', { class: 'notice' }, 'هذه السيارة لا تُرسل تدفق الهواء ولا معدل الوقود؛ الاستهلاك غير متاح.'),
    h('div', { class: 'stat-grid' },
      stat('t-speed', 'السرعة (كم/س)'),
      stat('t-inst', 'الاستهلاك اللحظي (ل/100كم)'),
      stat('t-avg', 'متوسط الاستهلاك (ل/100كم)'),
      stat('t-dist', 'المسافة (كم)'),
      stat('t-fuel', 'الوقود المستهلك (لتر)'),
      stat('t-time', 'مدة الرحلة'),
      stat('t-cost', 'تكلفة الرحلة')),
    h('div', { class: 'card row' }, h('label', {}, 'سعر لتر الوقود: '), priceInput,
      h('button', { class: 'btn btn-ghost', onclick: () => { state.trip = newTrip(); updateLive(); } }, 'رحلة جديدة')),
    h('div', { class: 'card' },
      h('h2', {}, 'مؤقّت 0–100 كم/س'),
      h('p', { class: 'value num', id: 't-sprint' }, '—'),
      h('p', { class: 'small muted' }, 'يبدأ تلقائياً عند التحرك من الوقوف. للاستخدام في مضمار مغلق فقط. الدقة محدودة بسرعة المحوّل.'),
      h('button', { class: 'btn', onclick: () => { state.sprint.reset(); updateLive(); } }, 'إعادة')),
    h('p', { class: 'small muted' }, canFuel && !sup.has(0x5e) ? 'الاستهلاك محسوب من حساس الهواء MAF بافتراض محرك بنزين؛ القيمة تقريبية.' : ''),
  ];
}

function inspectView() {
  const gate = requireConn();
  if (gate) return [h('h1', {}, 'فحص قبل الشراء'), gate];
  const r = state.inspection;
  const v = r?.verdict;
  const tone = v ? { ok: 'tone-ok', warn: 'tone-warn', bad: 'tone-bad' }[v.level] : '';
  return [
    h('h1', {}, 'فحص قبل الشراء'),
    h('div', { class: 'card' },
      h('p', { class: 'small muted' }, 'يكشف إن كانت الأعطال قد مُسحت مؤخراً لإخفائها: يقرأ جاهزية أنظمة المراقبة والمسافة والوقت منذ آخر مسح والأعطال الدائمة.'),
      busyBtn(r ? 'أعد الفحص' : 'ابدأ الفحص', 'جارِ الفحص…', runInspection)),
    v && h('div', { class: `card ${tone}` },
      h('h2', {}, { ok: 'السجل سليم', warn: 'تحتاج انتباهاً', bad: 'توجد مشاكل' }[v.level]),
      h('p', {}, v.summary),
      v.flags.length ? h('ul', { class: 'small' }, v.flags.map((f) => h('li', {}, f.text))) : null),
    r && h('div', { class: 'card' },
      h('h2', {}, 'العدّادات منذ آخر مسح'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'المسافة'), h('dd', { class: 'num' }, r.distClear != null ? `${r.distClear} km` : 'غير مدعوم'),
        h('dt', {}, 'دورات الإحماء'), h('dd', { class: 'num' }, r.warmups ?? 'غير مدعوم'),
        h('dt', {}, 'زمن التشغيل'), h('dd', { class: 'num' }, r.timeClear != null ? `${Math.floor(r.timeClear / 60)}h ${r.timeClear % 60}m` : 'غير مدعوم'),
        h('dt', {}, 'مسافة مع اللمبة مضاءة'), h('dd', { class: 'num' }, r.distMil != null ? `${r.distMil} km` : 'غير مدعوم'),
        h('dt', {}, 'أعطال دائمة'), h('dd', { class: 'num' }, r.permanent.join('، ') || 'لا يوجد'))),
    r?.status && h('div', { class: 'card' },
      h('h2', {}, `أنظمة المراقبة (${r.status.diesel ? 'ديزل' : 'بنزين'})`),
      r.status.monitors.map((m) => h('div', { class: 'monitor' }, h('span', {}, m.name),
        h('span', { class: `badge ${m.ready ? 'ok' : 'warn'}` }, m.ready ? 'جاهز' : 'غير مكتمل')))),
  ];
}

// ---------- live DOM updates (no re-render) ----------
function updateLive() {
  if (state.tab === 'live') {
    for (const [pid, ref] of Object.entries(liveEls)) {
      if (!ref?.def) continue;
      const v = state.live[pid];
      const d = ref.def;
      ref.val.textContent = Number.isFinite(v) ? fmt(v, Math.abs(d.max) <= 25 || d.unit === 'V' ? 1 : 0) : '—';
      const pct = Number.isFinite(v) ? Math.max(0, Math.min(100, ((v - d.min) / (d.max - d.min)) * 100)) : 0;
      ref.bar.style.width = pct + '%';
      ref.el.classList.toggle('hot', d.warn != null && v >= d.warn);
    }
    if (liveEls.analysis) liveEls.analysis.textContent = state.trims.verdict().text;
    const hz = document.getElementById('hz');
    if (hz) hz.textContent = `${fmt(state.hz, 1)} Hz`;
  } else if (state.tab === 'trip') {
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    const { trip, live } = state;
    const lph = currentLph();
    set('t-speed', fmt(live[0x0d]));
    const inst = lPer100(lph, live[0x0d]);
    set('t-inst', inst != null ? fmt(inst, 1) : Number.isFinite(lph) ? `${fmt(lph, 1)} ل/س` : '—');
    set('t-avg', trip.dist > 0.1 ? fmt((trip.fuel / trip.dist) * 100, 1) : '—');
    set('t-dist', fmt(trip.dist, 2));
    set('t-fuel', fmt(trip.fuel, 2));
    const secs = trip.startT != null && trip.lastT != null ? Math.round((trip.lastT - trip.startT) / 1000) : 0;
    set('t-time', `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`);
    set('t-cost', state.fuelPrice ? fmt(trip.fuel * state.fuelPrice, 2) : 'أدخل السعر');
    const s = state.sprint;
    set('t-sprint', s.state === 'done' ? `${fmt(s.result, 2)} s` : s.state === 'running' ? 'جارِ القياس…' : 'جاهز — توقّف تماماً ثم انطلق');
  }
}

// ---------- routing ----------
function render() {
  const views = { home: homeView, faults: faultsView, live: liveView, trip: tripView, inspect: inspectView };
  liveEls = {};
  view.replaceChildren(...[views[state.tab]()].flat(Infinity).filter(Boolean));
  updateLive();
  const wantPoll = state.conn === 'on' && (state.tab === 'live' || state.tab === 'trip') && !document.hidden;
  if (wantPoll) startPolling();
  else stopPolling();
}

function go(tab) {
  if (state.tab === tab) return;
  state.tab = tab;
  if (tab === 'trip') state.trip.lastT = null; // don't integrate the time spent elsewhere
  document.querySelectorAll('.tabbar button').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  render();
  view.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling();
  else render();
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is best-effort */ });
}

setPill();
render();
