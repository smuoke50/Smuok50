// Pure analysis helpers: no DOM, no I/O.

const GASOLINE_AFR = 14.7;
const GASOLINE_DENSITY_G_PER_L = 745;

/** Litres per hour from MAF (g/s) for a gasoline engine at stoichiometric mixture. */
export function fuelLphFromMaf(maf) {
  if (!Number.isFinite(maf) || maf < 0) return null;
  return (maf * 3600) / (GASOLINE_AFR * GASOLINE_DENSITY_G_PER_L);
}

/** L/100km; null when stationary (consumption per distance is undefined). */
export function lPer100(lph, speedKmh) {
  if (!Number.isFinite(lph) || !Number.isFinite(speedKmh) || speedKmh < 3) return null;
  return (lph / speedKmh) * 100;
}

/**
 * Collects fuel-trim samples split by idle vs load, then explains the pattern.
 * Total trim = STFT + LTFT. Positive = ECU adding fuel (engine sees lean mixture).
 */
export class TrimAnalyzer {
  constructor() { this.reset(); }
  reset() { this.idle = []; this.load = []; }
  add({ rpm, speed, stft, ltft }) {
    if (![rpm, stft, ltft].every(Number.isFinite)) return;
    const total = stft + ltft;
    if (rpm < 1000 && (speed ?? 0) < 3) this.idle.push(total);
    else if (rpm >= 1800) this.load.push(total);
    if (this.idle.length > 600) this.idle.shift();
    if (this.load.length > 600) this.load.shift();
  }
  verdict() {
    const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    const enough = this.idle.length >= 10 || this.load.length >= 10;
    if (!enough) return { level: 'wait', text: 'شغّل المحرك على السلانسيه قليلاً ثم ارفع الدوران إلى 2500 لجمع العيّنات.' };
    const idle = this.idle.length >= 10 ? avg(this.idle) : null;
    const load = this.load.length >= 10 ? avg(this.load) : null;
    const f = (x) => (x == null ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(1)}%`);
    const base = `التصحيح الكلي: سلانسيه ${f(idle)}، تحت الحِمل ${f(load)}.`;
    if (idle != null && load != null && idle > 10 && load < idle - 5) {
      return { level: 'warn', idle, load, text: `${base} الخليط فقير في السلانسيه ويتحسن مع الدوران: هذا نمط تسريب فاكيوم. افحص الليّات وجوان المشعب وصمام PCV.` };
    }
    if (idle != null && idle > 10 && load == null) {
      return { level: 'warn', idle, load, text: `${base} الخليط فقير في السلانسيه. ارفع الدوران إلى 2500 لعدة ثوانٍ لتمييز تسريب الفاكيوم عن ضعف ضخ الوقود.` };
    }
    if (idle != null && load != null && idle > 10 && load > 10) {
      return { level: 'warn', idle, load, text: `${base} الخليط فقير في كل الحالات: الأرجح ضعف ضخ الوقود (طرمبة/فلتر) أو حساس MAF يقرأ أقل من الواقع.` };
    }
    if (load != null && load > 10 && (idle == null || idle < 5)) {
      return { level: 'warn', idle, load, text: `${base} الخليط يفتقر تحت الحِمل فقط: افحص ضغط الوقود وفلتر البنزين.` };
    }
    if ((idle ?? 0) < -10 || (load ?? 0) < -10) {
      return { level: 'warn', idle, load, text: `${base} الخليط غني: افحص البخاخات وفلتر الهواء وحساس MAF.` };
    }
    return { level: 'ok', idle, load, text: `${base} الخليط ضمن الطبيعي (±10%).` };
  }
}

/** Used-car / pre-purchase verdict from monitor status + "since cleared" counters. */
export function inspectionVerdict({ status, distClear, warmups, timeClear, permanentCount }) {
  const flags = [];
  if (status?.mil) flags.push({ level: 'bad', text: 'لمبة فحص المحرك مضاءة.' });
  if (permanentCount > 0) flags.push({ level: 'bad', text: `يوجد ${permanentCount} عطل دائم: لا يُمسح إلا بعد إصلاح السبب فعلاً.` });
  const notReady = status?.monitors?.filter((m) => !m.ready) || [];
  if (notReady.length) flags.push({ level: 'warn', text: `${notReady.length} من أنظمة المراقبة غير جاهزة: علامة على مسح أعطال أو فصل البطارية مؤخراً.` });
  if (Number.isFinite(distClear) && distClear < 200) flags.push({ level: 'warn', text: `مُسحت الأعطال قبل ${distClear} كم فقط.` });
  if (Number.isFinite(warmups) && warmups < 10) flags.push({ level: 'warn', text: `${warmups} دورات إحماء فقط منذ آخر مسح.` });
  if (Number.isFinite(timeClear) && timeClear < 600) flags.push({ level: 'warn', text: `مُسحت الأعطال قبل ${Math.round(timeClear / 60)} ساعة تشغيل تقريباً.` });
  const level = flags.some((f) => f.level === 'bad') ? 'bad' : flags.length ? 'warn' : 'ok';
  const summary = {
    ok: 'لا مؤشرات على إخفاء أعطال. الأنظمة جاهزة والسجل طبيعي.',
    warn: 'انتبه: توجد مؤشرات على مسح أعطال حديث. اطلب من البائع قيادة السيارة عدة أيام ثم أعد الفحص.',
    bad: 'توجد أعطال فعلية تحتاج إصلاحاً قبل الشراء.',
  }[level];
  return { level, summary, flags };
}

/** Simple 0-100 km/h timer state machine. */
export class SprintTimer {
  constructor(target = 100) { this.target = target; this.reset(); }
  reset() { this.state = 'armed'; this.start = null; this.result = null; }
  update(speed, t) {
    if (!Number.isFinite(speed)) return;
    if (this.state === 'armed' && speed > 0.5) { this.state = 'running'; this.start = t; }
    else if (this.state === 'armed') this.start = null;
    if (this.state === 'running' && speed < 0.5) { this.state = 'armed'; this.start = null; }
    if (this.state === 'running' && speed >= this.target) { this.state = 'done'; this.result = (t - this.start) / 1000; }
  }
}
