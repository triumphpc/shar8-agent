// Проверка окружения (M7, FR-D09, FR-D17): до claim, без модели (`checkEnvironment`), и разбор отказа после claim
// (`classifyFailure`, данные в env-signatures.json). Здесь только классы и тексты причин; паузы ставит раннер.
// Секреты в detail и в тексты причин не попадают: detail — короткие коды, тексты причин фиксированные.

import { accessSync, constants as fsConstants, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { buildChildEnv } from './platform/env-allow.mjs';
import { createProc } from './platform/proc.mjs';

export const MIN_NODE_MAJOR = 20;
export const MIN_CLAUDE_VERSION = '2.1.308';
/** Режимы работы модели (SHAR8_MODEL_MODE): вход claude.ai либо ключ API. */
export const MODEL_MODES = Object.freeze(['subscription', 'key']);
export const MODE_ENV = 'SHAR8_MODEL_MODE';

/** Классы, которые видны при проверке до claim. */
export const CHECK_CLASSES = Object.freeze(['node_too_old', 'claude_missing', 'claude_too_old', 'claude_unrunnable', 'not_logged_in', 'key_missing', 'mode_mismatch']);
/** Классы ошибок окружения после claim (в том числе из launchClaude: isolation_drift). */
export const FAILURE_CLASSES = Object.freeze(['subscription_limit', 'credit_exhausted', 'auth_failed', 'claude_crashed', 'claude_not_found', 'claude_unrunnable', 'mcp_server_failed', 'isolation_drift']);
export const ENV_CLASSES = new Set([...CHECK_CLASSES, ...FAILURE_CLASSES]);

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// ---------------- сигнатуры ----------------

let cache = null;

/** Загрузка и проверка формы env-signatures.json (лениво, один раз). */
export function loadSignatures(file = new URL('./env-signatures.json', import.meta.url)) {
  if (file instanceof URL && cache) return cache;
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  if (!isObj(doc) || doc.v !== 1 || !Array.isArray(doc.signatures)) throw new TypeError('env-signatures.json: bad shape');
  const list = doc.signatures.map((s) => {
    if (!isObj(s) || typeof s.id !== 'string' || typeof s.class !== 'string' || !['result', 'stderr', 'auth_status', 'exit'].includes(s.where)) throw new TypeError(`env-signatures.json: bad entry ${s?.id}`);
    if (!['reproduced', 'unverified'].includes(s.status) || typeof s.source !== 'string' || s.source === '') throw new TypeError(`env-signatures.json: no source/status in ${s.id}`);
    if (s.pattern !== null && typeof s.pattern !== 'string') throw new TypeError(`env-signatures.json: bad pattern in ${s.id}`);
    return { ...s, re: s.pattern === null ? null : new RegExp(s.pattern, /^[i]*$/.test(s.flags || '') ? s.flags : '') };
  });
  const out = Object.freeze(list);
  if (file instanceof URL) cache = out;
  return out;
}

const TEXT_CAP = 16_384;

/** Первая подходящая сигнатура с текстом (result | stderr | auth_status) или null. */
export function matchSignature(where, text, signatures = loadSignatures()) {
  const t = String(text ?? '').slice(0, TEXT_CAP);
  return signatures.find((s) => s.where === where && s.re && s.re.test(t)) ?? null;
}

// ---------------- разбор вывода claude ----------------

/** События из stdout: один JSON (объект или массив) либо JSON-строки stream-json. */
export function parseEvents(stdout) {
  const raw = String(stdout ?? '').trim();
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return (Array.isArray(v) ? v : [v]).filter(isObj);
  } catch { /* построчно */ }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    try { const v = JSON.parse(line); if (isObj(v)) out.push(v); } catch { /* не JSON */ }
  }
  return out;
}

/**
 * Класс ошибки окружения после запуска claude либо null (обычный отказ модели остаётся обычным failed).
 * `parsed` необязателен (isError, numTurns от parseStream T09); без него поля читаются из сырого stdout.
 * @returns {null|'subscription_limit'|'credit_exhausted'|'auth_failed'|'claude_crashed'|'claude_not_found'|'claude_unrunnable'|'mcp_server_failed'}
 */
export function classifyFailure({ parsed, stdout, stderrTail, code, signal, spawnError } = {}) {
  if (spawnError) return spawnError.code === 'ENOENT' ? 'claude_not_found' : 'claude_unrunnable';
  const events = parseEvents(stdout);
  const result = [...events].reverse().find((e) => e.type === 'result');
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  if (init && Array.isArray(init.mcp_servers) && init.mcp_servers.some((m) => isObj(m) && m.status === 'failed')) return 'mcp_server_failed';
  const assistant = events.some((e) => e.type === 'assistant');
  const numTurns = Number.isFinite(parsed?.numTurns) ? parsed.numTurns : result?.num_turns;
  const noTurns = Number.isFinite(numTurns) ? numTurns === 0 : !assistant;
  const isError = parsed?.isError ?? result?.is_error;
  const stderr = String(stderrTail ?? '');
  if (result) {
    if (isError !== true || !noTurns) return null;
    const hit = matchSignature('result', result.result) ?? matchSignature('stderr', stderr);
    return hit ? hit.class : null;
  }
  const abnormal = (Number.isInteger(code) && code !== 0) || (code === null && typeof signal === 'string');
  if (!abnormal || assistant) return null;
  return matchSignature('stderr', stderr)?.class ?? 'claude_crashed';
}

const REASONS = {
  subscription_limit: 'Лимит подписки Claude исчерпан',
  credit_exhausted: 'Баланс API исчерпан',
  auth_failed: 'Claude не авторизован: нужен вход или ключ',
  mcp_server_failed: 'MCP-сервер не запустился',
  isolation_drift: 'Изоляция запуска не подтверждена: init не совпал с эталоном',
  node_too_old: 'Версия Node ниже 20',
  claude_missing: 'claude не найден',
  claude_too_old: `Версия claude ниже ${MIN_CLAUDE_VERSION}`,
  not_logged_in: 'В claude нет входа',
  key_missing: 'Не задан ключ API',
  mode_mismatch: 'Режим модели не совпадает со входом claude',
};

/** Честная причина одной строкой для agent_finish и журнала; без вывода claude и без секретов. */
export function failureReason(cls, { code, signal, spawnError } = {}) {
  if (cls === 'claude_not_found' || cls === 'claude_unrunnable') {
    return `Не удалось запустить claude: ${String(spawnError?.code || 'ошибка').replace(/[^A-Za-z0-9_]/g, '').slice(0, 24) || 'ошибка'}`;
  }
  if (cls === 'claude_crashed') return `claude упал до первого хода (${Number.isInteger(code) ? `код ${code}` : `сигнал ${String(signal || 'неизвестен').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16)}`})`;
  return REASONS[cls] ?? 'Ошибка окружения';
}

// ---------------- версии и ключ claude ----------------

/** realpath|size|mtimeMs: ключ кэша версии и привязка записи isolation к конкретной сборке claude. */
export function claudeKeyOf(path, { fs = { realpathSync, statSync } } = {}) {
  try {
    const real = fs.realpathSync(path);
    const st = fs.statSync(real);
    return `${real}|${st.size}|${st.mtimeMs}`;
  } catch { return null; }
}

export function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function versionAtLeast(version, min) {
  const a = parseVersion(version);
  const b = parseVersion(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/** Путь к claude: CLAUDE_BIN, затем путь из установки, затем PATH. null — не найден. */
export function resolveClaude({ claudeBin, installedPath, env = process.env, platform = process.platform, fs = { statSync } } = {}) {
  const usable = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  for (const p of [claudeBin, installedPath]) if (p && usable(p)) return p;
  const win = platform === 'win32';
  const pathVar = (win ? Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] : env.PATH) || '';
  const names = win ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const dir of pathVar.split(win ? ';' : delimiter)) {
    if (!dir) continue;
    for (const n of names) { const p = join(dir, n); if (usable(p)) return p; }
  }
  return null;
}

// ---------------- запуск утилиты ----------------

const OUT_CAP = 65_536;

/** Запуск короткой утилиты: { code, stdout, stderr }; бросает при невозможности запустить или по таймауту. Платформенный слой — через proc. */
export function defaultExec(file, args, { env, timeoutMs = 15_000, platform = process.platform, proc = createProc({ platform, env }) } = {}) {
  return new Promise((resolve, reject) => {
    let h;
    try { h = proc.spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (err) { reject(err); return; }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    h.child.stdout?.on('data', (d) => { if (stdout.length < OUT_CAP) stdout += d.toString('utf8'); });
    h.child.stderr?.on('data', (d) => { if (stderr.length < OUT_CAP) stderr += d.toString('utf8'); });
    const timer = setTimeout(() => { timedOut = true; proc.stopTree(h, 1000).catch(() => {}); }, timeoutMs);
    h.exited.then(({ code, error }) => {
      clearTimeout(timer);
      if (error) { reject(error); return; }
      if (timedOut) { reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); return; }
      resolve({ code, stdout, stderr });
    });
  });
}

const unrunnable = (detail) => ({ ok: false, class: 'claude_unrunnable', detail });

/** `claude auth status` -> { loggedIn, authMethod } (JSON по данным S-AUTH, фолбэк — текст «Not logged in»). */
export function parseAuthStatus({ code, stdout }) {
  const text = String(stdout ?? '').trim();
  let doc = null;
  try { doc = JSON.parse(text); } catch {
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a >= 0 && b > a) { try { doc = JSON.parse(text.slice(a, b + 1)); } catch { doc = null; } }
  }
  if (isObj(doc) && typeof doc.loggedIn === 'boolean') {
    return { loggedIn: doc.loggedIn, authMethod: typeof doc.authMethod === 'string' && doc.authMethod !== 'none' ? doc.authMethod : null };
  }
  if (matchSignature('auth_status', text)) return { loggedIn: false, authMethod: null };
  return { loggedIn: code === 0, authMethod: null };
}

/**
 * Проверка окружения между queue и claim (без модели).
 * @param {{mode?:string, claudePath?:string|null, env?:object, exec?:Function, versionCache?:{key:string,version:string}|null,
 *          nodeVersion?:string, platform?:string, fs?:object, now?:()=>number}} p
 * @returns {Promise<{ok:true, claudeVersion:string, authMethod:string|null, claudeKey:string|null, versionRecord?:object}|{ok:false, class:string, detail:string}>}
 */
export async function checkEnvironment({
  mode, claudePath, env = {}, exec = defaultExec, versionCache = null, nodeVersion = process.versions.node,
  platform = process.platform, fs = { accessSync, statSync, realpathSync }, now = Date.now,
} = {}) {
  if (Number(String(nodeVersion).split('.')[0]) < MIN_NODE_MAJOR) return { ok: false, class: 'node_too_old', detail: `node ${nodeVersion}` };
  if (!MODEL_MODES.includes(mode)) return { ok: false, class: 'mode_mismatch', detail: mode ? 'mode_invalid' : 'mode_missing' };
  if (typeof claudePath !== 'string' || claudePath === '') return { ok: false, class: 'claude_missing', detail: 'path_not_set' };
  try {
    if (!fs.statSync(claudePath).isFile()) return { ok: false, class: 'claude_missing', detail: 'not_a_file' };
  } catch { return { ok: false, class: 'claude_missing', detail: 'not_found' }; }
  if (platform !== 'win32') {
    try { fs.accessSync(claudePath, fsConstants.X_OK); } catch { return unrunnable('not_executable'); }
  }
  const claudeKey = claudeKeyOf(claudePath, { fs });
  const childEnv = buildChildEnv({ platform, env, mode });
  let version;
  let versionRecord;
  if (claudeKey && versionCache?.key === claudeKey && parseVersion(versionCache.version)) {
    version = versionCache.version;
  } else {
    let r;
    try { r = await exec(claudePath, ['--version'], { env: childEnv }); } catch (err) { return unrunnable(String(err?.code || 'exec_failed').slice(0, 24)); }
    const parsed = parseVersion(r?.stdout);
    if (r?.code !== 0 || !parsed) return unrunnable('version_unreadable');
    version = parsed.join('.');
    if (claudeKey) versionRecord = { key: claudeKey, version, checkedAt: new Date(now()).toISOString() };
  }
  if (!versionAtLeast(version, MIN_CLAUDE_VERSION)) return { ok: false, class: 'claude_too_old', detail: version };
  if (mode === 'key' && !(typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY !== '')) return { ok: false, class: 'key_missing', detail: 'api_key_empty' };
  let st;
  try { st = await exec(claudePath, ['auth', 'status'], { env: childEnv }); } catch (err) { return unrunnable(String(err?.code || 'exec_failed').slice(0, 24)); }
  const auth = parseAuthStatus(st ?? {});
  if (!auth.loggedIn) return { ok: false, class: 'not_logged_in', detail: mode };
  if (mode === 'subscription' && auth.authMethod === 'api_key') return { ok: false, class: 'mode_mismatch', detail: 'api_key_in_subscription_mode' };
  if (mode === 'key' && auth.authMethod && auth.authMethod !== 'api_key') return { ok: false, class: 'mode_mismatch', detail: 'login_in_key_mode' };
  return { ok: true, claudeVersion: version, authMethod: auth.authMethod, claudeKey, ...(versionRecord ? { versionRecord } : {}) };
}
