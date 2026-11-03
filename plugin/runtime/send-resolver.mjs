// Чистый резолвер привязок send-policy v2 (M9, ADR-018): по политике решает, можно ли вызов инструмента.
// Побочных эффектов нет, исключения наружу не выходят (любой сбой разбора = отказ). Слоты не берёт: это делает gate (send-slots.mjs).
// Значения адресатов и текстов в причину отказа не попадают.

import { SEND_LIMITS } from './limits.mjs';

/** @typedef {'undeclared_tool'|'undeclared_field'|'type'|'target_missing'|'not_allowed'|'quick_action'|'macro'|'control_chars'|'text_missing'|'field_missing'} DenyReason */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.hasOwn(o, k);

const getPath = (obj, path) => {
  let cur = obj;
  for (const key of path) {
    if (!isObj(cur) && !Array.isArray(cur)) return { found: false };
    if (!Object.hasOwn(cur, key)) return { found: false };
    cur = cur[key];
  }
  return { found: true, value: cur };
};

// Адресаты: любые C0 и DEL. Тексты: C0 кроме \t \n \r. Включено всегда.
// eslint-disable-next-line no-control-regex
const CONTROL_TARGET = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// Построчно (линейное время): класс с \s внутри многострочного ^ давал квадрат на «\n»×N.
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;
const ANY_SLASH_LINE = /^[\s\p{Cc}\p{Cf}]*\//u;
const GITLAB_QUICK_LINE = /^[\s\p{Cc}\p{Cf}]*\/[a-z_]/iu;
const anyLine = (text, re) => text.split(LINE_BREAK).some((l) => re.test(l));

// Макросы Confluence, исполняющие произвольный HTML или подтягивающие чужое: тег режется до ближайшего «>» и
// проверяется один раз, следующий поиск идёт после него (незакрытые «<ac:structured-macro » не дают квадрата).
const MACRO_START = /<ac:structured-macro\b/gi;
const MACRO_TAG = /^<ac:structured-macro\b[^>]*\b(?:ac:)?name\s*=\s*(["'])\s*(?:html|iframe|include|html-include)\s*\1/i;
function hasDangerousMacro(text) {
  MACRO_START.lastIndex = 0;
  let m;
  while ((m = MACRO_START.exec(text)) !== null) {
    const end = text.indexOf('>', m.index);
    if (MACRO_TAG.test(end === -1 ? text.slice(m.index) : text.slice(m.index, end))) return true;
    if (end === -1) return false;
    MACRO_START.lastIndex = end;
  }
  return false;
}

// Извлекатели: закрытый набор кода, пользовательских регулярок нет.
const JIRA_KEY = /^([A-Z][A-Z0-9_]*)-[0-9]+$/;
const DISPLAY_OK = /^[\p{L}\p{N} .'\-]*$/u;
const EMAIL_DISPLAY = /^([^<>]*)<([^<>]+)>\s*$/;
const EXTRACT = Object.freeze({
  identity: (s) => s,
  jira_project_from_key: (s) => JIRA_KEY.exec(s)?.[1] ?? null,
  // SEC01: значение разбирается целиком. Допустимы голый адрес или `Имя <адрес>`; запятая, `;`, `:`, кавычка и второй `@` отвергаются.
  email_address: (s) => {
    const m = EMAIL_DISPLAY.exec(s);
    let addr;
    if (m) {
      if (!DISPLAY_OK.test(m[1]) || m[1].includes('=?')) return null;   // SEC01-R1: имя — буквы, цифры, пробел, `.`, `'`, `-`; MIME-кодирование `=?` запрещено
      addr = m[2];
    } else addr = s;
    if (!/^[\x21-\x7e]+$/.test(addr) || /[,;:"<>]/.test(addr)) return null;   // SEC01-R2: только печатный ASCII (нет Кельвина и подобных при toLowerCase)
    return /^[^@]+@[^@]+$/.test(addr) ? addr.toLowerCase() : null;
  },
});

/** SEC02: вдоль объявленных путей глубиной > 1 каждый объект-контейнер несёт только объявленные ключи (например message.bcc при пути ['message','to']). */
function nestedKeysDeclared(input, paths) {
  const tree = Object.create(null);
  for (const p of paths) { let n = tree; for (const k of p) n = (n[k] ??= Object.create(null)); }   // SEC02-R2: без прототипа
  const walk = (value, node) => {
    const keys = Object.keys(node);
    if (keys.length === 0) return true;
    if (!isObj(value)) return false;                 // SEC02-R1: у узла есть дочерние пути, а значение не объект
    for (const k of Object.keys(value)) if (!own(node, k)) return false;
    return keys.every((k) => !own(value, k) || walk(value[k], node[k]));
  };
  return walk(input, tree);
}

/** Значение адресата: строка, безопасное целое >= 0 (к строке) или непустой массив таких. */
function scalarTargets(value) {
  const one = (v) => (typeof v === 'string' ? (v === '' ? null : v) : typeof v === 'number' ? (Number.isSafeInteger(v) && v >= 0 ? String(v) : null) : null);
  if (Array.isArray(value)) {
    if (value.length === 0) return 'empty';
    const out = value.map(one);
    return out.some((v) => v === null) ? 'type' : out;
  }
  const s = one(value);
  return s === null ? 'type' : [s];
}

/**
 * Чистая проверка вызова по политике.
 * @param {{tools:object, allow:object}} policy результат validatePolicy
 * @returns {{ok:true, call:{slot:string, list:string, targets:string[], texts:string[]}}|{ok:false, reason:DenyReason}}
 */
export function resolveCall(policy, toolName, toolInput) {
  try {
    if (typeof toolName !== 'string' || !isObj(policy?.tools) || !own(policy.tools, toolName)) return { ok: false, reason: 'undeclared_tool' };
    const t = policy.tools[toolName];
    if (!isObj(toolInput)) return { ok: false, reason: 'type' };
    // Закрытый список входов: любой необъявленный ключ верхнего уровня (например bcc) отклоняется.
    const declared = new Set([...t.target, ...t.text].map((p) => p[0]).concat(t.fields));
    for (const k of Object.keys(toolInput)) if (!declared.has(k)) return { ok: false, reason: 'undeclared_field' };
    if (!nestedKeysDeclared(toolInput, [...t.target, ...t.text, ...t.fields.map((f) => [f])])) return { ok: false, reason: 'undeclared_field' };   // SEC02
    const targets = [];
    let any = false;
    for (const path of t.target) {
      const g = getPath(toolInput, path);
      if (!g.found) continue;
      any = true;
      const vals = scalarTargets(g.value);
      if (vals === 'empty') return { ok: false, reason: 'target_missing' };
      if (vals === 'type') return { ok: false, reason: 'type' };
      for (const v of vals) {
        if (CONTROL_TARGET.test(v)) return { ok: false, reason: 'control_chars' };
        const x = EXTRACT[t.extract](v);
        if (x === null || x === undefined) return { ok: false, reason: 'not_allowed' };
        targets.push(x);
      }
    }
    if (!any) return { ok: false, reason: 'target_missing' };
    const allowed = policy.allow?.[t.list];
    if (!Array.isArray(allowed)) return { ok: false, reason: 'not_allowed' };
    if (!targets.every((x) => allowed.includes(x))) return { ok: false, reason: 'not_allowed' };   // точное сравнение
    for (const f of t.fields) {
      if (!own(toolInput, f)) {
        if (t.required.includes(f)) return { ok: false, reason: 'field_missing' };
        continue;
      }
      const v = toolInput[f];
      if (!(typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))) return { ok: false, reason: 'type' };
      if (v === '' && t.required.includes(f)) return { ok: false, reason: 'field_missing' };
      if (t.posint.includes(f) && !(Number.isSafeInteger(v) && v >= 1)) return { ok: false, reason: 'type' };
    }
    const texts = [];
    for (const path of t.text) {
      const g = getPath(toolInput, path);
      if (!g.found) return { ok: false, reason: 'text_missing' };               // тексты обязательны и непусты
      if (typeof g.value !== 'string') return { ok: false, reason: 'type' };
      if (g.value.trim() === '') return { ok: false, reason: 'text_missing' };
      texts.push(g.value);
    }
    for (const s of texts) {
      if (CONTROL_TEXT.test(s)) return { ok: false, reason: 'control_chars' };
      if (t.lineLeadingSlash && anyLine(s, ANY_SLASH_LINE)) return { ok: false, reason: 'quick_action' };
      if (t.checks.includes('gitlab_quick_action') && anyLine(s, GITLAB_QUICK_LINE)) return { ok: false, reason: 'quick_action' };
      if (t.checks.includes('confluence_macro') && hasDangerousMacro(s)) return { ok: false, reason: 'macro' };
    }
    return { ok: true, call: { slot: t.slot, list: t.list, targets, texts } };
  } catch {
    return { ok: false, reason: 'type' };
  }
}

/** Слоты прогона в памяти: эталон семантики для gate (там слоты — файлы, send-slots.mjs). Общий потолок — SEND_TOTAL_MAX из кода. */
export function createRunState() { return { slots: Object.create(null), total: 0 }; }

/** Решение с учётом слотов: сначала resolveCall, затем потолок слота, затем общий потолок. Меняет state только при allow. */
export function decide(policy, state, toolName, toolInput) {
  const r = resolveCall(policy, toolName, toolInput);
  if (!r.ok) return { decision: 'deny', reason: r.reason };
  const used = state.slots[r.call.slot] ?? 0;
  if (used >= (policy.limits?.[r.call.slot] ?? 0)) return { decision: 'deny', reason: 'slot_limit' };
  if (state.total >= SEND_LIMITS.SEND_TOTAL_MAX) return { decision: 'deny', reason: 'total_limit' };
  state.slots[r.call.slot] = used + 1;
  state.total += 1;
  return { decision: 'allow', call: r.call };
}
