// Разбор вывода `claude`: parseStream (stream-json, DD-14).
// Результат — {status, text, costUsd}. Все сбои становятся failed
// с короткой причиной: демон сам ничего не додумывает и не повторяет.

const VALID = ['review', 'needs_info', 'failed'];

function parseResultText(result) {
  const text = String(result ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(text); } catch { /* ищем объект внутри */ }
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

// ---------------- DD-14: stream-json ----------------

const ERROR_TEXT_MAX = 500;

function readEvents(stdout) {
  const events = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { const e = JSON.parse(t); if (e && typeof e === 'object') events.push(e); } catch { /* оборванная или чужая строка */ }
  }
  return events;
}

/**
 * Разбор stdout `claude -p --output-format stream-json --verbose`: события system/init (первое), assistant, result (последнее).
 * Контракт итогового JSON: `{status: review|needs_info|failed, text}`.
 * `errorText` — начало текста result при ошибке (не больше 500 символов, НЕ вычищено от секретов): вход для
 * классификатора env-check, в журнал и задачу не идёт. `subtype` — как в result (`error_max_turns`: лимит ходов сработал).
 * @param {string} stdout
 * @param {{code?: number|null, signal?: string|null}} [exit]
 * @returns {{status:'review'|'needs_info'|'failed', text:string, costUsd:number|null, numTurns:number, init:object|null, isError:boolean, hasAssistant:boolean, subtype:string|null, errorText:string}}
 */
export function parseStream(stdout, { code, signal } = {}) {
  const events = readEvents(stdout);
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init') ?? null;
  const assistants = events.filter((e) => e.type === 'assistant').length;
  const result = [...events].reverse().find((e) => e.type === 'result') ?? null;
  const base = { init, hasAssistant: assistants > 0, subtype: null, errorText: '' };
  if (!result) {
    const text = code !== 0 && code !== undefined ? `claude завершился с кодом ${code ?? signal ?? 'неизвестно'}` : 'Некорректный вывод claude';
    return { status: 'failed', text, costUsd: null, numTurns: assistants, isError: true, ...base };
  }
  const costUsd = typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null;
  const numTurns = typeof result.num_turns === 'number' ? result.num_turns : assistants;
  const subtype = typeof result.subtype === 'string' ? result.subtype : null;
  const fin = (status, text, isError, errorText = '') => ({ status, text, costUsd, numTurns, isError, ...base, subtype, errorText });
  if (subtype === 'error_max_turns') return fin('failed', 'Исчерпан лимит ходов', true);
  if (subtype === 'error_max_budget_usd') return fin('failed', 'Исчерпан бюджет', true);
  if (result.is_error === true) {
    const raw = String(result.result ?? '');
    return fin('failed', `Ошибка агента: ${raw.replace(/\s+/g, ' ').trim().slice(0, 120)}`, true, raw.slice(0, ERROR_TEXT_MAX));
  }
  const obj = parseResultText(result.result);
  const ok = obj && typeof obj === 'object' && VALID.includes(obj.status) && typeof obj.text === 'string' && obj.text.trim() !== '';
  if (!ok) return fin('failed', 'Агент вернул ответ неверного формата', false);
  return fin(obj.status, obj.text, false);
}
