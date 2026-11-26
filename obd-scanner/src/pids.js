// SAE J1979 mode 01 PIDs used by the app. decode(bytes) -> number.
export const PIDS = {
  0x04: { key: 'load', name: 'حِمل المحرك', unit: '%', min: 0, max: 100, decode: ([a]) => (a * 100) / 255 },
  0x05: { key: 'coolant', name: 'حرارة الماء', unit: '°م', min: -40, max: 130, warn: 105, decode: ([a]) => a - 40 },
  0x06: { key: 'stft1', name: 'تصحيح الوقود القصير', unit: '%', min: -25, max: 25, decode: ([a]) => ((a - 128) * 100) / 128 },
  0x07: { key: 'ltft1', name: 'تصحيح الوقود الطويل', unit: '%', min: -25, max: 25, decode: ([a]) => ((a - 128) * 100) / 128 },
  0x0a: { key: 'fuelPressure', name: 'ضغط الوقود', unit: 'kPa', min: 0, max: 765, decode: ([a]) => a * 3 },
  0x0b: { key: 'map', name: 'ضغط المشعب', unit: 'kPa', min: 0, max: 255, decode: ([a]) => a },
  0x0c: { key: 'rpm', name: 'دوران المحرك', unit: 'rpm', min: 0, max: 8000, warn: 6500, decode: ([a, b]) => (a * 256 + b) / 4 },
  0x0d: { key: 'speed', name: 'السرعة', unit: 'كم/س', min: 0, max: 240, decode: ([a]) => a },
  0x0e: { key: 'timing', name: 'توقيت الشرارة', unit: '°', min: -64, max: 64, decode: ([a]) => a / 2 - 64 },
  0x0f: { key: 'iat', name: 'حرارة هواء السحب', unit: '°م', min: -40, max: 90, decode: ([a]) => a - 40 },
  0x10: { key: 'maf', name: 'تدفق الهواء MAF', unit: 'غ/ث', min: 0, max: 300, decode: ([a, b]) => (a * 256 + b) / 100 },
  0x11: { key: 'throttle', name: 'فتحة الثروتل', unit: '%', min: 0, max: 100, decode: ([a]) => (a * 100) / 255 },
  0x1f: { key: 'runtime', name: 'زمن التشغيل', unit: 'ث', min: 0, max: 65535, decode: ([a, b]) => a * 256 + b },
  0x21: { key: 'distMil', name: 'مسافة مع لمبة العطل', unit: 'كم', min: 0, max: 65535, decode: ([a, b]) => a * 256 + b },
  0x2f: { key: 'fuelLevel', name: 'مستوى الوقود', unit: '%', min: 0, max: 100, decode: ([a]) => (a * 100) / 255 },
  0x30: { key: 'warmups', name: 'دورات إحماء منذ المسح', unit: '', min: 0, max: 255, decode: ([a]) => a },
  0x31: { key: 'distClear', name: 'مسافة منذ مسح الأعطال', unit: 'كم', min: 0, max: 65535, decode: ([a, b]) => a * 256 + b },
  0x33: { key: 'baro', name: 'الضغط الجوي', unit: 'kPa', min: 0, max: 255, decode: ([a]) => a },
  0x42: { key: 'ecuVolt', name: 'جهد كمبيوتر المحرك', unit: 'V', min: 0, max: 18, decode: ([a, b]) => (a * 256 + b) / 1000 },
  0x46: { key: 'ambient', name: 'حرارة الجو', unit: '°م', min: -40, max: 60, decode: ([a]) => a - 40 },
  0x4e: { key: 'timeClear', name: 'زمن منذ مسح الأعطال', unit: 'دقيقة', min: 0, max: 65535, decode: ([a, b]) => a * 256 + b },
  0x5c: { key: 'oilTemp', name: 'حرارة الزيت', unit: '°م', min: -40, max: 160, warn: 135, decode: ([a]) => a - 40 },
  0x5e: { key: 'fuelRate', name: 'معدل استهلاك الوقود', unit: 'ل/س', min: 0, max: 50, decode: ([a, b]) => (a * 256 + b) / 20 },
};

// Gauges offered on the live screen (order = default display order).
export const LIVE_PIDS = [0x0c, 0x0d, 0x05, 0x04, 0x11, 0x06, 0x07, 0x10, 0x0b, 0x0f, 0x0e, 0x5c, 0x2f, 0x42, 0x46, 0x5e];
export const DEFAULT_LIVE = [0x0c, 0x0d, 0x05, 0x04, 0x06, 0x07];

export function decodePid(pid, bytes) {
  const def = PIDS[pid];
  if (!def || !bytes) return null;
  const v = def.decode(bytes);
  return Number.isFinite(v) ? v : null;
}

/** Mode 01 PID 01: MIL, DTC count, readiness monitors. */
export function decodeMonitorStatus([a, b, c, d]) {
  const mil = (a & 0x80) !== 0;
  const dtcCount = a & 0x7f;
  const diesel = (b & 0x08) !== 0;
  const monitors = [];
  const add = (name, supported, incomplete) => supported && monitors.push({ name, ready: !incomplete });
  add('انعدام الإشعال (Misfire)', b & 0x01, b & 0x10);
  add('نظام الوقود', b & 0x02, b & 0x20);
  add('المكونات الشاملة', b & 0x04, b & 0x40);
  const names = diesel
    ? ['محفّز NMHC', 'نظام NOx / SCR', null, 'ضغط التيربو', null, 'حساس العادم', 'فلتر الجزيئات DPF', 'EGR / VVT']
    : ['المحفّز (الدبّة)', 'تسخين المحفّز', 'نظام التبخير EVAP', 'الهواء الثانوي', null, 'حساس الأكسجين', 'سخّان حساس الأكسجين', 'نظام EGR / VVT'];
  names.forEach((n, i) => n && add(n, c & (1 << i), d & (1 << i)));
  return { mil, dtcCount, diesel, monitors };
}

/** SAE J1979 on-board monitor IDs (mode 06) -> Arabic name. */
export function midName(mid) {
  const bs = (n) => `بنك ${Math.floor(n / 4) + 1}، حساس ${(n % 4) + 1}`;
  if (mid >= 0x01 && mid <= 0x10) return `حساس الأكسجين (${bs(mid - 0x01)})`;
  if (mid >= 0x21 && mid <= 0x24) return `كفاءة المحفّز (بنك ${mid - 0x20})`;
  if (mid >= 0x31 && mid <= 0x34) return `نظام EGR (بنك ${mid - 0x30})`;
  if (mid >= 0x35 && mid <= 0x38) return `توقيت الكامات VVT (بنك ${mid - 0x34})`;
  const fixed = {
    0x39: 'تسريب EVAP (غطاء الخزان)', 0x3a: 'تسريب EVAP ‏(0.090 بوصة)', 0x3b: 'تسريب EVAP ‏(0.040 بوصة)',
    0x3c: 'تسريب EVAP ‏(0.020 بوصة)', 0x3d: 'تدفق تنظيف EVAP', 0xa1: 'انعدام الإشعال (عام)',
    0xb0: 'فلتر الجزيئات DPF (بنك 1)', 0xb1: 'فلتر الجزيئات DPF (بنك 2)',
  };
  if (fixed[mid]) return fixed[mid];
  if (mid >= 0x41 && mid <= 0x50) return `سخّان حساس الأكسجين (${bs(mid - 0x41)})`;
  if (mid >= 0x61 && mid <= 0x64) return `تسخين المحفّز (بنك ${mid - 0x60})`;
  if (mid >= 0x71 && mid <= 0x74) return `الهواء الثانوي ${mid - 0x70}`;
  if (mid >= 0x81 && mid <= 0x84) return `نظام الوقود (بنك ${mid - 0x80})`;
  if (mid >= 0x85 && mid <= 0x88) return `ضغط التيربو (بنك ${mid - 0x84})`;
  if (mid >= 0xa2 && mid <= 0xad) return `انعدام الإشعال — السلندر ${mid - 0xa1}`;
  return `اختبار 0x${mid.toString(16).toUpperCase().padStart(2, '0')}`;
}
