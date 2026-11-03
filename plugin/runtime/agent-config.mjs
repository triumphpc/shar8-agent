// agent.json v1 (M8, ADR-017 п. 5): единственный способ расширить агента. Схема строгая и после выпуска не
// ужесточается: всё необъявленное — ошибка (код 78, `claude` не запускается). Результат — значение, не исключение;
// `assertAgentConfig` превращает отказ в ConfigError. В сообщениях и результате только код и ПУТЬ первого
// нарушения (имена полей и индексы), значений из файла нет.
//
// Про Glob и Grep: поведение этих инструментов за пределами песочницы НЕ проверено (S-GLOB: unverified; живая
// проверка была только для Read). Раннер пишет deny Read(...) и blockReadsOutsideWorkingDirectories, но на
// Glob/Grep это не гарантия: в документации и README этого не обещать.

import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { delimiter as hostDelimiter, isAbsolute, join } from 'node:path';

export const FILE_MAX_BYTES = 64 * 1024;
export const ARRAY_MAX = 200;
export const STRING_MAX = 200;
/** Разрешённые встроенные инструменты; всё остальное — forbidden_tool (Bash читает env-файл с PAT, curl уходит мимо gate). */
export const ALLOWED_BUILTIN = Object.freeze(['Read', 'Glob', 'Grep']);
export const KEYS = Object.freeze(['version', 'mcpServers', 'tools', 'allowedTools']);

const TOOL_RE = /^mcp__[A-Za-z0-9_-]{1,64}__[A-Za-z0-9_.-]{1,128}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const SERVER_CHARS_RE = /^[A-Za-z0-9_-]+$/;
const UNEXPANDED_VAR = /\$\{(?![^}]*:-)[^}]*\}/;

/** Как делает Claude Code в mcp__<сервер>__<инструмент>. */
export const normalizeServerName = (raw) => raw.replace(/[^A-Za-z0-9_-]/g, '_');

/** Ошибка конфигурации: код выхода 78. Сообщение — только код и путь. */
export class ConfigError extends Error {
  constructor(reason, path = []) {
    super(`agent_config: ${reason}${path.length ? ` at ${path.join('.')}` : ''}`);
    this.name = 'ConfigError';
    this.code = 'config_error';
    this.exitCode = 78;
    this.reason = reason;
    this.path = path;
  }
}

/** @returns {object} config; бросает ConfigError на отказе loadAgentConfig */
export function assertAgentConfig(result) {
  if (result?.ok === true) return result.config;
  throw new ConfigError(result?.code ?? 'json', result?.path ?? []);
}

const emptyConfig = () => ({ mcpServers: [], tools: [], allowedTools: [], servers: {} });
const bad = (code, path = []) => ({ ok: false, code, path: path.map(String) });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function defaultExists(p, platform) {
  try {
    if (!statSync(p).isFile()) return false;
    if (platform !== 'win32') accessSync(p, constants.X_OK);
    return true;
  } catch { return false; }
}

function envGet(env, name, platform) {
  if (platform !== 'win32') return env?.[name];
  const key = Object.keys(env ?? {}).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** Команда stdio-сервера находима в PATH раннера (а не терминала пользователя) или задана путём. */
function commandFound(command, { env, platform, exists }) {
  const win = platform === 'win32';
  const sep = win ? ';' : (platform === 'linux' || platform === 'darwin' ? ':' : hostDelimiter);
  const exts = win ? ['', ...String(envGet(env, 'PATHEXT', platform) ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)] : [''];
  const variants = (base) => exts.map((e) => base + e);
  if (isAbsolute(command) || /[\\/]/.test(command)) return variants(command).some((p) => exists(p, platform));
  const dirs = String(envGet(env, 'PATH', platform) ?? '').split(sep).filter(Boolean);
  return dirs.some((d) => variants(join(d, command)).some((p) => exists(p, platform)));
}

function hasUnexpandedVar(value) {
  if (typeof value === 'string') return UNEXPANDED_VAR.test(value);
  if (Array.isArray(value)) return value.some(hasUnexpandedVar);
  if (isObject(value)) return Object.values(value).some(hasUnexpandedVar);
  return false;
}

function serverUsable(desc, ctx) {
  if (hasUnexpandedVar(desc)) return false;
  const type = desc.type ?? (typeof desc.command === 'string' ? 'stdio' : undefined);
  if (type === 'stdio') return typeof desc.command === 'string' && desc.command !== '' && commandFound(desc.command, ctx);
  if (type === 'http' || type === 'sse') return typeof desc.url === 'string' && desc.url !== '';
  return false;
}

/** Массив строк с проверкой типа и размера. @returns {null|{code,path}} */
function checkList(doc, key) {
  const v = doc[key];
  if (v === undefined) return null;
  if (!Array.isArray(v)) return bad('type', [key]);
  if (v.length > ARRAY_MAX) return bad('size', [key]);
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] !== 'string') return bad('type', [key, i]);
    if (v[i].length > STRING_MAX) return bad('size', [key, i]);
  }
  return null;
}

/** Имя в allowedTools -> код отказа формы или null. */
function allowedFormError(t) {
  if (t.includes('*')) return 'prefix_forbidden';
  if (!t.startsWith('mcp__')) return 'bad_allowed_tool';
  if (TOOL_RE.test(t)) return null;
  return SERVER_CHARS_RE.test(t.slice(5)) ? 'prefix_forbidden' : 'bad_allowed_tool';
}

/**
 * @param {{file:string, userMcp?:object, sendTools?:string[], env?:object, platform?:string, exists?:Function, readFile?:Function}} p
 *   userMcp: разобранное содержимое user-scope `.claude.json` (объект с `mcpServers`); sendTools: полные имена
 *   send-инструментов из политики (источник — sendToolNames(policy), T11)
 * @returns {{ok:true, config:{mcpServers:string[], tools:string[], allowedTools:string[], servers:Record<string,object>}}
 *          |{ok:false, code:string, path:string[]}}
 */
export function loadAgentConfig({ file, userMcp, sendTools = [], env = process.env, platform = process.platform, exists = defaultExists, readFile = readFileSync } = {}) {
  let buf;
  try { buf = readFile(file); } catch (err) {
    return err?.code === 'ENOENT' ? { ok: true, config: emptyConfig() } : bad('json');
  }
  if (Buffer.byteLength(buf) > FILE_MAX_BYTES) return bad('size');
  let doc;
  try { doc = JSON.parse(String(buf)); } catch { return bad('json'); }
  if (!isObject(doc)) return bad('json');
  if (doc.version !== 1) return bad('version', ['version']);
  const unknown = Object.keys(doc).find((k) => !KEYS.includes(k));
  if (unknown !== undefined) return bad('unknown_key', [unknown]);
  for (const key of ['mcpServers', 'tools', 'allowedTools']) {
    const e = checkList(doc, key);
    if (e) return e;
  }
  const sendSet = new Set(Array.isArray(sendTools) ? sendTools : []);
  const tools = [...new Set(doc.tools ?? [])];
  for (let i = 0; i < (doc.tools ?? []).length; i++) {
    const t = doc.tools[i];
    if (!ALLOWED_BUILTIN.includes(t)) return bad('forbidden_tool', ['tools', i]);
    if (sendSet.has(t)) return bad('send_tool_listed', ['tools', i]);
  }
  const mcpServers = [...new Set(doc.mcpServers ?? [])];
  const byName = new Map();
  for (let i = 0; i < (doc.mcpServers ?? []).length; i++) {
    const raw = doc.mcpServers[i];
    const norm = normalizeServerName(raw);
    if (byName.has(norm) && byName.get(norm) !== raw) return bad('server_name_collision', ['mcpServers', i]);
    byName.set(norm, raw);
  }
  const declared = [...byName.keys()];
  const allowedTools = [...new Set(doc.allowedTools ?? [])];
  for (let i = 0; i < (doc.allowedTools ?? []).length; i++) {
    const t = doc.allowedTools[i];
    const form = allowedFormError(t);
    if (form) return bad(form, ['allowedTools', i]);
    const owner = declared.some((n) => t.startsWith(`mcp__${n}__`) && TOOL_NAME_RE.test(t.slice(`mcp__${n}__`.length)));
    if (!owner) return bad('server_not_declared', ['allowedTools', i]);
    if (sendSet.has(t)) return bad('send_tool_listed', ['allowedTools', i]);
  }
  const user = isObject(userMcp?.mcpServers) ? userMcp.mcpServers : {};
  const servers = {};
  for (let i = 0; i < mcpServers.length; i++) {
    const raw = mcpServers[i];
    if (!Object.hasOwn(user, raw) || !isObject(user[raw])) return bad('server_not_found', ['mcpServers', i]);
    servers[raw] = JSON.parse(JSON.stringify(user[raw]));
  }
  for (let i = 0; i < mcpServers.length; i++) {
    if (!serverUsable(servers[mcpServers[i]], { env, platform, exists })) return bad('server_unusable', ['mcpServers', i]);
  }
  return { ok: true, config: { mcpServers, tools, allowedTools, servers } };
}
