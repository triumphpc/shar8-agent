// Чистые функции: генератор id, даты, форматирование. Обращений к странице
// здесь нет — файл импортируют и браузерное приложение, и mcp.mjs в Node,
// поэтому правила про даты живут в единственном экземпляре.
// Даты хранятся как локальные наивные строки: 'YYYY-MM-DD' (весь день)
// или 'YYYY-MM-DDTHH:mm' (с временем).

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ---------- Даты ----------

export const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
export const WEEKDAYS_FULL = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
export const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

const pad2 = (n) => String(n).padStart(2, '0');

/** Date -> 'YYYY-MM-DD' в локальной зоне. */
export function toDateStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 'YYYY-MM-DD' -> Date (локальная полночь). */
export function fromDateStr(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export const todayStr = () => toDateStr(new Date());

export function addDaysStr(dateStr, n) {
  const d = fromDateStr(dateStr);
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

/** Ближайший понедельник строго после сегодня. */
export function nextMondayStr(from = todayStr()) {
  const d = fromDateStr(from);
  const shift = (8 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + shift);
  return toDateStr(d);
}

export const isAllDay = (due) => !!due && due.length === 10;
export const datePart = (due) => (due ? due.slice(0, 10) : null);
export const timePart = (due) => (due && due.length > 10 ? due.slice(11, 16) : null);
export const combineDue = (date, time) => (date ? (time ? `${date}T${time}` : date) : null);

/** Шаг «во сколько» нужен только для сегодняшней даты. null и любая другая дата: нет. */
export const needsTimeStep = (date, today = todayStr()) => date != null && date === today;

/** Время после выбора дня кнопкой или календарём: у сегодняшнего сохраняется, у остальных сбрасывается. */
export const timeAfterDayPick = (nextDate, prevTime, today = todayStr()) =>
  needsTimeStep(nextDate, today) ? (prevTime ?? null) : null;

/** Наивная локальная строка -> Date. Для «весь день» — локальная полночь. */
export function parseDue(due) {
  if (!due) return null;
  const [datePartStr, timePartStr] = due.split('T');
  const [y, m, d] = datePartStr.split('-').map(Number);
  if (!timePartStr) return new Date(y, m - 1, d);
  const [hh, mm] = timePartStr.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

export function fmtDayLabel(dateStr) {
  const today = todayStr();
  if (dateStr === today) return 'Сегодня';
  if (dateStr === addDaysStr(today, 1)) return 'Завтра';
  if (dateStr === addDaysStr(today, -1)) return 'Вчера';
  const d = fromDateStr(dateStr);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const base = `${WEEKDAYS_SHORT[d.getDay()]}, ${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
  return sameYear ? base : `${base} ${d.getFullYear()}`;
}

/** Всегда «чт, 20 августа» — без подмены на «Сегодня»/«Завтра». */
export function fmtDateShort(dateStr) {
  const d = fromDateStr(dateStr);
  return `${WEEKDAYS_SHORT[d.getDay()]}, ${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
}

/** «Сегодня, 10:00» / «пт, 22 августа». */
export function fmtDue(due) {
  if (!due) return '';
  const day = fmtDayLabel(datePart(due));
  const time = timePart(due);
  return time ? `${day}, ${time}` : day;
}

export function fmtTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Просрочено: время прошло (для «весь день» — день уже закончился). */
export function isOverdue(due, now = new Date()) {
  if (!due) return false;
  if (isAllDay(due)) return datePart(due) < toDateStr(now);
  return parseDue(due).getTime() < now.getTime();
}

/** Приводит повтор к хранимой форме. Единая для приложения и MCP; без новых полей форма прежняя. */
export function normalizeRepeat(r) {
  if (!r || typeof r !== 'object') return null;
  const out = {
    freq: r.freq,                               // daily | weekly | monthly
    interval: Math.max(1, r.interval || 1),
    time: r.time || null,                       // 'HH:mm' | null
    anchor: r.anchor || null,                   // 'YYYY-MM-DD' — начало серии
  };
  // Дни недели (0 — вс) — только у еженедельного повтора; пустой набор не хранится.
  if (r.freq === 'weekly' && Array.isArray(r.days)) {
    const days = [...new Set(r.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
    if (days.length) out.days = days;
  }
  // 'move' — умолчание и не хранится.
  if (r.missed === 'copy') out.missed = 'copy';
  return out;
}

/** «Пн, Ср, Пт» — по порядку недели, с понедельника. */
export function daysLabel(days) {
  if (!Array.isArray(days) || !days.length) return '';
  const order = [1, 2, 3, 4, 5, 6, 0];
  const names = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  return order.filter((d) => days.includes(d)).map((d) => names[d]).join(', ');
}

/** Понедельник недели, в которую попадает дата. */
function weekStart(dateStr) {
  const d = fromDateStr(dateStr);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/**
 * Следующая дата серии строго после `afterDateStr`.
 * Для месячного повтора день месяца сохраняется и подрезается по длине месяца.
 * Еженедельный повтор с `days` выбирает ближайший выбранный день; при интервале N
 * подходят только каждые N-е недели, считая от недели `fromDateStr_`.
 */
export function nextOccurrence(fromDateStr_, repeat, afterDateStr = todayStr()) {
  const interval = Math.max(1, repeat.interval || 1);
  let cur = fromDateStr_;
  let guard = 0;

  if (repeat.freq === 'weekly' && Array.isArray(repeat.days) && repeat.days.length) {
    const base = weekStart(fromDateStr_).getTime();
    let d = addDaysStr(afterDateStr > fromDateStr_ ? afterDateStr : fromDateStr_, 1);
    // Неделя серии повторяется каждые `interval` недель: дальше 7·interval + 7 дней искать нечего.
    for (; guard++ <= 7 * interval + 7; d = addDaysStr(d, 1)) {
      if (!repeat.days.includes(fromDateStr(d).getDay())) continue;
      const weeks = Math.round((weekStart(d).getTime() - base) / (7 * 86400000));
      if (weeks % interval === 0) return d;
    }
    return d;
  }

  if (repeat.freq === 'monthly') {
    const anchorDay = fromDateStr(fromDateStr_).getDate();
    let d = fromDateStr(fromDateStr_);
    while (toDateStr(d) <= afterDateStr && guard++ < 600) {
      const m = d.getMonth() + interval;
      const y = d.getFullYear() + Math.floor(m / 12);
      const mm = ((m % 12) + 12) % 12;
      const lastDay = new Date(y, mm + 1, 0).getDate();
      d = new Date(y, mm, Math.min(anchorDay, lastDay));
    }
    return toDateStr(d);
  }

  const step = repeat.freq === 'weekly' ? 7 * interval : interval;
  while (cur <= afterDateStr && guard++ < 3000) cur = addDaysStr(cur, step);
  return cur;
}

/** Если серия по дням недели, а дата стоит на невыбранном дне — ближайший выбранный день не раньше даты. */
export function alignToRepeat(dateStr, repeat) {
  if (repeat?.freq !== 'weekly' || !repeat.days?.length || repeat.days.includes(fromDateStr(dateStr).getDay())) return dateStr;
  return nextOccurrence(dateStr, repeat, dateStr);
}

/** Дни просрочки: календарных дней от даты срока до сегодня; 0 — не просрочено по дате. */
export function overdueDays(due, today = todayStr()) {
  const d = datePart(due);
  if (!d || d >= today) return 0;
  return daysBetween(d, today);
}

/**
 * Даты вхождений серии, пропущенных к `today` (раньше сегодня), начиная с `baseDate` включительно.
 * Остаются `cap` последних.
 */
export function missedOccurrences(baseDate, repeat, today = todayStr(), cap = 7) {
  const dates = [];
  let cur = baseDate;
  let guard = 0;
  while (cur < today && guard++ < 3000) {
    dates.push(cur);
    cur = nextOccurrence(cur, repeat, cur);
  }
  return dates.slice(-cap);
}

export function daysBetween(aStr, bStr) {
  return Math.round((fromDateStr(bStr) - fromDateStr(aStr)) / 86400000);
}

/** Схлопывает многострочный текст в одну строку — для мест, где перенос неуместен
 *  (заголовок уведомления, aria-label, summary события). */
export function oneLine(text) {
  return String(text ?? '').replace(/\s*\n+\s*/g, ' ').trim();
}

export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

// ---------- Комментарий при закрытии ----------
// Хранится в completions[]: { at, due, note }. Запись обычного закрытия имеет at === completedAt.

export const COMMENT_MAX = 500;
export const cleanComment = (c) => String(c ?? '').trim().slice(0, COMMENT_MAX);

/** Комментарий последнего закрытия выполненной задачи; пустая строка, если не было или задача в работе. */
export function closeComment(t) {
  if (!t?.done) return '';
  return (t.completions || []).find((c) => c.at === t.completedAt && c.note)?.note || '';
}

/** Комментарий последнего выполненного вхождения повторяющейся задачи. */
export function lastRepeatComment(t) {
  if (!t?.repeat) return '';
  return (t.completions || []).at(-1)?.note || '';
}
