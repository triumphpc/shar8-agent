// Файл политики отправки v2 (M9, ADR-018): привязки «полное имя инструмента -> вид / поле адресата / поле текста»,
// закрытый список входов, потолки в коде (DD-6). По умолчанию политика пуста: отправка выключена (AC-034).
// Читается заново на каждом вызове, кеша нет. Любое отклонение даёт { ok:false, reason }: gate превращает его в deny
// (fail-closed). Значения списков нигде не печатаются и в результат отказа не попадают, только код и путь ключей.
// Права файла проверяет перм-слой (platform/perm.mjs), здесь он приходит параметром.

import { constants, promises as fsp } from 'node:fs';
import { SEND_LIMITS } from './limits.mjs';

export const POLICY_FILE_MAX_BYTES = 64 * 1024;
export const TOOL_MAX = 50;
export const LIST_MAX = 200;
export const STRING_MAX = 500;
const PATH_MAX = 8;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SLOT_RE = /^[a-z][a-z0-9_]{0,31}$/;
const nameOk = (s) => SLOT_RE.test(s) && !FORBIDDEN_KEYS.has(s);   // «constructor» и «prototype» подходят под SLOT_RE
const TOOL_RE = /^mcp__[A-Za-z0-9_-]{1,64}__[A-Za-z0-9_.-]{1,128}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
export const EXTRACTOR_NAMES = Object.freeze(['identity', 'jira_project_from_key', 'email_address']);
export const EXTRA_CHECKS = Object.freeze(['confluence_macro', 'gitlab_quick_action']);
const POLICY_KEYS = ['version', 'servers', 'tools', 'allow', 'limits'];
const TOOL_KEYS = ['slot', 'list', 'target', 'text', 'fields', 'required', 'posint', 'extract', 'checks', 'checks_off'];

/** @typedef {{ slot:string, list:string, target:string[][], text:string[][], fields:string[], required:string[], posint:string[], extract:string, checks:string[], lineLeadingSlash:boolean }} ToolBinding */
/** @typedef {{ tools:Record<string,ToolBinding>, allow:Record<string,string[]>, limits:Record<string,number>, servers:Record<string,string> }} SendPolicy */
/** @typedef {'missing'|'not_file'|'symlink'|'mode'|'owner'|'acl'|'unverifiable'|'size'|'json'|'version'|'shape'} PolicyReason */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.hasOwn(o, k);
const shape = (...path) => ({ ok: false, reason: 'shape', path });
const keyOk = (s) => typeof s === 'string' && s !== '' && s.length <= STRING_MAX && !FORBIDDEN_KEYS.has(s);

/** Нормализация имени сервера, как в Claude Code. */
export const normalizeServerName = (raw) => raw.replace(/[^A-Za-z0-9_-]/g, '_');
/** Коллизия двух разных сырых ключей с одним нормализованным именем: отправка закрыта. */
export function checkServerNames(rawKeys) {
  const seen = new Map();
  for (const raw of rawKeys) {
    const n = normalizeServerName(raw);
    if (seen.has(n) && seen.get(n) !== raw) return { ok: false, reason: 'server_name_collision' };
    seen.set(n, raw);
  }
  return { ok: true };
}

/** Пустая политика: ни одного инструмента, отправка закрыта. */
export function emptyPolicy() {
  return { tools: Object.create(null), allow: Object.create(null), limits: Object.create(null), servers: {} };
}

/** Полные имена инструментов, объявленных в политике (для проверки agent.json: send-инструмент не в tools/allowedTools). */
export function sendToolNames(policy) {
  return Object.keys(policy?.tools ?? {});
}

const pathsOk = (arr) => Array.isArray(arr) && arr.length <= LIST_MAX
  && arr.every((p) => Array.isArray(p) && p.length >= 1 && p.length <= PATH_MAX && p.every(keyOk));

/**
 * Проверка и нормализация документа. Чистая функция.
 * @returns {{ok:true, policy:SendPolicy, warnings:string[]}|{ok:false, reason:'shape'|'version', path:string[]}}
 */
export function validatePolicy(doc) {
  try {
    if (!isObj(doc)) return shape();
    if (doc.version !== 2) return { ok: false, reason: 'version', path: ['version'] };
    for (const k of Object.keys(doc)) if (!POLICY_KEYS.includes(k)) return shape(k);
    const tools = doc.tools ?? {}; const allow = doc.allow ?? {}; const limitsIn = doc.limits ?? {};
    if (!isObj(tools)) return shape('tools');
    if (!isObj(allow)) return shape('allow');
    if (!isObj(limitsIn)) return shape('limits');
    if (Object.keys(tools).length > TOOL_MAX) return shape('tools');
    let servers = {};
    if (doc.servers !== undefined) {
      if (!isObj(doc.servers)) return shape('servers');
      for (const [k, v] of Object.entries(doc.servers)) if (!keyOk(k) || !keyOk(v)) return shape('servers', k);
      if (!checkServerNames(Object.values(doc.servers)).ok) return shape('servers');
      servers = { ...doc.servers };
    }
    const outAllow = Object.create(null);
    for (const [name, list] of Object.entries(allow)) {
      if (!nameOk(name)) return shape('allow', name);
      if (!Array.isArray(list) || list.length > LIST_MAX
        || !list.every((v) => typeof v === 'string' && v !== '' && v.length <= STRING_MAX && !CONTROL_RE.test(v))) return shape('allow', name);
      outAllow[name] = [...list];
    }
    const warnings = []; const outTools = Object.create(null); const limits = Object.create(null);
    for (const [name, t] of Object.entries(tools)) {
      if (!TOOL_RE.test(name)) return shape('tools', name);
      if (!isObj(t)) return shape('tools', name);
      for (const k of Object.keys(t)) if (!TOOL_KEYS.includes(k)) return shape('tools', name, k);
      if (typeof t.slot !== 'string' || !nameOk(t.slot)) return shape('tools', name, 'slot');
      if (typeof t.list !== 'string' || !own(outAllow, t.list)) return shape('tools', name, 'list');
      if (!pathsOk(t.target) || t.target.length === 0) return shape('tools', name, 'target');
      if (!pathsOk(t.text) || t.text.length === 0) return shape('tools', name, 'text');   // пути текста обязательны и непусты
      const fields = t.fields ?? [];
      if (!Array.isArray(fields) || fields.length > LIST_MAX || !fields.every(keyOk)) return shape('tools', name, 'fields');
      const required = t.required ?? [];
      if (!Array.isArray(required) || !required.every((r) => fields.includes(r))) return shape('tools', name, 'required');
      const posint = t.posint ?? [];
      if (!Array.isArray(posint) || !posint.every((r) => fields.includes(r))) return shape('tools', name, 'posint');
      if (!EXTRACTOR_NAMES.includes(t.extract)) return shape('tools', name, 'extract');
      const checks = t.checks ?? []; const off = t.checks_off ?? [];
      if (!Array.isArray(checks) || !checks.every((c) => EXTRA_CHECKS.includes(c))) return shape('tools', name, 'checks');
      // control_chars включена всегда; отключить можно только line_leading_slash
      if (!Array.isArray(off) || !off.every((c) => c === 'line_leading_slash')) return shape('tools', name, 'checks_off');
      if (off.length) warnings.push('checks_off');
      outTools[name] = {
        slot: t.slot, list: t.list, target: t.target.map((p) => [...p]), text: t.text.map((p) => [...p]),
        fields: [...fields], required: [...required], posint: [...posint], extract: t.extract, checks: [...checks], lineLeadingSlash: off.length === 0,
      };
      if (!own(limitsIn, t.slot)) return shape('limits', t.slot);                  // слот без записи в limits: политика невалидна
    }
    for (const [slot, v] of Object.entries(limitsIn)) {
      if (!nameOk(slot)) return shape('limits', slot);
      if (!Number.isSafeInteger(v) || v < 1) return shape('limits', slot);
      limits[slot] = Math.min(v, SEND_LIMITS.SLOT_MAX);                            // поднять потолок файлом нельзя (DD-6)
    }
    return { ok: true, policy: { tools: outTools, allow: outAllow, limits, servers }, warnings };
  } catch { return shape(); }
}

const PERM_REASONS = new Set(['missing', 'not_file', 'symlink', 'mode', 'owner', 'acl', 'size', 'unverifiable']);

async function readBounded(file, platform) {
  let fh;
  try {
    // O_NOFOLLOW и O_NONBLOCK есть не везде (win32: undefined): тогда флаг просто не добавляется, права проверил perm.
    const flags = constants.O_RDONLY | (platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    fh = await fsp.open(file, flags);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { ok: false, reason: 'missing' };
    return { ok: false, reason: err?.code === 'ELOOP' ? 'symlink' : 'not_file' };
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { ok: false, reason: 'not_file' };
    // Размеру из stat не доверяем (файл мог вырасти между проверкой и чтением): читаем не больше предела + 1 байт.
    const buf = Buffer.alloc(POLICY_FILE_MAX_BYTES + 1);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, got);
      if (bytesRead <= 0) break;
      got += bytesRead;
    }
    if (got > POLICY_FILE_MAX_BYTES) return { ok: false, reason: 'size' };
    return { ok: true, text: buf.subarray(0, got).toString('utf8') };
  } catch {
    return { ok: false, reason: 'not_file' };
  } finally {
    try { await fh.close(); } catch { /* уже закрыт */ }
  }
}

/**
 * Загрузка политики v2. Права проверяет перм-слой; без него файл не читается (unverifiable).
 * @returns {Promise<{ok:true, policy:SendPolicy, warnings:string[]}|{ok:false, reason:PolicyReason, path?:string[]}>}
 */
export function loadSendPolicy(file, opts) {
  return loadV2(file, isObj(opts) ? opts : {});
}

async function loadV2(file, { perm, platform = process.platform }) {
  try {
    if (typeof perm?.checkSecretFile !== 'function') return { ok: false, reason: 'unverifiable' };
    let checked;
    try { checked = await perm.checkSecretFile(file); } catch { return { ok: false, reason: 'unverifiable' }; }
    if (!isObj(checked)) return { ok: false, reason: 'unverifiable' };
    if (checked.ok !== true) return { ok: false, reason: PERM_REASONS.has(checked.reason) ? checked.reason : 'unverifiable' };
    const r = await readBounded(file, platform);
    if (!r.ok) return r;
    let doc;
    try { doc = JSON.parse(r.text); } catch { return { ok: false, reason: 'json' }; }
    return validatePolicy(doc);
  } catch {
    return { ok: false, reason: 'unverifiable' };
  }
}

/** Для лога демона и команды policy, без значений: missing | invalid | empty | ok. */
export async function policyStateV2(file, opts) {
  const r = await loadV2(file, opts);
  if (!r.ok) return r.reason === 'missing' ? 'missing' : 'invalid';
  return Object.keys(r.policy.tools).length === 0 ? 'empty' : 'ok';
}
