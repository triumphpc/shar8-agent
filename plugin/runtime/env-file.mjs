// Env-файл (DD-3): строки `KEY=VALUE`, без оболочки, без кавычек, значение до конца строки.
// Читает раннер; токен живёт только здесь и в HTTP-заголовке: ни в argv, ни в текстах ошибок (C3).

import { readFile } from 'node:fs/promises';
import { createPerm } from './platform/perm.mjs';

export const ENV_KEYS = Object.freeze(['TASKFLOW_MCP_URL', 'TASKFLOW_MCP_TOKEN', 'SHAR8_MODEL_MODE', 'ANTHROPIC_API_KEY', 'CLAUDE_BIN']);
export const REQUIRED_ENV = Object.freeze(['TASKFLOW_MCP_URL', 'TASKFLOW_MCP_TOKEN']);
const KEY_SET = new Set(ENV_KEYS);
const LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Разбор текста. Ошибки называют ключ или номер строки, но не значение.
 * @returns {{ok:true, env:Record<string,string>, unknown:string[]}|{ok:false, reason:'format'|'missing_key', key?:string, line?:number}}
 */
export function parseEnvFile(text) {
  const env = {};
  const unknown = [];
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    const m = LINE.exec(raw);
    if (!m) return { ok: false, reason: 'format', line: i + 1 };
    const [, key, value] = m;
    if (!KEY_SET.has(key)) { unknown.push(key); continue; }   // событие env_unknown_key: имя, не значение
    env[key] = value;
  }
  for (const key of REQUIRED_ENV) {
    if (!env[key]) return { ok: false, reason: 'missing_key', key };
  }
  return { ok: true, env, unknown };
}

/** @returns {Promise<{ok:true, env, unknown}|{ok:false, reason:'missing'|'mode'|'owner'|'acl'|'unverifiable'|'format'|'missing_key', key?:string}>} */
export async function loadEnvFile(file, { perm = createPerm() } = {}) {
  const check = await perm.checkSecretFile(file, { requireOwner: true });
  if (!check.ok) {
    // not_file, symlink, size — не права, а негодный файл: для вызывающего это формат.
    return { ok: false, reason: ['missing', 'mode', 'owner', 'acl', 'unverifiable'].includes(check.reason) ? check.reason : 'format' };
  }
  let text;
  try { text = await readFile(file, 'utf8'); } catch { return { ok: false, reason: 'missing' }; }
  return parseEnvFile(text);
}

/**
 * Текст env-файла для install. Значение с переводом строки или NUL недопустимо (формат построчный).
 * Порядок ключей фиксирован; пустые значения опускаются.
 */
export function serializeEnvFile(values) {
  const lines = [];
  for (const key of ENV_KEYS) {
    const v = values[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || /[\r\n\0]/.test(v)) throw new TypeError(`env value for ${key} is not a single-line string`);
    lines.push(`${key}=${v}`);
  }
  for (const key of Object.keys(values)) if (!KEY_SET.has(key)) throw new TypeError(`unknown env key: ${key}`);
  return `${lines.join('\n')}\n`;
}

/** Атомарная запись с правами 0600 / ACL по SID через perm. */
export async function writeEnvFile(file, values, { perm = createPerm() } = {}) {
  await perm.writeSecretFile(file, serializeEnvFile(values));
}
