// Делегирование задач агенту: данные, правила переходов, слияние, очередь.
// Чистый модуль: без DOM, без модулей Node, без обращения к времени (кроме nextAt по умолчанию).
// Его импортируют все среды исполнения (браузер, sync.mjs, serve.mjs, mcp.mjs, agent/*),
// поэтому правила статуса существуют в единственном экземпляре.

import { datePart, oneLine } from './core.js';

export const AGENT_STATUSES = ['delegated', 'in_progress', 'review', 'needs_info', 'failed'];

/** short — бейдж в строке; full — title, aria-label, редактор. */
export const AGENT_LABELS = {
  delegated:   { short: 'Делегирована',    full: 'Делегирована' },
  in_progress: { short: 'В работе',        full: 'В работе у агента' },
  review:      { short: 'На проверке',     full: 'Выполнена агентом (на проверке)' },
  needs_info:  { short: 'Нужно уточнение', full: 'Нужно уточнение' },
  failed:      { short: 'Не справился',    full: 'Агент не справился' },
};

/** Группы цвета: три, как требует FR-002. */
export const AGENT_TONE = {
  delegated: 'wait', in_progress: 'wait', review: 'ok', needs_info: 'ask', failed: 'ask',
};

export const LIMITS = Object.freeze({
  TTL_MS: 20 * 60 * 1000,   // таймаут 15 минут + 5 минут запаса (ADR-002)
  NOTE_MAX: 4000,           // символов в тексте результата
  REASON_MAX: 300,          // символов в причине failed
});

/**
 * Предел длины ЦЕЛОЙ заметки агента (с префиксом «Результат агента\n» и т. п.). Единая константа:
 * composeNote гарантирует, что не выдаст длиннее, а sync.mjs отбрасывает новые входящие заметки длиннее.
 */
/** Журнал действий (agent-send-actions, M9): бюджет блока, заголовок, запас на строку «Не всё выполнено». */
export const JOURNAL_MAX = 2400;
export const JOURNAL_HEADER = 'Журнал действий';
export const INCOMPLETE_MAX = 200;
/** Было LIMITS.NOTE_MAX + 64; добавлен запас на строку «Не всё выполнено» (блок журнала входит в бюджет NOTE_MAX). */
export const NOTE_TEXT_MAX = LIMITS.NOTE_MAX + 64 + INCOMPLETE_MAX;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/** @returns {object|undefined} undefined, если raw не объект: «ключа нет». */
export function normalizeAgent(raw) {
  if (!isObj(raw)) return undefined;
  return {
    status: AGENT_STATUSES.includes(raw.status) ? raw.status : null,
    claimedAt: num(raw.claimedAt),
    finishedAt: num(raw.finishedAt),
    claimToken: typeof raw.claimToken === 'string' && raw.claimToken ? raw.claimToken : null,
    // Запись без метки проигрывает любой записи с меткой, а не выигрывает «текущим временем».
    at: Number(raw.at) || 0,
  };
}

/** Метка не меньше прежней + 1: собственные метки клиента не идут назад. */
export function nextAt(prevAt, now = Date.now()) {
  return Math.max(Number(now) || 0, (Number(prevAt) || 0) + 1);
}

const block = (status, prev, now, keep = {}) => ({
  status, claimedAt: null, finishedAt: null, claimToken: null, ...keep, at: nextAt(prev?.at, now),
});

/** Новый блок при галке. */
export const delegateBlock = (prev, now) => block('delegated', prev, now);
/** Явный {status:null, at}: ключ не удаляется, снятие всегда видно слиянию (C5). */
export const clearBlock = (prev, now) => block(null, prev, now);
/** Сброс повторяющейся задачи: status 'delegated', токены и finishedAt обнулены. */
export const resetBlock = (prev, now) => block('delegated', prev, now);

/**
 * Единое правило сброса блока при действии пользователя над задачей: его вызывают
 * js/model.js и mcp.mjs, поэтому клиент и MCP ведут себя одинаково.
 * ev: 'close' | 'reopen' | 'repeat' | 'due_change'; для 'due_change' task уже содержит новый due.
 * @returns {object|undefined} undefined — менять нечего. agentNotes не трогает.
 */
export function reconcileAgent(task, ev, { today, now }) {
  const cur = task?.agent;
  if (!cur || !cur.status) return undefined;
  switch (ev) {
    case 'close':
    case 'reopen':
      return clearBlock(cur, now);
    case 'repeat':
      return resetBlock(cur, now);
    case 'due_change':
      return !task.due || datePart(task.due) > today ? clearBlock(cur, now) : undefined;
    default:
      return undefined;
  }
}

/** Задача из «Сегодня» или просроченная, не закрыта, не входящее. */
export function isDelegable(task, today) {
  return !!task && !task.done && task.kind !== 'inbox' && !!task.due && datePart(task.due) <= today;
}

/** Всё, что нужно строке списка. */
export function agentView(task, today) {
  const status = !task.done && AGENT_STATUSES.includes(task.agent?.status) ? task.agent.status : null;
  const checked = status !== null;
  const canToggle = !task.done && (checked || isDelegable(task, today));
  const label = status ? AGENT_LABELS[status] : null;
  return {
    visible: canToggle,
    checked,
    canToggle,
    status,
    tone: status ? AGENT_TONE[status] : null,
    short: label ? label.short : '',
    full: label ? label.full : '',
  };
}

// ---------- Слияние ----------

const atOf = (a) => Number(a?.at) || 0;

/** Победитель по agent.at; при равенстве остаётся cur. Отсутствие ключа во входящем — «не знаю». */
export function mergeAgent(cur, inc) {
  if (!isObj(inc)) return isObj(cur) ? cur : undefined;
  if (!isObj(cur)) return inc;
  return atOf(inc) > atOf(cur) ? inc : cur;
}

const noteKey = (n) => `${Number(n.at) || 0}\u0000${n.text}`;

/**
 * Метка заметки с журналом действий. Ставит ТОЛЬКО сервер при agent_finish/reap (finishWith, SEC04);
 * sanitizeIncomingTask сохраняет её лишь у заметок, уже известных серверу с этой меткой.
 */
export const NOTE_KIND_JOURNAL = 'journal';

/** Объединение по паре (at, text), порядок по at, затем по тексту. Только добавляет. Метка kind не теряется. */
export function mergeAgentNotes(a, b) {
  const seen = new Map();
  for (const list of [a, b]) {
    if (!Array.isArray(list)) continue;
    for (const n of list) {
      if (!n || !n.text) continue;
      const k = noteKey(n);
      const prev = seen.get(k);
      if (!prev) seen.set(k, { at: Number(n.at) || 0, text: String(n.text), ...(n.kind === NOTE_KIND_JOURNAL ? { kind: NOTE_KIND_JOURNAL } : {}) });
      else if (n.kind === NOTE_KIND_JOURNAL && prev.kind !== NOTE_KIND_JOURNAL) prev.kind = NOTE_KIND_JOURNAL;
    }
  }
  return [...seen.values()].sort((x, y) => (x.at - y.at) || (x.text < y.text ? -1 : x.text > y.text ? 1 : 0));
}

/**
 * Пользовательские поля — по updatedAt (как раньше: побеждает строго более свежая запись),
 * agent и agentNotes — каждое по своему правилу. Вход не мутируется.
 */
export function mergeTaskRecord(cur, inc) {
  if (!cur) return inc;
  const base = (inc.updatedAt || 0) > (cur.updatedAt || 0) ? inc : cur;
  const result = { ...base };
  const agent = mergeAgent(cur.agent, inc.agent);
  if (agent !== undefined) result.agent = agent;
  if (Array.isArray(cur.agentNotes) || Array.isArray(inc.agentNotes)) {
    const merged = mergeAgentNotes(cur.agentNotes, inc.agentNotes);
    const same = Array.isArray(base.agentNotes) && JSON.stringify(base.agentNotes) === JSON.stringify(merged);
    if (!same) result.agentNotes = merged;
  }
  return result;
}

const clip = (text, max) => {
  const s = String(text ?? '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

// ---------- Журнал действий ----------

const KIND_LABELS = {
  vk: 'VK Teams', mr_note: 'MR: заметка', mr_discussion: 'MR: обсуждение', mr_reply: 'MR: ответ', jira: 'Jira', confluence: 'Confluence',
};
const REASON_LABELS = {
  not_allowed: 'адресат вне списка', limit: 'потолок исчерпан', policy: 'политика не прочитана',
  target_missing: 'адресат не определён', gate_error: 'сбой проверки', quick_action: 'быстрое действие в тексте', macro: 'запрещённый макрос',
};
const OUTCOMES = ['blocked', 'ok', 'error', 'started'];
const ENTRIES_MAX = 100;
const HIDDEN_MAX = 1_000_000;
const LIMITS_JOURNAL = { target: 120, ref: 200, snippet: 100, reason: 80 };
const flat = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const cut = (v, n) => flat(v).slice(0, n);

/**
 * @returns {{due:string|null, entries:object[], hidden?:{blocked:number}, unavailable?:true}|null}
 *   null, если raw не объект. Неизвестные виды и исходы отбрасываются, строки обрезаются и сводятся к одной строке.
 */
export function normalizeJournal(raw) {
  if (!isObj(raw)) return null;
  const out = { due: typeof raw.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.due) ? raw.due : null, entries: [] };
  if (raw.unavailable === true) out.unavailable = true;
  if (Array.isArray(raw.entries)) {
    for (const e of raw.entries) {
      if (out.entries.length >= ENTRIES_MAX) break;
      if (!isObj(e) || !Object.hasOwn(KIND_LABELS, e.kind) || !OUTCOMES.includes(e.outcome)) continue;
      const entry = { kind: e.kind, outcome: e.outcome, target: cut(typeof e.target === 'string' ? e.target : '', LIMITS_JOURNAL.target) };
      for (const f of ['ref', 'snippet', 'reason']) {
        if (typeof e[f] === 'string' && flat(e[f]) !== '') entry[f] = cut(e[f], LIMITS_JOURNAL[f]);
      }
      out.entries.push(entry);
    }
  }
  const hidden = Number(raw.hidden?.blocked);
  if (Number.isFinite(hidden) && hidden > 0) out.hidden = { blocked: Math.min(Math.floor(hidden), HIDDEN_MAX) };
  return out;
}

const counts = (j) => ({
  blocked: j.entries.filter((e) => e.outcome === 'blocked').length + (j.hidden?.blocked || 0),
  error: j.entries.filter((e) => e.outcome === 'error').length,
  started: j.entries.filter((e) => e.outcome === 'started').length,
});

/** Строка над блоком; строит composeNote из журнала, текст модели на неё не влияет (ADR-007). */
function incompleteLine(j) {
  if (j.unavailable) return '';
  const c = counts(j);
  const parts = [];
  if (c.blocked) parts.push(`заблокировано ${c.blocked}`);
  if (c.error) parts.push(`ошибок ${c.error}`);
  if (c.started) parts.push(`начато без итога ${c.started}`);
  return parts.length ? `Не всё выполнено: ${parts.join(', ')}`.slice(0, INCOMPLETE_MAX) : '';
}

const headerLine = (j) => (j.due ? `${JOURNAL_HEADER} (срок ${j.due})` : JOURNAL_HEADER);
const reasonText = (r) => REASON_LABELS[r] || r || '';
const times = (list) => {
  const m = new Map();
  for (const k of list) m.set(k, (m.get(k) || 0) + 1);
  return [...m].map(([k, n]) => `${KIND_LABELS[k]} ×${n}`).join(', ');
};

/** Строки блока на заданном уровне сжатия (0 — полный вид). Приоритет: 2 — error/started, 1 — остальное. */
function journalLines(j, level) {
  const lines = [];
  const ok = j.entries.filter((e) => e.outcome === 'ok');
  let okDone = false;
  const seenBlocked = new Map();
  for (const e of j.entries) {
    const label = KIND_LABELS[e.kind];
    if (e.outcome === 'ok') {
      if (level >= 2) {
        if (!okDone) { lines.push({ p: 1, t: `- выполнено: ${times(ok.map((x) => x.kind))}` }); okDone = true; }
        continue;
      }
      const parts = [`- выполнено`, `${label} → ${e.target}`];
      if (level < 1 && e.snippet) parts.push(`«${e.snippet}»`);
      parts.push(e.ref || 'ссылка не получена');
      lines.push({ p: 1, t: parts.join(' · ') });
    } else if (e.outcome === 'blocked') {
      if (level >= 3) {
        const key = `${e.kind}\u0000${e.reason || ''}`;
        if (seenBlocked.has(key)) { seenBlocked.get(key).n++; continue; }
        const item = { p: 1, n: 1, kind: e.kind, reason: e.reason };
        seenBlocked.set(key, item);
        lines.push(item);
        continue;
      }
      const parts = [`- заблокировано${e.reason ? ` (${reasonText(e.reason)})` : ''}`, `${label} → ${e.target}`];
      if (e.snippet) parts.push(`«${level >= 1 ? e.snippet.slice(0, 40) : e.snippet}»`);
      lines.push({ p: 1, t: parts.join(' · ') });
    } else {
      const head = e.outcome === 'error' ? `- ошибка${e.reason ? ` (${e.reason})` : ''}` : '- начато, итог не подтверждён';
      const parts = [head, `${label} → ${e.target}`];
      if (e.snippet) parts.push(`«${level >= 1 ? e.snippet.slice(0, 40) : e.snippet}»`);
      lines.push({ p: 2, t: parts.join(' · ') });
    }
  }
  for (const it of lines) if (it.n !== undefined) it.t = `- заблокировано${it.reason ? ` (${reasonText(it.reason)})` : ''}: ${KIND_LABELS[it.kind]} ×${it.n}`;
  if (j.hidden?.blocked) lines.push({ p: 1, t: `- ещё заблокировано: ${j.hidden.blocked}` });
  return lines;
}

/** Блок журнала не длиннее JOURNAL_MAX: четыре шага сжатия, после четвёртого длина гарантирована. */
function journalBlock(j) {
  const header = headerLine(j);
  if (j.unavailable) return [header, 'Журнал недоступен: что отправлено, проверьте вручную.'].join('\n');
  if (j.entries.length === 0 && !j.hidden) return [header, 'Действий не было.'].join('\n');
  const render = (items) => [header, ...items.map((i) => i.t)].join('\n');
  let items = [];
  for (let level = 0; level <= 3; level++) {
    items = journalLines(j, level);
    if (render(items).length <= JOURNAL_MAX) return render(items);
  }
  // Шаг 4: отрезать записи с конца; error и started уходят последними.
  let dropped = 0;
  const footer = () => ({ p: 1, t: `- … ещё ${dropped} записей` });
  const withFooter = () => (dropped ? [...items, footer()] : items);
  while (items.length && render(withFooter()).length > JOURNAL_MAX) {
    let idx = -1;
    for (let i = items.length - 1; i >= 0; i--) if (items[i].p === 1) { idx = i; break; }
    if (idx < 0) idx = items.length - 1;
    items.splice(idx, 1);
    dropped++;
  }
  const text = render(withFooter());
  return text.length <= JOURNAL_MAX ? text : `${text.slice(0, JOURNAL_MAX - 1)}…`;
}

/**
 * Текст заметки: «Результат агента\n…», «Вопрос агента: …», «Агент не справился: …». Не длиннее NOTE_TEXT_MAX.
 * journal необязателен: без него (или с мусором) результат совпадает с прежним побайтно. С журналом блок идёт
 * первым, журнал не режется с хвоста, текст модели получает остаток NOTE_MAX.
 *   review:     «Результат агента», [«Не всё выполнено»], блок, пустая строка, текст.
 *   needs_info: «Вопрос агента: …» (в одну строку), [строка], блок, если в журнале есть записи или он недоступен.
 *   failed:     «Агент не справился: <причина>», [строка], блок, тем же правилом.
 */
export function composeNote(status, text, journal) {
  const j = normalizeJournal(journal);
  let full;
  if (!j) {
    full = status === 'review' ? `Результат агента\n${clip(text, LIMITS.NOTE_MAX)}`
      : status === 'needs_info' ? `Вопрос агента: ${clip(text, LIMITS.NOTE_MAX)}`
      : `Агент не справился: ${clip(oneLine(text), LIMITS.REASON_MAX)}`;
  } else {
    const block = journalBlock(j);
    const extra = incompleteLine(j);
    const tail = [extra, block].filter(Boolean).join('\n');
    const budget = Math.max(0, LIMITS.NOTE_MAX - block.length);
    const show = j.entries.length > 0 || !!j.unavailable || !!j.hidden;
    if (status === 'review') {
      const t = clip(text, budget);
      full = `Результат агента\n${tail}${t ? `\n\n${t}` : ''}`;
    } else if (status === 'needs_info') {
      full = `Вопрос агента: ${clip(flat(text), budget)}${show ? `\n${tail}` : ''}`;
    } else {
      full = `Агент не справился: ${clip(flat(text), LIMITS.REASON_MAX)}${show ? `\n${tail}` : ''}`;
    }
  }
  return full.length > NOTE_TEXT_MAX ? `${full.slice(0, NOTE_TEXT_MAX - 1)}…` : full;
}

const BLOCK_HEAD = /^Журнал действий(?: \(срок (\d{4}-\d{2}-\d{2})\))?$/;

/**
 * Блоки «Журнал действий» из заметок агента: только заметки с серверной меткой kind:'journal' (SEC04);
 * заголовок ищется только в первых трёх строках заметки; берутся блоки со сроком, равным due. Блок заканчивается первой пустой строкой.
 * @returns {{at:number, text:string}[]} от старых к новым, не больше max (3)
 */
export function extractJournals(agentNotes, { due, max = 3 } = {}) {
  const found = [];
  try {
    if (!Array.isArray(agentNotes)) return [];
    const want = typeof due === 'string' && due ? due : null;
    const sorted = agentNotes.filter((n) => isObj(n) && n.kind === NOTE_KIND_JOURNAL && typeof n.text === 'string')
      .map((n) => ({ at: Number(n.at) || 0, text: n.text }))
      .sort((a, b) => a.at - b.at);
    for (const n of sorted) {
      // Не резать до поиска заголовка (I02): длинный вопрос агента в первой строке сдвигает блок за любой срез.
      const lines = n.text.slice(0, NOTE_TEXT_MAX).split('\n');
      const i = lines.slice(0, 3).findIndex((l) => BLOCK_HEAD.test(l));
      if (i < 0) continue;
      if ((BLOCK_HEAD.exec(lines[i])[1] ?? null) !== want) continue;
      let end = i + 1;
      while (end < lines.length && lines[end] !== '') end++;
      const text = lines.slice(i, end).join('\n');
      if (text.length <= JOURNAL_MAX) found.push({ at: n.at, text });
    }
  } catch { return []; }
  const limit = Math.max(0, Math.floor(Number(max)) || 0);
  return found.slice(-limit || found.length);
}

// ---------- Условные переходы ----------

const FINISH_STATUSES = ['review', 'needs_info', 'failed'];
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

function finishWith(task, status, text, now, journal) {
  const prev = task.agent;
  const agent = { status, claimedAt: prev.claimedAt ?? null, finishedAt: now, claimToken: null, at: nextAt(prev.at, now) };
  const note = { at: now, text: composeNote(status, text, journal), ...(journal ? { kind: NOTE_KIND_JOURNAL } : {}) };
  const agentNotes = mergeAgentNotes(task.agentNotes, [note]);
  return { ok: true, task: { ...task, agent, agentNotes } };
}

/**
 * Условный переход, чистая функция без IO. op: 'claim' | 'finish' | 'reap'.
 * Не меняет updatedAt задачи и пользовательские поля.
 * @returns {{ok:true, task:object} | {ok:false, reason:string}}
 */
export function applyAgentTransition(task, req, now) {
  if (!isObj(req)) return { ok: false, reason: 'bad_request' };
  switch (req.op) {
    case 'claim': {
      if (!nonEmpty(req.today) || !/^\d{4}-\d{2}-\d{2}$/.test(req.today) || !nonEmpty(req.token)) {
        return { ok: false, reason: 'bad_request' };
      }
      if (!task) return { ok: false, reason: 'not_found' };
      if (task.done) return { ok: false, reason: 'closed' };
      if (task.kind === 'inbox' || !task.due) return { ok: false, reason: 'not_due' };
      if (task.agent?.status !== 'delegated') return { ok: false, reason: 'not_delegated' };
      if (datePart(task.due) > req.today) return { ok: false, reason: 'not_due' };
      const agent = { status: 'in_progress', claimedAt: now, finishedAt: null, claimToken: req.token, at: nextAt(task.agent.at, now) };
      return { ok: true, task: { ...task, agent } };
    }
    case 'finish': {
      if (!FINISH_STATUSES.includes(req.status)) return { ok: false, reason: 'bad_status' };
      if (!nonEmpty(req.text)) return { ok: false, reason: 'bad_request' };
      if (!task) return { ok: false, reason: 'not_found' };
      if (task.done) return { ok: false, reason: 'closed' };
      if (task.agent?.status !== 'in_progress') return { ok: false, reason: 'not_in_progress' };
      if (!nonEmpty(req.claimToken) || req.claimToken !== task.agent.claimToken) return { ok: false, reason: 'token_mismatch' };
      return finishWith(task, req.status, req.text, now, normalizeJournal(req.journal));
    }
    case 'reap': {
      if (!task) return { ok: false, reason: 'not_found' };
      if (task.agent?.status !== 'in_progress') return { ok: false, reason: 'not_in_progress' };
      const ttl = Number.isFinite(Number(req.ttlMs)) && req.ttlMs !== undefined ? Number(req.ttlMs) : LIMITS.TTL_MS;
      if (now - (Number(task.agent.claimedAt) || 0) < ttl) return { ok: false, reason: 'not_expired' };
      return finishWith(task, 'failed', 'TTL истёк', now, normalizeJournal(req.journal));
    }
    default:
      return { ok: false, reason: 'bad_request' };
  }
}

/** Очередь демона и просроченные in_progress из списка задач. */
export function buildQueue(tasks, { today, now }) {
  const queue = [];
  const stale = [];
  for (const t of tasks || []) {
    const status = t?.agent?.status;
    if (status === 'delegated' && isDelegable(t, today)) queue.push(t);
    else if (status === 'in_progress' && !t.done && now - (Number(t.agent.claimedAt) || 0) >= LIMITS.TTL_MS) stale.push(t);
  }
  queue.sort((a, b) =>
    (datePart(a.due) < datePart(b.due) ? -1 : datePart(a.due) > datePart(b.due) ? 1 : 0)
    || (atOf(a.agent) - atOf(b.agent))
    || ((a.priority || 4) - (b.priority || 4)));
  return { queue, stale };
}
