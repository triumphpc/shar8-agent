// Журнал отправок прогона (M5): хуки gate пишут строки в audit.jsonl, демон читает и собирает Journal.
// Журнал строится только из файла, текст модели в нём не участвует (ADR-007, AC-025).

import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const AUDIT_FILE = 'audit.jsonl';
export const AUDIT_OVERFLOW_FILE = 'audit.overflow';
export const AUDIT_BLOCKED_MAX = 200;      // сколько строк blocked пишется; дальше только счётчик
export const AUDIT_LINE_MAX = 4096;
export const JOURNAL_ENTRIES_MAX = 100;
export const REF_MAX = 200;

const EVENTS = new Set(['attempt', 'blocked', 'ok', 'error']);
// Пределы полей до записи: строка гарантированно короче AUDIT_LINE_MAX.
const FIELD_MAX = { tool_use_id: 100, kind: 40, target: 160, ref: REF_MAX, snippet: 100, reason: 80, agent_type: 60 };

const clip = (v, n) => String(v).slice(0, n);

/** Приводит запись к виду строки аудита: известные поля, обрезка, не длиннее AUDIT_LINE_MAX байт. */
function shape(record) {
  const out = { v: 1, ts: Number.isFinite(Number(record?.ts)) ? Number(record.ts) : Date.now() };
  for (const [k, max] of Object.entries(FIELD_MAX)) if (!(k === 'snippet' && record?.event === 'blocked') && record?.[k] !== undefined && record[k] !== null) out[k] = clip(record[k], max);
  out.event = record?.event;
  if (record?.sub === true) out.sub = true;
  // Поля в стабильном порядке; сверх лимита сначала уходит фрагмент, затем цель.
  let line = JSON.stringify(out);
  for (const drop of ['snippet', 'ref', 'agent_type', 'reason']) {
    if (Buffer.byteLength(line) <= AUDIT_LINE_MAX - 1) break;
    delete out[drop];
    line = JSON.stringify(out);
  }
  if (Buffer.byteLength(line) > AUDIT_LINE_MAX - 1) { out.target = clip(out.target ?? '', 40); line = JSON.stringify(out); }
  return line;
}

const countBlocked = (path) => {
  try { return (readFileSync(path, 'utf8').match(/"event":"blocked"/g) || []).length; } catch (err) {
    if (err?.code === 'ENOENT') return 0;
    throw err;
  }
};

/**
 * Дописывает одну строку одним appendFileSync (O_APPEND). Для blocked сверх AUDIT_BLOCKED_MAX дописывает
 * байт в audit.overflow. Исключения файловой системы пробрасываются.
 * @returns {{ written: boolean, overflow: boolean }}
 */
export function appendAudit(runDir, record) {
  if (!EVENTS.has(record?.event)) throw new TypeError('bad audit event');
  const file = join(runDir, AUDIT_FILE);
  if (record.event === 'blocked' && countBlocked(file) >= AUDIT_BLOCKED_MAX) {
    appendFileSync(join(runDir, AUDIT_OVERFLOW_FILE), '.', { mode: 0o600 });
    return { written: false, overflow: true };
  }
  appendFileSync(file, `${shape(record)}\n`, { mode: 0o600 });
  return { written: true, overflow: false };
}

/** @returns {{ records: object[], blockedOverflow: number, badLines: number }} Битые строки пропускаются и считаются. */
export function readAudit(runDir) {
  const out = { records: [], blockedOverflow: 0, badLines: 0 };
  let text = '';
  try { text = readFileSync(join(runDir, AUDIT_FILE), 'utf8'); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '') continue;
    let r;
    try { r = JSON.parse(lines[i]); } catch { out.badLines++; continue; }
    if (!r || typeof r !== 'object' || !EVENTS.has(r.event) || typeof r.tool_use_id !== 'string' || r.tool_use_id === '') { out.badLines++; continue; }
    out.records.push(r);
  }
  try { out.blockedOverflow = statSync(join(runDir, AUDIT_OVERFLOW_FILE)).size; } catch (err) { if (err?.code !== 'ENOENT') throw err; }
  return out;
}

const entryOf = (outcome, r, ref) => {
  const e = { kind: r.kind, outcome, target: r.target ?? '' };
  if (outcome === 'ok' && ref) e.ref = ref;
  if (r.snippet) e.snippet = r.snippet;
  if (r.reason && outcome !== 'ok' && outcome !== 'started') e.reason = r.reason;
  return e;
};

/**
 * Склейка по tool_use_id: ok или error побеждает attempt; attempt без итога даёт started; одиночный blocked
 * даёт blocked. Не-blocked записи сохраняются все, blocked идут первыми по порядку, пока всего не станет
 * JOURNAL_ENTRIES_MAX; остаток, audit.overflow и блоки без вида считаются в hidden.blocked.
 * @returns {{ due: string|null, entries: object[], hidden?: { blocked: number } }}
 */
export function buildJournal(read, { due = null } = {}) {
  const groups = new Map();
  (read?.records || []).forEach((r, order) => {
    if (!groups.has(r.tool_use_id)) groups.set(r.tool_use_id, []);
    groups.get(r.tool_use_id).push({ r, order });
  });
  const items = [];
  let unkinded = 0;                                   // блоки без вида (инструмент не объявлен, политика не прочитана): сервер такую запись отбросил бы
  for (const list of groups.values()) {
    const final = [...list].reverse().find((x) => x.r.event === 'ok' || x.r.event === 'error');
    const attempt = list.find((x) => x.r.event === 'attempt');
    const blocked = list.find((x) => x.r.event === 'blocked');
    let item;
    if (final) item = { entry: entryOf(final.r.event, { ...attempt?.r, ...final.r }, final.r.ref), ts: attempt?.r.ts ?? final.r.ts, order: (attempt || final).order };
    else if (attempt) item = { entry: entryOf('started', attempt.r), ts: attempt.r.ts, order: attempt.order };
    else if (blocked) {
      // Блок без вида сервер (normalizeJournal) молча выкинул бы: считаем его в hidden.blocked, тогда заметка покажет «Не всё выполнено».
      if (typeof blocked.r.kind !== 'string' || blocked.r.kind === '') { unkinded++; continue; }
      item = { entry: entryOf('blocked', blocked.r), ts: blocked.r.ts, order: blocked.order, blocked: true };
    } else continue;
    items.push(item);
  }
  const byTime = (a, b) => (Number(a.ts) - Number(b.ts)) || (a.order - b.order);
  items.sort(byTime);
  const keep = items.filter((x) => !x.blocked);
  let room = Math.max(0, JOURNAL_ENTRIES_MAX - keep.length);
  let hidden = Math.max(0, Number(read?.blockedOverflow) || 0) + unkinded;
  for (const x of items.filter((y) => y.blocked)) { if (room > 0) { keep.push(x); room--; } else hidden++; }
  keep.sort(byTime);
  const journal = { due: due ?? null, entries: keep.map((x) => x.entry) };
  if (hidden > 0) journal.hidden = { blocked: hidden };
  return journal;
}

/** Ответ инструмента как список текстовых кусков (строка, блоки {type:'text'}, {content:[…]}, массив). */
const partsOf = (resp, depth = 0) => {
  if (resp === null || resp === undefined || depth > 4) return [];
  if (typeof resp === 'string') return [resp];
  if (Array.isArray(resp)) return resp.flatMap((x) => partsOf(x, depth + 1));
  if (typeof resp === 'object') {
    if (Array.isArray(resp.content)) return partsOf(resp.content, depth + 1);
    if (resp.type === 'text' && typeof resp.text === 'string') return [resp.text];
    try { return [JSON.stringify(resp)]; } catch { return []; }
  }
  return [String(resp)];
};

const URL_RE = /https?:\/\/[^\s"'<>\\]+/;
const firstField = (v, names, depth = 0) => {
  if (!v || typeof v !== 'object' || depth > 3) return null;
  for (const n of names) if (typeof v[n] === 'string' && v[n].trim() !== '') return v[n].trim();
  for (const n of names) if (typeof v[n] === 'number' && Number.isFinite(v[n])) return String(v[n]);
  for (const child of Array.isArray(v) ? v : Object.values(v)) {
    const r = firstField(child, names, depth + 1);
    if (r) return r;
  }
  return null;
};

/** Ссылка или идентификатор объекта из ответа инструмента; null, если не нашли. */
export function extractRef(toolResponse) {
  try {
    const parts = partsOf(toolResponse).map((x) => x.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    const url = URL_RE.exec(parts.join('\n'));
    if (url) return url[0].replace(/[.,;:!?)\]}]+$/, '').slice(0, REF_MAX);
    const docs = parts.map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter((x) => x && typeof x === 'object');
    for (const names of [['web_url', 'url', 'link'], ['id', 'key']]) {
      for (const doc of docs) {
        const v = firstField(doc, names);
        if (v) return (names[0] === 'id' ? `id ${v}` : v).slice(0, REF_MAX);
      }
    }
    return null;
  } catch {
    return null;
  }
}
