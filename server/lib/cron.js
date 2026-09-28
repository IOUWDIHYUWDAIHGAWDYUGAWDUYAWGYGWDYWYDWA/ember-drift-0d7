// Zamanlanmış görevler için 5 alanlı cron çözümleyici.
//
// Pterodactyl schedules ile aynı sözdizimi: dakika saat gün-ay ay gün-hafta.
// Desteklenen kalıplar: *, a, a-b, */n, a-b/n ve virgüllü listeler.

const FIELD_RANGES = [
  { min: 0, max: 59 }, // dakika
  { min: 0, max: 23 }, // saat
  { min: 1, max: 31 }, // ayın günü
  { min: 1, max: 12 }, // ay
  { min: 0, max: 7 }, // haftanın günü (0 ve 7 = pazar)
];

const MONTH_ALIASES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DAY_ALIASES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function aliasValue(token, index) {
  const table = index === 3 ? MONTH_ALIASES : index === 4 ? DAY_ALIASES : null;
  if (!table) return null;
  return table[token.toLowerCase()] ?? null;
}

function parseField(raw, index) {
  const { min, max } = FIELD_RANGES[index];
  const values = new Set();
  for (const part of String(raw).split(',')) {
    const piece = part.trim();
    if (!piece) throw new Error(`Cron alanı boş: "${raw}"`);
    const [rangePart, stepPart] = piece.split('/');
    let step = 1;
    if (stepPart !== undefined) {
      step = Number.parseInt(stepPart, 10);
      if (!Number.isInteger(step) || step < 1) throw new Error(`Geçersiz adım: "${piece}"`);
    }
    let start = min;
    let end = max;
    if (rangePart !== '*') {
      if (rangePart.includes('-')) {
        const [a, b] = rangePart.split('-');
        start = aliasValue(a, index) ?? Number.parseInt(a, 10);
        end = aliasValue(b, index) ?? Number.parseInt(b, 10);
      } else {
        start = aliasValue(rangePart, index) ?? Number.parseInt(rangePart, 10);
        end = stepPart !== undefined ? max : start;
      }
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new Error(`Geçersiz cron değeri: "${piece}"`);
    }
    if (start < min || end > max || start > end) {
      throw new Error(`Cron değeri aralık dışında (${min}-${max}): "${piece}"`);
    }
    for (let value = start; value <= end; value += step) {
      // haftanın gününde 7 = 0 (pazar); normalleştirme aralığı bozmasın diye
      // döngüden SONRA yapılır.
      values.add(index === 4 && value === 7 ? 0 : value);
    }
  }
  return values;
}

export function parseCron(expression) {
  const fields = String(expression ?? '').trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error('Cron ifadesi 5 alandan oluşmalı: "dakika saat gün ay haftagün" (örn. "0 4 * * *").');
  }
  const parsed = fields.map(parseField);
  const [minutes, hours, doms, months, dows] = parsed;
  const domRestricted = fields[2] !== '*';
  const dowRestricted = fields[4] !== '*';

  return {
    expression: fields.join(' '),
    fields: parsed,
    domRestricted,
    dowRestricted,
    /** Verilen Date bu ifadeye uyuyor mu? (dakika hassasiyeti) */
    matches(date) {
      if (!minutes.has(date.getMinutes())) return false;
      if (!hours.has(date.getHours())) return false;
      if (!months.has(date.getMonth() + 1)) return false;
      const domOk = doms.has(date.getDate());
      const dowOk = dows.has(date.getDay());
      // Cron kuralı: hem gün-ay hem gün-hafta kısıtlıysa VEYA bağlacı geçerlidir.
      if (domRestricted && dowRestricted) return domOk || dowOk;
      if (domRestricted) return domOk;
      if (dowRestricted) return dowOk;
      return true;
    },
  };
}

/** Sonraki çalışma zamanı (yoksa null — en fazla 366 gün ileri bakılır). */
export function nextRun(expression, from = new Date()) {
  const cron = typeof expression === 'string' ? parseCron(expression) : expression;
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i += 1) {
    if (cron.matches(cursor)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

export function describeCron(expression) {
  const cron = typeof expression === 'string' ? parseCron(expression) : expression;
  const [minutes, hours] = cron.fields;
  const pad = (n) => String(n).padStart(2, '0');
  const everyDay = !cron.domRestricted && !cron.dowRestricted;
  if (!everyDay) return null;
  if (minutes.size === 60 && hours.size === 24) return 'her dakika';
  if (minutes.size === 1 && hours.size === 24) {
    const minute = [...minutes][0];
    return minute === 0 ? 'her saat başı' : `her saat :${pad(minute)}`;
  }
  if (minutes.size === 1 && hours.size === 1) return `her gün ${pad([...hours][0])}:${pad([...minutes][0])}`;
  return null;
}
