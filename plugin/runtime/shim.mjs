#!/usr/bin/env node
// Shim: стабильное ядро расписания (M2, DD-1, C9). ОДИН файл, статические импорты только `node:*`: install копирует его как есть
// в ~/.config/shar8-agent/ (Windows: %LOCALAPPDATA%\shar8-agent\), юниты ОС ссылаются на загрузчик, а тот вызывает этот файл.
// Здесь: решение тика (liveness плагина), heartbeat, самолечение, три адаптера планировщика (launchd, systemd --user, schtasks),
// `status`, `uninstall`, `selftest`, карта путей. Раннера очереди и вызова модели здесь нет; токена тоже (env-файл читает раннер).
// Всё внешнее (fs, exec, spawn, часы) принимается параметром `deps`: настоящая реализация и подделка — один и тот же шов.
// Константы, которых нет в node:*, продублированы из limits.mjs / env-check.mjs / cli-constants.mjs; равенство закреплено тестами
// (pl-shim-selfheal, pl-constants): импортировать их сюда нельзя.

import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { delimiter, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHIM_VERSION = 1;            // сравнивается на РАВЕНСТВО с упакованным файлом (откат плагина откатывает и shim)
export const CONTRACT = 1;                // номер контракта shim -> раннер (необратим)
export const TEMPLATE_VERSION = 1;        // версия шаблонов юнитов; пишется в юнит, status сверяет
export const LAYOUT = 1;
export const APP_DIR = 'shar8-agent';
export const PLUGIN_KEY = 'shar8-agent@shar8';
/** Имена юнитов: часть публичного контракта (ADR-021), необратимо. */
export const NAMES = Object.freeze({ launchd: 'com.shar8.agent', legacyLaunchd: 'com.taskflow.delegation', systemd: 'shar8-agent', winTask: 'Shar8Agent' });
export const EXIT = Object.freeze({ OK: 0, FAILURE: 1, AUTH: 77, CONFIG: 78 });

const MIN = 60_000;
/** Пороги shim (дубль limits.mjs / env-check.mjs; тест закрепляет равенство). */
export const SHIM_LIMITS = Object.freeze({
  NODE_MIN_MAJOR: 20,
  CLAUDE_MIN_VERSION: '2.1.308',
  PROBE_REQUEST_MAX_MS: 10 * MIN,
  CLI_CHECK_MS: 6 * 60 * MIN,
  MISSING_CEILING_MS: 24 * 60 * MIN,
  UNREADABLE_CEILING_MS: 7 * 24 * 60 * MIN,
  LOG_MAX_BYTES: 1_048_576,
  BUILD_STALE_DAYS: 60,
  CLI_TIMEOUT_MS: 15_000,
});

/** Строки обновления и пути для status (дубль cli-constants.mjs; тест pl-constants закрепляет равенство). */
export const SHIM_COMMANDS = Object.freeze({
  marketplaceUpdate: 'claude plugin marketplace update shar8',
  pluginUpdate: 'claude plugin update shar8-agent@shar8',
  pluginInstallUser: 'claude plugin install shar8-agent@shar8 --scope user',
  install: { posix: 'node ~/.config/shar8-agent/shim.mjs', win32: 'node "%LOCALAPPDATA%\\shar8-agent\\shim.mjs"' },
});

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const errText = (e) => String(e?.message || e).slice(0, 160);
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- карта путей (DD-1: единственная реализация) ----------------

function winEnv(env, name) {
  const upper = name.toUpperCase();
  for (const [k, v] of Object.entries(env || {})) if (k.toUpperCase() === upper && typeof v === 'string' && v) return v;
  return undefined;
}

/**
 * Карта файлов на машине пользователя (design.md «Карта файлов», DD-2, ADR-020 п. 2). XDG_* не учитываются: путь попадает в FAQ.
 * @param {{platform?: string, home?: string, env?: Record<string,string|undefined>}} p
 */
export function pathsFor({ platform = process.platform, home, env = process.env } = {}) {
  if (typeof home !== 'string' || home === '') throw new TypeError('pathsFor: home is required');
  if (platform === 'win32') {
    const j = win32.join;
    const base = j(winEnv(env, 'LOCALAPPDATA') || j(home, 'AppData', 'Local'), APP_DIR);
    const stateDir = j(base, 'state');
    const logDir = j(base, 'logs');
    return {
      layout: LAYOUT, platform, home,
      configDir: base, stateDir, logDir, tickLog: j(logDir, 'tick.log'),
      envFile: j(base, 'env'), agentJson: j(base, 'agent.json'), sendPolicy: j(base, 'send-policy.json'),
      loader: j(base, 'launch.js'), loaderConf: j(base, 'loader.conf'), shim: j(base, 'shim.mjs'), shimPrev: j(base, 'shim.prev.mjs'),
      heartbeat: j(stateDir, 'heartbeat.json'), backoff: j(stateDir, 'backoff.json'), shimState: j(stateDir, 'shim-state.json'),
      probeRequest: j(stateDir, 'probe-request.json'), probeResult: j(stateDir, 'probe-result.json'),
      lockDir: j(stateDir, 'lock.d'), runsDir: j(stateDir, 'runs'), workDir: j(stateDir, 'work'),
      unit: { kind: 'schtasks', taskName: '\\Shar8Agent', xml: j(base, 'Shar8Agent.xml') },
    };
  }
  const j = posix.join;
  const configDir = j(home, '.config', APP_DIR);
  const stateDir = j(home, '.local', 'state', APP_DIR);
  const common = {
    layout: LAYOUT, platform, home,
    configDir, stateDir,
    envFile: j(configDir, 'env'), agentJson: j(configDir, 'agent.json'), sendPolicy: j(configDir, 'send-policy.json'),
    loader: j(configDir, 'tick.sh'), loaderConf: j(configDir, 'loader.conf'), shim: j(configDir, 'shim.mjs'), shimPrev: j(configDir, 'shim.prev.mjs'),
    heartbeat: j(stateDir, 'heartbeat.json'), backoff: j(stateDir, 'backoff.json'), shimState: j(stateDir, 'shim-state.json'),
    probeRequest: j(stateDir, 'probe-request.json'), probeResult: j(stateDir, 'probe-result.json'),
    lockDir: j(stateDir, 'lock.d'), runsDir: j(stateDir, 'runs'), workDir: j(stateDir, 'work'),
  };
  if (platform === 'darwin') {
    const logDir = j(home, 'Library', 'Logs', APP_DIR);
    return { ...common, logDir, tickLog: j(logDir, 'tick.log'), unit: { kind: 'launchd', label: NAMES.launchd, plist: j(home, 'Library', 'LaunchAgents', `${NAMES.launchd}.plist`) } };
  }
  const unitDir = j(home, '.config', 'systemd', 'user');
  return { ...common, logDir: null, tickLog: null, unit: { kind: 'systemd', service: j(unitDir, 'shar8-agent.service'), timer: j(unitDir, 'shar8-agent.timer') } };
}

// ---------------- версии ----------------

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

/** realpath|size|mtimeMs: ключ кэша версии claude. */
export function claudeKeyOf(path) {
  try {
    const real = realpathSync(path);
    const st = statSync(real);
    return `${real}|${st.size}|${st.mtimeMs}`;
  } catch { return null; }
}

// ---------------- стабильные пути node и claude (ADR-019 п. 1) ----------------

/** Версионные подстроки: путь с ними после смены версии исчезает. */
export const VERSIONED_SUBSTRINGS = Object.freeze(['/Cellar/', '/Caskroom/', '/.nvm/versions/', '/.asdf/installs/', '/mise/installs/', '/.volta/tools/image/', 'fnm_multishells', '/claude/versions/']);

/** Подстрока, которой не должно быть в юнитах: версионная или кэш плагина. null — чисто. */
export function findForbiddenInUnit(text) {
  const s = String(text).replace(/\\/g, '/');
  for (const sub of VERSIONED_SUBSTRINGS) if (s.includes(sub)) return sub;
  return /plugins\/cache/i.test(s) ? 'plugins/cache' : null;
}

const isVersionedPath = (p) => findForbiddenInUnit(p) !== null;

/**
 * Первый исполняемый файл по PATH БЕЗ realpath; версионный путь заменяется стабильной ссылкой на тот же файл.
 * @param {string} name 'node' | 'claude'
 * @param {{env?:object, platform?:string, home?:string, fs?:{statSync:Function, realpathSync:Function, accessSync?:Function}, current?:string}} [o]
 *   current — путь, который обязан быть тем же файлом (для node: process.execPath)
 * @returns {{path:string|null, versioned:boolean, warning:string|null}}
 */
export function resolveStablePath(name, { env = process.env, platform = process.platform, home = homedir(), fs = { statSync, realpathSync }, current } = {}) {
  const win = platform === 'win32';
  const pathVar = (win ? winEnv(env, 'PATH') : env.PATH) || '';
  const exts = win ? (winEnv(env, 'PATHEXT') || '.EXE;.CMD').split(';').filter(Boolean) : [''];
  const j = win ? win32.join : posix.join;
  const usable = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  let found = null;
  for (const dir of pathVar.split(win ? ';' : delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = j(dir, win && !/\.[A-Za-z0-9]+$/.test(name) ? `${name}${ext.toLowerCase()}` : name);
      if (usable(p)) { found = p; break; }
    }
    if (found) break;
  }
  if (current && usable(current) && (!found || real(found) !== real(current))) found = current;
  if (!found) return { path: null, versioned: false, warning: null };
  if (!isVersionedPath(found)) return { path: found, versioned: false, warning: null };
  const target = real(found);
  const candidates = win ? [] : [
    `/opt/homebrew/bin/${name}`, ...(name === 'node' ? ['/opt/homebrew/opt/node/bin/node'] : []), `/usr/local/bin/${name}`,
    j(home, '.asdf', 'shims', name), j(home, '.local', 'share', 'mise', 'shims', name), j(home, '.volta', 'bin', name),
    ...(name === 'claude' ? [j(home, '.local', 'bin', 'claude')] : []),
  ];
  for (const c of candidates) {
    if (usable(c) && real(c) === target) return { path: c, versioned: false, warning: null };
  }
  return { path: found, versioned: true, warning: `путь ${found} содержит версию: после смены версии ${name} расписание сломается (status покажет); поставьте стабильную ссылку или переустановите через install` };
}

/** PATH юнита: каталог node, каталог claude, затем системные. */
export function buildPathEnv({ nodePath, claudePath, platform = process.platform } = {}) {
  const win = platform === 'win32';
  const dirOf = (p) => (typeof p === 'string' && p ? (win ? win32.dirname(p) : posix.dirname(p)) : null);
  const system = win ? [] : ['/usr/local/bin', '/usr/bin', '/bin', ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/sbin', '/sbin'] : [])];
  return [...new Set([dirOf(nodePath), dirOf(claudePath), ...system].filter(Boolean))].join(win ? ';' : ':');
}

// ---------------- liveness: чистое решение тика ----------------

const freshLiveness = () => ({ absentTicks: 0, unreadableSince: null, missingConfigSince: null, lastCliCheckAt: null, lastCliVerdict: null });

/** Исход по файлам Claude Code. exists(path) — внедрённая проверка installPath. */
function fileVerdict(installed, settings, exists, key) {
  if (!installed?.ok) return { kind: 'unreadable', why: installed?.reason === 'missing' ? 'missing_file' : 'format' };
  const v = installed.value;
  if (!isObj(v) || v.version !== 2 || !isObj(v.plugins)) return { kind: 'unreadable', why: 'format' };
  let entries = v.plugins[key];
  if (entries === undefined || entries === null || (Array.isArray(entries) && entries.length === 0)) return { kind: 'absent' };
  if (isObj(entries)) entries = [entries];
  if (!Array.isArray(entries)) return { kind: 'unreadable', why: 'format' };
  const user = entries.find((e) => isObj(e) && e.scope === 'user');
  if (!user) return { kind: 'wrong_scope' };
  if (settings && !settings.ok && settings.reason !== 'missing') return { kind: 'unreadable', why: 'settings' };
  const flags = settings?.ok && isObj(settings.value) && isObj(settings.value.enabledPlugins) ? settings.value.enabledPlugins : {};
  const installPath = typeof user.installPath === 'string' ? user.installPath : null;
  if (flags[key] === false) return { kind: 'disabled', installPath };
  if (!installPath || !exists(installPath)) return { kind: 'unreadable', why: 'install_path_missing' };
  return { kind: 'active', installPath };
}

/** Исход по ответу `claude plugin list --json`: { ok:true, entries:[{scope, enabled, installPath}] }. */
function cliVerdict(cli, exists) {
  const entries = Array.isArray(cli?.entries) ? cli.entries.filter(isObj) : [];
  if (entries.length === 0) return { kind: 'absent' };
  const user = entries.find((e) => e.scope === 'user');
  if (!user) return { kind: 'wrong_scope' };
  const installPath = typeof user.installPath === 'string' ? user.installPath : null;
  if (user.enabled === false) return { kind: 'disabled', installPath };
  if (!installPath || !exists(installPath)) return { kind: 'unreadable', why: 'install_path_missing' };
  return { kind: 'active', installPath };
}

/**
 * Чистое решение тика: единственная точка тестирования машины состояний (fig-state-shim).
 * @param {{installed:{ok:boolean,value?:any,reason?:string}, settings?:{ok:boolean,value?:any,reason?:string}, cli?:null|{ok:boolean,entries?:object[]},
 *   state?:object, now:number, pluginKey?:string, exists?:(p:string)=>boolean, claudeFound?:boolean}} p
 * @returns {{outcome:'active'|'disabled'|'wrong_scope'|'absent'|'unreadable', reason:string|null, installPath:string|null, remove:boolean,
 *   exit:number|null, hbState:string, state:object, drift:boolean, needsCli:boolean}}
 */
export function decideLiveness({ installed, settings, cli = null, state = {}, now, pluginKey = PLUGIN_KEY, exists = () => true, claudeFound = true }) {
  const prev = { ...freshLiveness(), ...(isObj(state) ? state : {}) };
  const fv = fileVerdict(installed, settings, exists, pluginKey);
  const cliOk = cli?.ok === true;
  const cv = cliOk ? cliVerdict(cli, exists) : null;
  let verdict = fv;
  let drift = false;
  let needsCli = false;
  if (fv.kind === 'unreadable') {
    if (cv) verdict = cv;                                        // лестница: файлы нечитаемы -> верить CLI
    else if (cli === null && claudeFound) needsCli = true;
  } else if (cv && cv.kind !== 'unreadable' && cv.kind !== fv.kind) {
    verdict = cv;                                                // расхождение сигналов: верить CLI
    drift = true;
  }
  const live = { ...prev };
  if (cli) { live.lastCliCheckAt = now; live.lastCliVerdict = cv ? cv.kind : null; }
  const out = (o) => ({ reason: null, installPath: null, remove: false, exit: 0, drift, needsCli, ...o, state: live });

  if (verdict.kind === 'unreadable') {
    const missingFile = fv.kind === 'unreadable' && fv.why === 'missing_file' && !claudeFound;
    live.absentTicks = 0;
    if (missingFile) {
      live.missingConfigSince = prev.missingConfigSince ?? now;
      live.unreadableSince = null;
      if (now - live.missingConfigSince >= SHIM_LIMITS.MISSING_CEILING_MS) {
        return out({ outcome: 'unreadable', reason: 'claude_gone_24h', remove: true, exit: 0, hbState: 'removed' });
      }
    } else {
      live.unreadableSince = prev.unreadableSince ?? now;
      live.missingConfigSince = null;
      if (now - live.unreadableSince >= SHIM_LIMITS.UNREADABLE_CEILING_MS) {
        return out({ outcome: 'unreadable', reason: 'unreadable_7d', remove: true, exit: 0, hbState: 'removed' });
      }
    }
    return out({ outcome: 'unreadable', reason: fv.why ?? verdict.why ?? 'unreadable', exit: EXIT.CONFIG, hbState: 'state_unreadable' });
  }
  live.unreadableSince = null;
  live.missingConfigSince = null;
  if (verdict.kind === 'absent') {
    live.absentTicks = (Number.isInteger(prev.absentTicks) ? prev.absentTicks : 0) + 1;
    if (live.absentTicks >= 2) return out({ outcome: 'absent', reason: 'plugin_absent_2_ticks', remove: true, exit: 0, hbState: 'removed' });
    return out({ outcome: 'absent', reason: 'plugin_absent', exit: 0, hbState: 'plugin_absent' });
  }
  live.absentTicks = 0;
  if (verdict.kind === 'wrong_scope') return out({ outcome: 'wrong_scope', reason: 'wrong_scope', exit: EXIT.CONFIG, hbState: 'wrong_scope' });
  if (verdict.kind === 'disabled') return out({ outcome: 'disabled', reason: 'plugin_disabled', installPath: verdict.installPath, exit: 0, hbState: 'plugin_disabled' });
  return out({ outcome: 'active', reason: null, installPath: verdict.installPath, exit: null, hbState: 'ok' });
}

// ---------------- шаблоны юнитов (чистый рендер) ----------------

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Значение внутри двойных кавычек systemd: `\`, `"`, `%` экранируются. */
const systemdQuote = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
/** Значение для loader.conf: одинарные кавычки, `'` -> `'\''`. */
export const shSingleQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

function fillTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => {
    if (!(k in vars)) throw new TypeError(`template: no value for ${k}`);
    return vars[k];
  });
}

/** ISO-8601 длительность: минимальное целое число часов не меньше бюджета тика (LIMITS_RUN -> RUN_BUDGET_MS = 55,5 мин -> PT1H). */
export function execTimeLimitIso(runBudgetMs) {
  if (!Number.isFinite(runBudgetMs) || runBudgetMs <= 0) throw new TypeError('execTimeLimitIso: positive ms required');
  return `PT${Math.ceil(runBudgetMs / 3_600_000)}H`;
}

/** Содержимое loader.conf (POSIX): NODE и STATE в одинарных кавычках. */
export function renderLoaderConf({ nodePath, stateDir }) {
  return `NODE=${shSingleQuote(nodePath)}\nSTATE=${shSingleQuote(stateDir)}\n`;
}

const KIND_OF_PLATFORM = Object.freeze({ darwin: 'launchd', linux: 'systemd', win32: 'schtasks' });
const kindOf = (x) => (KIND_OF_PLATFORM[x] ?? x);

/**
 * Чистый рендер юнитов (golden-тесты, selftest, install).
 * @typedef {{paths:object, nodePath:string, claudeDir?:string, loaderPath:string, shimPath:string, launchJsPath?:string, stateDir?:string, logDir?:string,
 *   pathEnv:string, userSid?:string, linger?:boolean, templateVersion?:number, execTimeLimit?:string}} UnitParams
 * @param {'launchd'|'systemd'|'schtasks'|'darwin'|'linux'|'win32'} adapter
 * @param {UnitParams} p
 * @param {Record<string,string>} templates имя файла шаблона -> текст (shim шаблоны с диска не читает)
 * @returns {{files:{path:string, content:string|Buffer, mode:number, kind:string}[]}}
 */
export function renderUnits(adapter, p, templates) {
  const kind = kindOf(adapter);
  const v = String(p.templateVersion ?? TEMPLATE_VERSION);
  const unit = p.paths?.unit;
  if (kind === 'launchd') {
    const content = fillTemplate(templates['com.shar8.agent.plist.tpl'], { TEMPLATE_VERSION: v, LOADER: xmlEscape(p.loaderPath), PATH: xmlEscape(p.pathEnv), LOGDIR: xmlEscape(p.logDir) });
    return { files: [{ path: unit.plist, content, mode: 0o644, kind: 'plist' }] };
  }
  if (kind === 'systemd') {
    const service = fillTemplate(templates['shar8-agent.service.tpl'], { TEMPLATE_VERSION: v, LOADER: systemdQuote(p.loaderPath), PATH: systemdQuote(p.pathEnv) });
    const timer = fillTemplate(templates['shar8-agent.timer.tpl'], { TEMPLATE_VERSION: v });
    return { files: [{ path: unit.service, content: service, mode: 0o644, kind: 'service' }, { path: unit.timer, content: timer, mode: 0o644, kind: 'timer' }] };
  }
  if (kind === 'schtasks') {
    if (!p.execTimeLimit) throw new TypeError('renderUnits: execTimeLimit is required for schtasks');
    const text = fillTemplate(templates['Shar8Agent.xml.tpl'], {
      TEMPLATE_VERSION: v, USER_SID: xmlEscape(p.userSid ?? ''), EXEC_TIME_LIMIT: p.execTimeLimit,
      LAUNCH_JS: xmlEscape(p.launchJsPath ?? p.loaderPath), NODE: xmlEscape(p.nodePath), SHIM: xmlEscape(p.shimPath),
    });
    return { files: [{ path: unit.xml, content: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]), mode: 0o644, kind: 'xml' }] };
  }
  throw new TypeError(`renderUnits: unknown adapter ${String(adapter)}`);
}

/** Текст XML-файла задачи из буфера UTF-16LE с BOM (для тестов и status). */
export function decodeUtf16le(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.subarray(b[0] === 0xff && b[1] === 0xfe ? 2 : 0).toString('utf16le');
}

// ---------------- файлы и exec (швы) ----------------

async function readJson(path, fs = fsp, max = 1_048_576) {
  let raw;
  try { raw = await fs.readFile(path, 'utf8'); } catch (err) { return { ok: false, reason: err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? 'missing' : 'io' }; }
  if (raw.length > max) return { ok: false, reason: 'size' };
  try { return { ok: true, value: JSON.parse(raw) }; } catch { return { ok: false, reason: 'json' }; }
}

export async function writeFileAtomic(path, data, { mode = 0o600, fs = fsp } = {}) {
  await fs.mkdir(posixOrWinDirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  let fh;
  try {
    fh = await fs.open(tmp, 'wx', mode);
    await fh.writeFile(data);
    await fh.sync();
    await fh.close();
    fh = null;
    await fs.rename(tmp, path);
  } catch (err) {
    if (fh) await fh.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

const posixOrWinDirname = (p) => (/^[A-Za-z]:\\|\\/.test(p) && !p.startsWith('/') ? win32.dirname(p) : posix.dirname(p));
const writeJsonAtomic = (path, value, o) => writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, o);

/** exec по умолчанию: resolve всегда {code, stdout, stderr}; код null — не удалось запустить/таймаут. */
export function defaultExec(file, args, { timeoutMs = 20_000, env, input } = {}) {
  return new Promise((resolve) => {
    try {
      const child = execFile(file, args, { timeout: timeoutMs, env, windowsHide: true, maxBuffer: 1_048_576, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (!err) { resolve({ code: 0, stdout, stderr }); return; }
        resolve({ code: typeof err.code === 'number' ? err.code : null, stdout: stdout ?? '', stderr: stderr || err.message || '', error: err });
      });
      if (input !== undefined) child.stdin?.end(input); else child.stdin?.end();
    } catch (err) { resolve({ code: null, stdout: '', stderr: errText(err), error: err }); }
  });
}

/** Системная утилита Windows по абсолютному пути (cwd ребёнка не должен участвовать в поиске, C6). */
function winTool(env, exe) {
  const root = winEnv(env, 'SystemRoot') || winEnv(env, 'windir') || 'C:\\Windows';
  return win32.join(root, 'System32', exe);
}

class AdapterError extends Error {
  constructor(code, detail = '') { super(`${code}${detail ? `: ${String(detail).slice(0, 160)}` : ''}`); this.name = 'AdapterError'; this.code = code; }
}

const unitTemplateVersion = (text, re) => { const m = re.exec(String(text ?? '')); return m ? Number(m[1]) : null; };

// ---------------- адаптеры планировщика ----------------

/**
 * @param {'launchd'|'systemd'|'schtasks'} kind
 * @param {{paths:object, exec?:Function, fs?:object, uid?:number, sleep?:Function, env?:object, platform?:string, spawnDetached?:Function,
 *   nodePath?:string, existsSync?:Function}} ctx
 */
export function createAdapter(kind, ctx) {
  const { paths, exec = defaultExec, fs = fsp, sleep = sleepReal, env = process.env } = ctx;
  const fileExists = ctx.existsSync ?? existsSync;
  const warnings = [];
  const writeUnit = async (f) => { await writeFileAtomic(f.path, f.content, { mode: f.mode, fs }); };
  const rmQuiet = (p) => fs.rm(p, { force: true }).catch(() => {});
  const check = (r) => r && r.code === 0;
  const check0 = (r, code) => { if (!check(r)) throw new AdapterError(code, r?.stderr || r?.stdout || `exit ${r?.code}`); };

  const base = {
    kind, platform: { launchd: 'darwin', systemd: 'linux', schtasks: 'win32' }[kind], paths,
    render: (p, templates) => renderUnits(kind, { ...p, paths }, templates),
    /** @returns {Promise<string[]>} предупреждения прошлой операции */
    takeWarnings: () => warnings.splice(0),
  };

  if (kind === 'launchd') {
    const uid = ctx.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
    const domain = `gui/${uid}`;
    const target = `${domain}/${NAMES.launchd}`;
    const printOk = async (t = target) => check(await exec('launchctl', ['print', t], { timeoutMs: 10_000 }));
    const legacyPlist = posix.join(paths.home, 'Library', 'LaunchAgents', `${NAMES.legacyLaunchd}.plist`);
    return {
      ...base,
      async isAvailable() {
        const r = await exec('launchctl', ['print', domain], { timeoutMs: 10_000 });
        return check(r) ? { ok: true } : { ok: false, reason: 'launchctl не отвечает для домена пользователя' };
      },
      async removeLegacy() {
        // Старый демон ставится до нового: два раннера взяли бы одну очередь. Его env-файл не читается (FR-D04).
        await exec('launchctl', ['bootout', `${domain}/${NAMES.legacyLaunchd}`], { timeoutMs: 15_000 });
        await rmQuiet(legacyPlist);
      },
      async register(p, templates) {
        const { files } = base.render(p, templates);
        for (const f of files) { const bad = findForbiddenInUnit(f.content); if (bad) throw new AdapterError('unit_forbidden_path', bad); }
        await this.removeLegacy();
        if (p.logDir) await fs.mkdir(p.logDir, { recursive: true, mode: 0o700 });
        for (const f of files) await writeUnit(f);
        const plist = files[0].path;
        if (await printOk()) {
          await exec('launchctl', ['bootout', target], { timeoutMs: 15_000 });
          for (let i = 0; i < 20 && await printOk(); i++) await sleep(250);   // до 5 с, пока задание не исчезнет
        }
        let r = await exec('launchctl', ['bootstrap', domain, plist], { timeoutMs: 15_000 });
        if (!check(r) && /Bootstrap failed: 5\b|Input\/output error/i.test(`${r?.stderr}${r?.stdout}`)) {
          await sleep(1000);
          r = await exec('launchctl', ['bootstrap', domain, plist], { timeoutMs: 15_000 });   // известная гонка: один повтор
        }
        check0(r, 'bootstrap_failed');
        return { files: files.map((f) => f.path) };
      },
      async removeFiles() { await rmQuiet(paths.unit.plist); },
      async deregister() {
        const r = await exec('launchctl', ['bootout', target], { timeoutMs: 15_000 });
        if (!check(r) && await printOk()) throw new AdapterError('bootout_failed', r?.stderr);
      },
      async unregister({ detached = false } = {}) {
        await this.removeFiles();
        if (detached) { ctx.spawnDetached?.('unregister-detached'); return; }   // bootout из своего же тика убил бы вызывающий процесс
        await this.deregister();
      },
      async kickstart() {
        const r = await exec('launchctl', ['kickstart', target], { timeoutMs: 15_000 });   // БЕЗ -k: ротация токена не убивает идущую задачу
        check0(r, 'kickstart_failed');
      },
      async isRegistered(install = {}) {
        const registered = await printOk();
        let templateVersion = null;
        try { templateVersion = unitTemplateVersion(await fs.readFile(paths.unit.plist, 'utf8'), /Shar8TemplateVersion<\/key>\s*<integer>(\d+)</); } catch { /* юнита нет */ }
        return { registered, templateVersion, missingPaths: missingPathsOf(install, fileExists, 'darwin') };
      },
    };
  }

  if (kind === 'systemd') {
    const sc = (...a) => exec('systemctl', ['--user', ...a], { timeoutMs: 20_000 });
    return {
      ...base,
      async isAvailable() {
        const r = await sc('show-environment');
        return check(r) ? { ok: true } : { ok: false, reason: 'systemctl --user недоступен (нет пользовательской шины systemd: WSL1, контейнер); используйте run' };
      },
      async removeLegacy() { /* на Linux старого демона нет */ },
      async register(p, templates) {
        const { files } = base.render(p, templates);
        for (const f of files) { const bad = findForbiddenInUnit(f.content); if (bad) throw new AdapterError('unit_forbidden_path', bad); }
        for (const f of files) await writeUnit(f);
        check0(await sc('daemon-reload'), 'daemon_reload_failed');
        check0(await sc('enable', '--now', `${NAMES.systemd}.timer`), 'enable_failed');
        if (p.linger) {
          const user = env.USER || env.LOGNAME || (() => { try { return userInfo().username; } catch { return ''; } })();
          const r = await exec('loginctl', ['enable-linger', user], { timeoutMs: 15_000 });
          if (!check(r)) warnings.push('linger_failed');     // предупреждение, не отказ
        }
        return { files: files.map((f) => f.path) };
      },
      async removeFiles() { await rmQuiet(paths.unit.timer); await rmQuiet(paths.unit.service); },
      async deregister() { await sc('daemon-reload'); },
      async unregister() {
        // disable идёт ПЕРВЫМ: без файла юнита systemd не найдёт симлинк WantedBy. Остановка таймера безопасна изнутри тика (сервис не трогается).
        await sc('disable', '--now', `${NAMES.systemd}.timer`);
        await this.removeFiles();
        await sc('daemon-reload');
      },
      async kickstart() { check0(await sc('start', '--no-block', `${NAMES.systemd}.service`), 'start_failed'); },
      async isRegistered(install = {}) {
        const r = await sc('is-enabled', `${NAMES.systemd}.timer`);
        let templateVersion = null;
        try { templateVersion = unitTemplateVersion(await fs.readFile(paths.unit.service, 'utf8'), /# shar8-template: (\d+)/); } catch { /* юнита нет */ }
        return { registered: check(r), templateVersion, missingPaths: missingPathsOf(install, fileExists, 'linux') };
      },
    };
  }

  if (kind === 'schtasks') {
    const schtasks = winTool(env, 'schtasks.exe');
    const wscript = winTool(env, 'wscript.exe');
    return {
      ...base,
      async isAvailable() {
        return fileExists(wscript) ? { ok: true } : { ok: false, reason: 'wscript.exe не найден (WSH отключён): расписание недоступно, используйте run' };
      },
      async removeLegacy() { /* на Windows старого демона нет */ },
      async register(p, templates) {
        const { files } = base.render(p, templates);
        for (const f of files) { const bad = findForbiddenInUnit(decodeUtf16le(f.content)); if (bad) throw new AdapterError('unit_forbidden_path', bad); }
        for (const f of files) await writeUnit(f);
        const xml = files[0].path;
        try {
          check0(await exec(schtasks, ['/create', '/tn', NAMES.winTask, '/xml', xml, '/f'], { timeoutMs: 30_000 }), 'schtasks_create_failed');
        } finally { await rmQuiet(xml); }            // XML нужен только на время создания
        return { files: [] };
      },
      async removeFiles() { await rmQuiet(paths.unit.xml); },
      async deregister() {
        const r = await exec(schtasks, ['/delete', '/tn', NAMES.winTask, '/f'], { timeoutMs: 30_000 });
        if (!check(r) && check(await exec(schtasks, ['/query', '/tn', NAMES.winTask], { timeoutMs: 15_000 }))) throw new AdapterError('schtasks_delete_failed', r?.stderr);
      },
      async unregister({ detached = false } = {}) {
        await this.removeFiles();
        if (detached) { ctx.spawnDetached?.('unregister-detached'); return; }
        await this.deregister();
      },
      async kickstart() { check0(await exec(schtasks, ['/run', '/tn', NAMES.winTask], { timeoutMs: 15_000 }), 'schtasks_run_failed'); },   // при IgnoreNew и работающем экземпляре /run молча ничего не делает
      async isRegistered(install = {}) {
        const q = await exec(schtasks, ['/query', '/tn', NAMES.winTask], { timeoutMs: 15_000 });
        let templateVersion = null;
        if (check(q)) {
          const x = await exec(schtasks, ['/query', '/tn', NAMES.winTask, '/xml'], { timeoutMs: 15_000 });
          templateVersion = unitTemplateVersion(x?.stdout, /shar8-template: (\d+)/);
        }
        return { registered: check(q), templateVersion, missingPaths: missingPathsOf(install, fileExists, 'win32') };
      },
    };
  }
  throw new TypeError(`createAdapter: unknown kind ${String(kind)}`);
}

export function adapterKindFor(platform) { return KIND_OF_PLATFORM[platform] ?? null; }

/** Пути из юнита (node и каталог claude), которых уже нет: «расписание сломано». */
function missingPathsOf(install, fileExists, platform) {
  const out = [];
  const dir = platform === 'win32' ? win32.dirname : posix.dirname;
  if (typeof install?.nodePath === 'string' && install.nodePath && !fileExists(install.nodePath)) out.push(install.nodePath);
  if (typeof install?.claudePath === 'string' && install.claudePath && !fileExists(dir(install.claudePath))) out.push(dir(install.claudePath));
  return out;
}

// ---------------- состояние shim ----------------

async function readShimState(paths, fs) {
  const r = await readJson(paths.shimState, fs);
  const value = r.ok && isObj(r.value) ? r.value : {};
  return { ...value, v: 1, layout: Number.isInteger(value.layout) ? value.layout : LAYOUT };
}

/** Меняет разделы shim (`liveness`, `claudeVersion`, `heal`, `shimVersion`); `install` и `layout` не трогает. */
async function updateShimState(paths, patch, fs) {
  const cur = await readShimState(paths, fs);
  await writeJsonAtomic(paths.shimState, { ...cur, ...patch, install: cur.install, layout: cur.layout }, { fs });
}

async function heartbeatBegin(paths, base, now, fs) {
  await writeJsonAtomic(paths.heartbeat, { ...base, v: 1, at: new Date(now).toISOString(), phase: 'start' }, { fs });
}

async function heartbeatEnd(paths, result, now, fs) {
  const prev = await readJson(paths.heartbeat, fs);
  const base = prev.ok && isObj(prev.value) ? prev.value : {};
  await writeJsonAtomic(paths.heartbeat, { ...base, ...result, v: 1, at: new Date(now).toISOString(), phase: 'done' }, { fs });
}

async function trimLog(paths, fs) {
  if (!paths.tickLog) return;
  try {
    const st = await fs.stat(paths.tickLog);
    if (st.size > SHIM_LIMITS.LOG_MAX_BYTES) await fs.rename(paths.tickLog, `${paths.tickLog}.1`);
  } catch { /* лога нет */ }
}

// ---------------- файлы Claude Code и CLI ----------------

function claudeDirs({ install, env, home }) {
  const configDir = install?.configDir || env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const pluginsRoot = install?.pluginCacheDir || env.CLAUDE_CODE_PLUGIN_CACHE_DIR || join(configDir, 'plugins');
  return { configDir, pluginsRoot };
}

/** Читает installed_plugins.json и settings.json и заранее проверяет существование installPath (decideLiveness чист). */
async function readClaudeFiles({ install, env, home, fs }) {
  const { configDir, pluginsRoot } = claudeDirs({ install, env, home });
  const installed = await readJson(join(pluginsRoot, 'installed_plugins.json'), fs);
  const settings = await readJson(join(configDir, 'settings.json'), fs);
  const present = new Set();
  const candidates = [];
  const entries = installed.ok && isObj(installed.value?.plugins) ? installed.value.plugins[PLUGIN_KEY] : null;
  for (const e of Array.isArray(entries) ? entries : (isObj(entries) ? [entries] : [])) if (isObj(e) && typeof e.installPath === 'string') candidates.push(e.installPath);
  for (const p of candidates) { try { if ((await fs.stat(p)).isDirectory()) present.add(p); } catch { /* нет */ } }
  return { installed, settings, present, configDir };
}

/** installPath из ответа CLI проверяется заранее: decideLiveness чист и диск сам не читает. */
async function absorbCli(files, cli, fs) {
  for (const e of cli?.entries ?? []) {
    if (typeof e.installPath !== 'string') continue;
    try { if ((await fs.stat(e.installPath)).isDirectory()) files.present.add(e.installPath); } catch { /* нет */ }
  }
}

async function queryCli({ claudePath, exec, env }) {
  if (!claudePath) return { ok: false };
  const r = await exec(claudePath, ['plugin', 'list', '--json'], { timeoutMs: SHIM_LIMITS.CLI_TIMEOUT_MS, env });
  if (!r || r.code !== 0) return { ok: false };
  let doc;
  try { doc = JSON.parse(String(r.stdout)); } catch { return { ok: false }; }
  const list = Array.isArray(doc) ? doc : (isObj(doc) && Array.isArray(doc.plugins) ? doc.plugins : null);
  if (!list) return { ok: false };
  const entries = list.filter((e) => isObj(e) && (e.id === PLUGIN_KEY || (e.name === 'shar8-agent' && (e.marketplace === 'shar8' || e.marketplace === undefined && e.id === undefined))))
    .map((e) => ({ scope: e.scope, enabled: e.enabled, installPath: e.installPath }));
  return { ok: true, entries };
}

function findOnPath(name, env, platform) {
  const win = platform === 'win32';
  const pathVar = (win ? winEnv(env, 'PATH') : env.PATH) || '';
  const j = win ? win32.join : posix.join;
  for (const dir of pathVar.split(win ? ';' : delimiter)) {
    if (!dir) continue;
    for (const n of win ? [`${name}.exe`, `${name}.cmd`] : [name]) {
      try { if (statSync(j(dir, n)).isFile()) return j(dir, n); } catch { /* дальше */ }
    }
  }
  return null;
}

function locateClaude({ install, env, platform }) {
  try { if (install?.claudePath && statSync(install.claudePath).isFile()) return install.claudePath; } catch { /* путь устарел */ }
  return findOnPath('claude', env, platform);
}

async function claudeVersionOf({ claudePath, cached, exec, env, now }) {
  const key = claudeKeyOf(claudePath);
  if (key && cached?.key === key && parseVersion(cached.version)) return { version: cached.version, record: null };
  const r = await exec(claudePath, ['--version'], { timeoutMs: 15_000, env });
  const parsed = r?.code === 0 ? parseVersion(r.stdout) : null;
  if (!parsed) return { version: null, record: null };
  const version = parsed.join('.');
  return { version, record: key ? { key, version, checkedAt: new Date(now).toISOString() } : null };
}

// ---------------- общий контекст ----------------

function makeCtx(argsEnv, deps = {}) {
  const env = argsEnv ?? process.env;
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? env.HOME ?? env.USERPROFILE ?? homedir();
  const fs = deps.fs ?? fsp;
  const paths = deps.paths ?? pathsFor({ platform, home, env });
  const exec = deps.exec ?? defaultExec;
  const nowFn = deps.now ?? Date.now;
  const out = deps.stdout ?? ((t) => process.stdout.write(t));
  const err = deps.stderr ?? ((t) => process.stderr.write(t));
  return { env, platform, home, fs, paths, exec, now: nowFn, out, err, sleep: deps.sleep ?? sleepReal, deps };
}

function adapterOf(ctx, install) {
  const kind = adapterKindFor(ctx.platform);
  if (!kind) return null;
  const nodePath = install?.nodePath || ctx.deps.nodePath || process.execPath;
  const shimPath = ctx.paths.shim;
  return createAdapter(kind, {
    paths: ctx.paths, exec: ctx.exec, fs: ctx.fs, uid: ctx.deps.uid, sleep: ctx.sleep, env: ctx.env, existsSync: ctx.deps.existsSync,
    spawnDetached: (sub) => {
      const spawnImpl = ctx.deps.spawnDetached ?? ((cmd, args, o) => spawn(cmd, args, o).unref());
      spawnImpl(nodePath, [shimPath, sub, ctx.platform], { detached: true, stdio: 'ignore', windowsHide: true });
    },
  });
}

/** Состояние пробы: запрос не старше 10 минут; просроченный удаляется. */
async function readProbeRequest(ctx) {
  const r = await readJson(ctx.paths.probeRequest, ctx.fs);
  if (!r.ok) return null;
  const q = r.value;
  const fresh = isObj(q) && typeof q.nonce === 'string' && /^[0-9a-f]{16}$/.test(q.nonce) && Number.isFinite(q.at) && ctx.now() - q.at <= SHIM_LIMITS.PROBE_REQUEST_MAX_MS;
  if (!fresh) { await ctx.fs.rm(ctx.paths.probeRequest, { force: true }).catch(() => {}); return null; }
  return { nonce: q.nonce, via: q.via === 'terminal' ? 'terminal' : 'scheduler' };
}

async function writeProbeResultClass(ctx, req, cls, extra = {}) {
  await writeJsonAtomic(ctx.paths.probeResult, {
    v: 1, nonce: req.nonce, at: ctx.now(), ms: 0, class: cls, authMethod: null, answer: null, claudeVersion: null, via: req.via, ...extra,
  }, { fs: ctx.fs });
  await ctx.fs.rm(ctx.paths.probeRequest, { force: true }).catch(() => {});
}

// ---------------- самоснятие, uninstall ----------------

/**
 * Снимает расписание: сначала файлы и состояние, регистрация последней (ADR-016). launchd и schtasks — отсоединённо при самоснятии.
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function removeSchedule(ctx, { detached, adapter, legacy = false }) {
  const { paths, fs } = ctx;
  const errors = [];
  for (const f of [paths.backoff, paths.probeRequest, paths.probeResult]) await fs.rm(f, { force: true }).catch(() => {});
  try {
    const cur = await readShimState(paths, fs);
    const install = isObj(cur.install) ? { ...cur.install, schedule: false } : cur.install;
    await writeJsonAtomic(paths.shimState, { ...cur, liveness: freshLiveness(), install }, { fs });
  } catch (e) { errors.push(errText(e)); }
  if (adapter) {
    try { await adapter.unregister({ detached }); } catch (e) { errors.push(errText(e)); }
    if (legacy) { try { await adapter.removeLegacy(); } catch (e) { errors.push(errText(e)); } }
  }
  return errors.length ? { ok: false, error: errors.join('; ') } : { ok: true };
}

async function selfRemove(ctx, install, reason, started) {
  await heartbeatEnd(ctx.paths, { state: 'removed', reason, exit: 0, shimVersion: SHIM_VERSION, tickMs: ctx.now() - started }, ctx.now(), ctx.fs).catch(() => {});
  const adapter = adapterOf(ctx, install);
  const r = await removeSchedule(ctx, { detached: true, adapter });
  if (!r.ok) {
    await heartbeatEnd(ctx.paths, { state: 'unregister_failed', reason: String(r.error).slice(0, 120), exit: 0, shimVersion: SHIM_VERSION }, ctx.now(), ctx.fs).catch(() => {});
  }
  return EXIT.OK;
}

/**
 * Идемпотентно снимает расписание и состояние; токен (env-файл) не трогает без --purge.
 * @param {{purge?: boolean}} opts
 * @param {{confirm?: (q:string)=>Promise<boolean>, isTTY?: boolean}} deps
 */
export async function uninstall(opts = {}, deps = {}) {
  const ctx = makeCtx(deps.env, deps);
  const { paths, fs } = ctx;
  if (opts.purge && !(deps.isTTY ?? process.stdin.isTTY)) {
    ctx.err('uninstall --purge спрашивает подтверждение и работает только в терминале; ничего не удалено\n');
    return EXIT.CONFIG;
  }
  let purge = false;
  if (opts.purge) {
    const confirm = deps.confirm ?? (async () => false);
    purge = await confirm(`Удалить env-файл с токеном и каталоги ядра (${paths.configDir})? [y/N] `);
    if (!purge) ctx.out('purge отменён: токен и файлы оставлены\n');
  }
  const state = await readShimState(paths, fs);
  const adapter = adapterOf(ctx, state.install);
  const r = await removeSchedule(ctx, { detached: false, adapter, legacy: true });
  await heartbeatEnd(paths, { state: 'removed', reason: 'uninstall', exit: 0, shimVersion: SHIM_VERSION }, ctx.now(), fs).catch(() => {});
  if (!r.ok) { ctx.err(`uninstall: расписание снято не полностью: ${r.error}\n`); return EXIT.FAILURE; }
  ctx.out('расписание снято; токен (env-файл) не тронут\n');
  if (purge) {
    for (const p of [paths.envFile, paths.loader, paths.loaderConf, paths.shimPrev, paths.shimState, paths.heartbeat, paths.backoff, paths.probeRequest, paths.probeResult]) {
      await fs.rm(p, { force: true }).catch(() => {});
    }
    for (const d of [paths.runsDir, paths.workDir, paths.lockDir, ...(paths.logDir ? [paths.logDir] : [])]) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    await fs.rm(paths.shim, { force: true }).catch(() => {});
    for (const d of [paths.stateDir, paths.configDir]) await fs.rmdir(d).catch(() => {});   // непустой каталог (agent.json, send-policy.json) остаётся
    ctx.out(`purge: env-файл и ядро удалены; ${paths.agentJson} и ${paths.sendPolicy} (ваши файлы) не тронуты\n`);
  }
  return EXIT.OK;
}

// ---------------- тик ----------------

/** Версия shim упакованного файла: regex по тексту, файл не исполняется. */
export async function packagedShimVersion(file, fs = fsp) {
  try {
    const m = /export const SHIM_VERSION\s*=\s*(\d+)/.exec(await fs.readFile(file, 'utf8'));
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

/** Самолечение: упакованный shim с другой версией проверяется `selftest` в подпроцессе, затем атомарно заменяет shim.mjs. */
async function selfHeal(ctx, installPath, nodePath) {
  const { paths, fs, exec } = ctx;
  const packaged = join(installPath, 'runtime', 'shim.mjs');
  const version = await packagedShimVersion(packaged, fs);
  if (version === null || version === SHIM_VERSION) return { healed: false };
  // I05: провал самолечения запоминается для этой версии упакованного shim; пока версия та же, selftest и копирование не повторяются каждую минуту.
  const st = await readJson(paths.shimState, fs);
  const prevHeal = st.ok && isObj(st.value?.heal) ? st.value.heal : {};
  if (prevHeal.failedFor === version) return { healed: false, failed: true, remembered: true };
  const remember = () => updateShimState(paths, { heal: { ...prevHeal, failedFor: version } }, fs).catch(() => {});
  const tmp = join(paths.configDir, `shim.${randomBytes(4).toString('hex')}.new.mjs`);   // расширение .mjs: node должен исполнить копию как ESM
  try {
    await fs.mkdir(paths.configDir, { recursive: true });
    await fs.copyFile(packaged, tmp);                        // проверяем ровно те байты, которые поставим
    const r = await exec(nodePath, [tmp, 'selftest'], { timeoutMs: 20_000 });
    let doc = null;
    try { doc = JSON.parse(String(r?.stdout).trim().split('\n').pop()); } catch { /* не JSON */ }
    if (r?.code !== 0 || !doc?.ok) { await fs.rm(tmp, { force: true }); await remember(); return { healed: false, failed: true }; }
    await fs.copyFile(paths.shim, `${paths.shimPrev}.tmp`).then(() => fs.rename(`${paths.shimPrev}.tmp`, paths.shimPrev)).catch(() => {});
    await fs.rename(tmp, paths.shim);
    return { healed: true, from: SHIM_VERSION, to: version };
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {});
    await remember();
    return { healed: false, failed: true };
  }
}

/** Запуск раннера: наследуемые stdio, без окна; код выхода раннера — код тика. */
function spawnRunner(ctx, nodePath, args, env) {
  const impl = ctx.deps.spawnRunner ?? ((cmd, a, o) => new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, a, o); } catch { resolve(EXIT.FAILURE); return; }
    child.once('error', () => resolve(EXIT.FAILURE));
    child.once('exit', (code) => resolve(Number.isInteger(code) ? code : EXIT.FAILURE));
  }));
  return impl(nodePath, args, { env, stdio: 'inherit', windowsHide: true });
}

/**
 * Один тик: heartbeat -> проба? -> liveness -> версии -> самолечение -> раннер -> heartbeat. Модель не запускает.
 * @returns {Promise<number>} код выхода
 */
export async function tick({ argv = [], env = process.env, deps = {} } = {}) {
  void argv;
  const ctx = makeCtx(env, deps);
  const { paths, fs, exec } = ctx;
  const started = ctx.now();
  await fs.mkdir(paths.stateDir, { recursive: true, mode: 0o700 }).catch(() => {});
  await trimLog(paths, fs);
  await heartbeatBegin(paths, { shimVersion: SHIM_VERSION }, started, fs).catch(() => {});
  const end = async (code, hbState, extra = {}) => {
    await heartbeatEnd(paths, { state: hbState, exit: code, shimVersion: SHIM_VERSION, contract: CONTRACT, tickMs: ctx.now() - started, ...extra }, ctx.now(), fs).catch(() => {});
    return code;
  };
  const probe = await readProbeRequest(ctx);
  const state = await readShimState(paths, fs);
  const install = isObj(state.install) ? state.install : {};
  const claudePath = locateClaude({ install, env, platform: ctx.platform });

  // liveness: файлы Claude Code; раз в 6 часов и при нечитаемых файлах — сверка с `claude plugin list --json`.
  const files = await readClaudeFiles({ install, env, home: ctx.home, fs });
  const exists = (p) => files.present.has(p);
  const lv0 = isObj(state.liveness) ? state.liveness : {};
  const cliDue = Boolean(claudePath) && (!Number.isFinite(lv0.lastCliCheckAt) || started - lv0.lastCliCheckAt >= SHIM_LIMITS.CLI_CHECK_MS);
  let cli = cliDue ? await queryCli({ claudePath, exec, env }) : null;
  await absorbCli(files, cli, fs);
  const decide = () => decideLiveness({ installed: files.installed, settings: files.settings, cli, state: lv0, now: started, exists, claudeFound: Boolean(claudePath) });
  let dec = decide();
  if (dec.needsCli && cli === null) {
    cli = await queryCli({ claudePath, exec, env });
    await absorbCli(files, cli, fs);
    dec = decide();
  }
  const liveChanged = JSON.stringify(dec.state) !== JSON.stringify(lv0);
  const pluginInfo = { plugin: dec.outcome, installPath: dec.installPath, drift: dec.drift, node: process.versions.node };
  if (liveChanged) await updateShimState(paths, { liveness: dec.state, shimVersion: SHIM_VERSION }, fs).catch(() => {});

  if (dec.remove) return selfRemove(ctx, install, dec.reason, started);
  if (dec.outcome !== 'active') {
    if (probe) await writeProbeResultClass(ctx, probe, dec.outcome === 'disabled' ? 'plugin_disabled' : (dec.outcome === 'wrong_scope' ? 'wrong_scope' : 'plugin_unavailable')).catch(() => {});
    return end(dec.exit ?? EXIT.OK, dec.hbState, { reason: dec.reason, ...pluginInfo });
  }

  // версии: ниже порога раннер не запускается (AC-D14). claude не найден — не блокируем: CLAUDE_BIN читает раннер, класс назовёт он.
  const nodeMajor = Number(String(ctx.deps.nodeVersion ?? process.versions.node).split('.')[0]);
  let claudeVersion = null;
  const failVersion = async (cls) => {
    if (probe) await writeProbeResultClass(ctx, probe, cls, { claudeVersion }).catch(() => {});
    return end(EXIT.CONFIG, cls, { reason: cls, claude: claudeVersion, ...pluginInfo });
  };
  if (!(nodeMajor >= SHIM_LIMITS.NODE_MIN_MAJOR)) return failVersion('node_too_old');
  if (claudePath) {
    const cv = await claudeVersionOf({ claudePath, cached: state.claudeVersion, exec, env, now: started });
    claudeVersion = cv.version;
    if (cv.record) await updateShimState(paths, { claudeVersion: cv.record }, fs).catch(() => {});
    if (cv.version && !versionAtLeast(cv.version, SHIM_LIMITS.CLAUDE_MIN_VERSION)) return failVersion('claude_too_old');
  }

  const nodePath = ctx.deps.nodePath ?? process.execPath;
  const heal = await selfHeal(ctx, dec.installPath, nodePath);
  if (heal.healed) {
    await updateShimState(paths, { heal: { lastReplacedAt: new Date(ctx.now()).toISOString(), from: heal.from, to: heal.to } }, fs).catch(() => {});
  }
  const runnerEntry = join(dec.installPath, 'runtime', 'tick.mjs');
  const runnerArgs = [runnerEntry, '--contract', String(CONTRACT), 'tick', ...(probe ? ['--probe', probe.nonce] : [])];
  const code = await spawnRunner(ctx, nodePath, runnerArgs, env);
  // Состояние раннер пишет сам (paused_env, empty, ...); если он не дописал heartbeat этого тика, выводим по коду.
  const hb = await readJson(paths.heartbeat, fs);
  const runnerDone = hb.ok && hb.value?.phase === 'done' && Date.parse(hb.value.at) >= started && hb.value.runnerVersion !== undefined;
  const hbState = runnerDone ? hb.value.state : (code === EXIT.OK ? 'ok' : (code === EXIT.AUTH ? 'auth_rejected' : 'config_error'));
  const extra = { claude: claudeVersion, ...pluginInfo, ...(heal.failed ? { shimHeal: 'shim_heal_failed' } : {}) };
  extra.reason = runnerDone && hb.value.reason !== undefined && hb.value.reason !== null ? hb.value.reason : (heal.failed ? 'shim_heal_failed' : null);
  // I03/SEC17: загрузчик принимает от shim только 0, 77, 78, а любой другой код считает поломкой shim и запускает shim.prev.mjs.
  // Сбой раннера (например 1) к поломке shim не относится: нормализуем в 78 с понятным heartbeat.
  if (code !== EXIT.OK && code !== EXIT.AUTH && code !== EXIT.CONFIG) {
    return end(EXIT.CONFIG, 'runner_error', { ...extra, reason: `runner_exit_${Number.isInteger(code) ? code : 'unknown'}` });
  }
  return end(code, hbState, extra);
}

// ---------------- status ----------------

const AGE_UNITS = [[86_400_000, 'дн.'], [3_600_000, 'ч'], [60_000, 'мин']];
const ageText = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return 'н/д';
  for (const [size, label] of AGE_UNITS) if (ms >= size) return `${Math.floor(ms / size)} ${label} назад`;
  return 'меньше минуты назад';
};

async function readRunnerPolicy(ctx, installPath, nodePath) {
  if (!installPath) return { state: 'not_checked', line: 'не проверена (плагина нет в кэше)' };
  const r = await ctx.exec(nodePath, [join(installPath, 'runtime', 'tick.mjs'), '--contract', String(CONTRACT), 'policy-check', '--json'], { timeoutMs: 15_000, env: ctx.env });
  let doc = null;
  try { doc = JSON.parse(String(r?.stdout).trim().split('\n').pop()); } catch { /* не JSON */ }
  if (!isObj(doc) || typeof doc.state !== 'string') return { state: 'not_checked', line: 'не проверена (раннер не ответил)' };
  const detail = [doc.reason ? `код ${doc.reason}` : '', Array.isArray(doc.path) && doc.path.length ? `поле ${doc.path.join('.')}` : '', Number.isInteger(doc.tools) ? `инструментов ${doc.tools}` : ''].filter(Boolean).join(', ');
  return { state: doc.state, line: `${doc.state}${detail ? ` (${detail})` : ''}`, reason: doc.reason ?? null };
}

/** Дата сборки плагина: `PLUGIN_BUILT_AT` из runtime/version.mjs установленной версии (читается как текст). */
async function readBuiltAt(installPath, fs) {
  if (!installPath) return null;
  try {
    const m = /export const PLUGIN_BUILT_AT\s*=\s*'(\d{4}-\d{2}-\d{2})'/.exec(await fs.readFile(join(installPath, 'runtime', 'version.mjs'), 'utf8'));
    return m ? m[1] : null;
  } catch { return null; }
}

async function readPluginVersion(installPath, fs) {
  if (!installPath) return null;
  const r = await readJson(join(installPath, '.claude-plugin', 'plugin.json'), fs);
  return r.ok && typeof r.value?.version === 'string' ? r.value.version : null;
}

/** Собирает отчёт status; не бросает исключений (каждый источник ошибается отдельно). */
export async function collectStatus(deps = {}) {
  const ctx = makeCtx(deps.env, deps);
  const { paths, fs, env } = ctx;
  const now = ctx.now();
  const state = await readShimState(paths, fs);
  const install = isObj(state.install) ? state.install : {};
  const claudePath = locateClaude({ install, env, platform: ctx.platform });
  const errors = [];

  const files = await readClaudeFiles({ install, env, home: ctx.home, fs });
  const exists = (p) => files.present.has(p);
  const cli = claudePath ? await queryCli({ claudePath, exec: ctx.exec, env }) : null;
  await absorbCli(files, cli, fs);
  const dec = decideLiveness({ installed: files.installed, settings: files.settings, cli, state: state.liveness, now, exists, claudeFound: Boolean(claudePath) });
  const plugin = {
    state: dec.outcome === 'unreadable' ? 'unreadable' : dec.outcome, reason: dec.reason, installPath: dec.installPath, drift: dec.drift,
    version: await readPluginVersion(dec.installPath, fs),
  };
  if (dec.outcome === 'unreadable') errors.push(`состояние плагина нечитаемо (${dec.reason}); таймер не тронут`);
  if (dec.outcome === 'wrong_scope') errors.push(`плагин поставлен не в scope user: ${SHIM_COMMANDS.pluginInstallUser}`);

  let schedule = { kind: adapterKindFor(ctx.platform), installed: null, templateVersion: null, templateStale: false, missingPaths: [], broken: false };
  const adapter = adapterOf(ctx, install);
  if (adapter) {
    try {
      const reg = await adapter.isRegistered(install);
      schedule = { ...schedule, installed: reg.registered, templateVersion: reg.templateVersion, missingPaths: reg.missingPaths,
        templateStale: reg.registered && reg.templateVersion !== null && reg.templateVersion !== TEMPLATE_VERSION, broken: reg.registered && reg.missingPaths.length > 0 };
    } catch (e) { errors.push(`расписание: ${errText(e)}`); }
  }

  const hb = await readJson(paths.heartbeat, fs);
  const lastTick = hb.ok && isObj(hb.value) ? {
    at: hb.value.at ?? null, phase: hb.value.phase ?? null, state: hb.value.state ?? null, reason: hb.value.reason ?? null, exit: hb.value.exit ?? null,
    tickMs: hb.value.tickMs ?? null, ageMs: Number.isFinite(Date.parse(hb.value.at)) ? now - Date.parse(hb.value.at) : null,
  } : null;

  const bo = await readJson(paths.backoff, fs);
  const pauses = [];
  if (bo.ok && isObj(bo.value?.entries)) {
    for (const kind of ['auth', 'claim', 'env', 'isolation']) {
      const e = bo.value.entries[kind];
      if (!isObj(e)) continue;
      if (kind !== 'isolation' && !(Number.isFinite(e.until) && e.until > now)) continue;
      pauses.push({ kind, reason: e.reason ?? null, until: Number.isFinite(e.until) ? e.until : null, ...(e.resetsOn ? { resetsOn: e.resetsOn } : {}), ...(Number.isInteger(e.count) && kind === 'env' ? { count: e.count } : {}) });
    }
  }

  let claude = state.claudeVersion?.version ?? null;
  if (claudePath && !claude) claude = (await claudeVersionOf({ claudePath, cached: null, exec: ctx.exec, env, now })).version;
  const nodePath = deps.nodePath ?? process.execPath;
  const policy = await readRunnerPolicy(ctx, dec.installPath, nodePath);
  const builtAt = await readBuiltAt(dec.installPath, fs);
  let build = { builtAt, ageDays: null, stale: false };
  if (builtAt) {
    const ageDays = Math.floor((now - Date.parse(`${builtAt}T00:00:00Z`)) / 86_400_000);
    build = { builtAt, ageDays, stale: ageDays > SHIM_LIMITS.BUILD_STALE_DAYS };
  }
  return {
    plugin, schedule, lastTick, pauses, errors, policy, build,
    versions: { shim: SHIM_VERSION, plugin: plugin.version, node: process.versions.node, claude },
    update: { marketplace: SHIM_COMMANDS.marketplaceUpdate, plugin: SHIM_COMMANDS.pluginUpdate },
    generatedAt: new Date(now).toISOString(),
  };
}

export function formatStatus(r, { now = Date.now() } = {}) {
  const l = [];
  l.push(`плагин: ${r.plugin.state}${r.plugin.reason ? ` (${r.plugin.reason})` : ''}${r.plugin.version ? `, версия ${r.plugin.version}` : ''}${r.plugin.drift ? ' [расхождение файлов и CLI, верим CLI]' : ''}`);
  const s = r.schedule;
  if (s.installed === null) l.push('расписание: не удалось определить');
  else if (!s.installed) l.push(`расписание: не установлено (${s.kind}); запуск вручную: run`);
  else l.push(`расписание: установлено (${s.kind}), шаблон v${s.templateVersion ?? '?'}`);
  if (s.templateStale) l.push('расписание устарело — выполните install');
  if (s.broken) l.push(`расписание сломано: нет ${s.missingPaths.join(', ')}, выполните install`);
  if (r.lastTick) l.push(`последний тик: ${r.lastTick.at ?? 'н/д'} (${ageText(r.lastTick.ageMs)}), ${r.lastTick.state ?? 'н/д'}${r.lastTick.reason ? ` (${r.lastTick.reason})` : ''}, код ${r.lastTick.exit ?? 'н/д'}${r.lastTick.phase === 'start' ? ' [тик не завершён]' : ''}`);
  else l.push('последний тик: ещё не было');
  if (r.pauses.length === 0) l.push('паузы: нет');
  for (const p of r.pauses) {
    const until = p.until ? `, до ${new Date(p.until).toISOString()} (через ${Math.max(0, Math.round((p.until - now) / 60_000))} мин)` : '';
    l.push(`пауза ${p.kind}: ${p.reason ?? 'причина не записана'}${until}${p.resetsOn ? `, лимит сбросится ${p.resetsOn}` : ''}`);
  }
  l.push(`политика отправки: ${r.policy.line}`);
  l.push(`версии: node ${r.versions.node}, claude ${r.versions.claude ?? 'не найден'}, shim ${r.versions.shim}`);
  if (r.build.builtAt) l.push(`сборка плагина: ${r.build.builtAt} (${r.build.ageDays} дн.)${r.build.stale ? ` — старше ${SHIM_LIMITS.BUILD_STALE_DAYS} дней, обновите: ${r.update.marketplace} && ${r.update.plugin}` : ''}`);
  else l.push('сборка плагина: дата неизвестна');
  for (const e of r.errors) l.push(`ОШИБКА: ${e}`);
  l.push(`обновление: ${r.update.marketplace} && ${r.update.plugin}`);
  return `${l.join('\n')}\n`;
}

export async function status(opts = {}, deps = {}) {
  const ctx = makeCtx(deps.env, deps);
  let report;
  try { report = await collectStatus(deps); } catch (e) {
    ctx.err(`status: ${errText(e)}\n`);
    return EXIT.FAILURE;
  }
  ctx.out(opts.json ? `${JSON.stringify(report)}\n` : formatStatus(report, { now: ctx.now() }));
  return EXIT.OK;
}

// ---------------- делегирование раннеру: run и policy ----------------

async function delegateToRunner(sub, extra, deps) {
  const ctx = makeCtx(deps.env, deps);
  const { paths, fs, env } = ctx;
  const state = await readShimState(paths, fs);
  const install = isObj(state.install) ? state.install : {};
  const claudePath = locateClaude({ install, env, platform: ctx.platform });
  const files = await readClaudeFiles({ install, env, home: ctx.home, fs });
  let dec = decideLiveness({ installed: files.installed, settings: files.settings, state: state.liveness, now: ctx.now(), exists: (p) => files.present.has(p), claudeFound: Boolean(claudePath) });
  if (dec.needsCli && claudePath) {
    const cli = await queryCli({ claudePath, exec: ctx.exec, env });
    await absorbCli(files, cli, fs);
    dec = decideLiveness({ installed: files.installed, settings: files.settings, cli, state: state.liveness, now: ctx.now(), exists: (p) => files.present.has(p), claudeFound: true });
  }
  if (dec.outcome !== 'active') {
    const why = dec.outcome === 'disabled' ? 'плагин выключен' : 'плагин не найден в кэше';
    ctx.err(`${sub}: ${why} (${dec.reason ?? dec.outcome}); выполните: ${SHIM_COMMANDS.pluginInstallUser}\n`);
    return EXIT.CONFIG;
  }
  const nodePath = deps.nodePath ?? process.execPath;
  return spawnRunner(ctx, nodePath, [join(dec.installPath, 'runtime', 'tick.mjs'), '--contract', String(CONTRACT), sub, ...extra], env);
}

export const run = (opts = {}, deps = {}) => delegateToRunner('run', [], deps);
export const policy = (opts = {}, deps = {}) => delegateToRunner('policy-check', opts.json ? ['--json'] : [], deps);

// ---------------- selftest ----------------

const STUB_TEMPLATES = Object.freeze({
  'com.shar8.agent.plist.tpl': '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>com.shar8.agent</string><key>Shar8TemplateVersion</key><integer>{{TEMPLATE_VERSION}}</integer><key>P</key><array><string>{{LOADER}}</string></array><key>E</key><string>{{PATH}}</string><key>L</key><string>{{LOGDIR}}</string></dict></plist>\n',
  'shar8-agent.service.tpl': '# shar8-template: {{TEMPLATE_VERSION}}\n[Service]\nEnvironment="PATH={{PATH}}"\nExecStart=/bin/sh "{{LOADER}}" tick\n',
  'shar8-agent.timer.tpl': '# shar8-template: {{TEMPLATE_VERSION}}\n[Timer]\nOnUnitActiveSec=60s\n',
  'Shar8Agent.xml.tpl': '<?xml version="1.0" encoding="UTF-16"?>\n<Task><D>shar8-template: {{TEMPLATE_VERSION}}</D><U>{{USER_SID}}</U><I>PT1M</I><T>{{EXEC_TIME_LIMIT}}</T><A>{{LAUNCH_JS}} {{NODE}} {{SHIM}}</A></Task>\n',
});

function xmlBalanced(text) {
  const stack = [];
  const re = /<(\/?)([A-Za-z][\w:.-]*)[^>]*?(\/?)>/g;
  let m;
  while ((m = re.exec(text.replace(/<\?[\s\S]*?\?>/g, ''))) !== null) {
    if (m[3] === '/') continue;
    if (m[1] === '/') { if (stack.pop() !== m[2]) return false; } else stack.push(m[2]);
  }
  return stack.length === 0;
}

/** Протокол selftest (M2): без побочных эффектов, диск, планировщик и claude не трогает. */
export async function selftest(deps = {}) {
  const failed = [];
  const checks = ['import', 'liveness', 'paths', 'render'];
  const guard = (name, fn) => { try { if (fn() === false) failed.push(name); } catch { failed.push(name); } };
  guard('import', () => Number.isInteger(SHIM_VERSION) && Number.isInteger(CONTRACT));
  guard('liveness', () => {
    const key = PLUGIN_KEY;
    const mk = (entries) => ({ ok: true, value: { version: 2, plugins: entries === undefined ? {} : { [key]: entries } } });
    const settings = (v) => ({ ok: true, value: { enabledPlugins: v === undefined ? {} : { [key]: v } } });
    const u = [{ scope: 'user', installPath: '/p' }];
    const kinds = [
      decideLiveness({ installed: mk(u), settings: settings(), now: 1 }).outcome === 'active',
      decideLiveness({ installed: mk(u), settings: settings(false), now: 1 }).outcome === 'disabled',
      decideLiveness({ installed: mk([{ scope: 'project', installPath: '/p' }]), settings: settings(), now: 1 }).outcome === 'wrong_scope',
      (() => { const a = decideLiveness({ installed: mk(undefined), settings: settings(), now: 1 }); return a.outcome === 'absent' && !a.remove && decideLiveness({ installed: mk(undefined), settings: settings(), state: a.state, now: 2 }).remove === true; })(),
      decideLiveness({ installed: { ok: false, reason: 'json' }, settings: settings(), now: 1, claudeFound: false }).outcome === 'unreadable',
    ];
    return kinds.every(Boolean);
  });
  guard('paths', () => ['darwin', 'linux', 'win32'].every((platform) => {
    const home = platform === 'win32' ? 'C:\\Users\\u' : '/home/u';
    const p = pathsFor({ platform, home, env: platform === 'win32' ? { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } : {} });
    return p.layout === 1 && p.shim.endsWith('shim.mjs') && p.stateDir.includes(APP_DIR) && p.heartbeat.startsWith(p.stateDir) && p.envFile.startsWith(p.configDir);
  }));
  guard('render', () => {
    const mac = pathsFor({ platform: 'darwin', home: '/home/m' });
    const lin = pathsFor({ platform: 'linux', home: '/home/u' });
    const win = pathsFor({ platform: 'win32', home: 'C:\\Users\\u', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } });
    const common = { nodePath: '/n/node', loaderPath: '/l/tick.sh', shimPath: '/l/shim.mjs', pathEnv: '/a:/b', logDir: '/logs', userSid: 'S-1-5-21-1', execTimeLimit: 'PT1H' };
    const plist = renderUnits('launchd', { ...common, paths: mac }, STUB_TEMPLATES).files[0].content;
    const units = renderUnits('systemd', { ...common, paths: lin }, STUB_TEMPLATES).files;
    const xml = decodeUtf16le(renderUnits('schtasks', { ...common, paths: win }, STUB_TEMPLATES).files[0].content);
    return xmlBalanced(plist) && /Shar8TemplateVersion<\/key><integer>1</.test(plist)
      && units.every((f) => f.content.includes('# shar8-template: 1')) && xml.includes('PT1M');
  });
  const out = { ok: failed.length === 0, shimVersion: SHIM_VERSION, contract: CONTRACT, checks, failed };
  (deps.stdout ?? ((t) => process.stdout.write(t)))(`${JSON.stringify(out)}\n`);
  return out.ok ? EXIT.OK : EXIT.CONFIG;
}

// ---------------- CLI ----------------

/** Команда `unregister-detached <platform>`: отсоединённый процесс снимает регистрацию через 1 с (файлы уже удалены). */
async function unregisterDetached(argv, deps) {
  const ctx = makeCtx(deps.env, { ...deps, platform: argv[0] || deps.platform });
  await ctx.sleep(deps.detachDelayMs ?? 1000);
  const state = await readShimState(ctx.paths, ctx.fs);
  const adapter = adapterOf(ctx, state.install);
  if (!adapter) return EXIT.CONFIG;
  try { await adapter.deregister(); return EXIT.OK; } catch (e) {
    await heartbeatEnd(ctx.paths, { state: 'unregister_failed', reason: errText(e).slice(0, 120), exit: 0, shimVersion: SHIM_VERSION }, ctx.now(), ctx.fs).catch(() => {});
    return EXIT.FAILURE;
  }
}

async function askConfirm(question) {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); }));
}

/** Диспетчер shim: `node shim.mjs <tick|status|run|uninstall|policy|selftest|unregister-detached|--version>`. Возвращает код выхода. */
export async function main(argv, env = process.env, deps = {}) {
  const [cmd, ...rest] = argv;
  const json = rest.includes('--json');
  const d = { ...deps, env };
  switch (cmd) {
    case 'tick': return tick({ argv: rest, env, deps: d });
    case 'status': return status({ json }, d);
    case 'run': return run({}, d);
    case 'policy': return policy({ json }, d);
    case 'uninstall': return uninstall({ purge: rest.includes('--purge') }, { isTTY: process.stdin.isTTY, confirm: askConfirm, ...d });
    case 'selftest': return selftest(d);
    case 'unregister-detached': return unregisterDetached(rest, d);
    case '--version': (d.stdout ?? ((t) => process.stdout.write(t)))(`shar8-agent shim ${SHIM_VERSION} contract ${CONTRACT}\n`); return EXIT.OK;
    default:
      (d.stderr ?? ((t) => process.stderr.write(t)))('usage: shim.mjs <tick|status [--json]|run|policy [--json]|uninstall [--purge]|selftest|--version>\n');
      return EXIT.FAILURE;
  }
}

/** Файл запущен как программа (а не импортирован). Сравнение по realpath: ~/.config или /var могут быть симлинками, тогда argv[1] и import.meta.url расходятся. */
export function isEntryFile(argv1 = process.argv[1], metaUrl = import.meta.url) {
  if (!argv1) return false;
  try { return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl)); } catch { return false; }
}

if (isEntryFile()) {
  process.exitCode = await main(process.argv.slice(2)).catch(() => EXIT.FAILURE);
}

