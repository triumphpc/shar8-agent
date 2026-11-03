// Запуск `claude -p` (M7, ADR-017): единственная функция-сборщик аргументов buildLaunch и сверка события init.
// Изоляция фиксирована кодом: пустые источники настроек, allow-список встроенных инструментов, только объявленные
// MCP-серверы, режим dontAsk, агент inline из файла. JSON-аргументы и промпты лежат файлами 0600 в runDir
// (через cmd.exe кавычки в argv искажаются), текст задачи идёт ТОЛЬКО через stdin.
// Классификация сбоев и проверка окружения (classifyFailure, checkEnvironment) живут в env-check.mjs, не здесь.
//
// Эталон init (init-baseline.json) НЕ сверен с живым claude: решение владельца, см. _meta в файле и spike S-INIT.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { LIMITS_RUN } from './limits.mjs';
import { buildChildEnv } from './platform/env-allow.mjs';
import { createPerm } from './platform/perm.mjs';
import { pathsFor } from './platform/paths.mjs';
import { parsePromptFile, buildPrompt } from './prompt.mjs';
import { buildAgentMcpConfig, writeAgentMcpConfig } from './mcp-config.mjs';
import { normalizeServerName } from './agent-config.mjs';
import { emptyPolicy } from './send-policy.mjs';
import { parseStream } from './output.mjs';

export { LIMITS_RUN, parseStream };

export const DELEGATE_AGENT = 'delegate';
export const PERMISSION_MODE = 'dontAsk';
export const FILES = Object.freeze({ agents: 'agents.json', settings: 'settings.json', system: 'system.md', mcp: 'mcp.json', readList: 'read-list.json', policy: 'policy.json' });

const isStr = (v) => typeof v === 'string' && v !== '';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------- эталон init ----------------

let baselineCache;
/** Содержимое init-baseline.json: `{ "<major.minor>": { builtinPlugins, builtinAgents, pluginsMax, agentsMax, verified } }`. */
export function loadBaseline() {
  baselineCache ??= JSON.parse(readFileSync(new URL('./init-baseline.json', import.meta.url), 'utf8'));
  return baselineCache;
}

/** '2.1.309 (Claude Code)' -> '2.1'; не версия -> null. */
export function seriesOf(version) {
  const m = /(\d+)\.(\d+)(?:\.\d+)?/.exec(String(version ?? ''));
  return m ? `${m[1]}.${m[2]}` : null;
}

/**
 * Ожидаемое содержимое init для прогона. Серия без записи в эталоне не блокирует прогон (ADR-017 п. 6: верхней границы
 * версий нет): список плагинов и агентов тогда не проверяется (matchInit возвращает его в `skipped`).
 */
export function expectedInit({ agent, claudeVersion, baseline = loadBaseline() } = {}) {
  const series = seriesOf(claudeVersion);
  const entry = series && isObject(baseline?.[series]) ? baseline[series] : null;
  const out = { permissionMode: PERMISSION_MODE, tools: [...(agent?.tools ?? [])], mcpServers: [...(agent?.mcpServers ?? [])], series: entry ? series : null };
  if (entry) {
    for (const k of ['builtinPlugins', 'builtinAgents', 'pluginsMax', 'agentsMax']) if (entry[k] !== undefined) out[k] = entry[k];
  }
  return out;
}

const nameOf = (x) => (typeof x === 'string' ? x : (isObject(x) && typeof x.name === 'string' ? x.name : null));
const normalize = (raw) => raw.replace(/[^A-Za-z0-9_-]/g, '_');
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const drift = (field, detail) => ({ ok: false, field, ...(detail ? { detail } : {}) });

/** plugins/agents из init: отсутствие поля = пусто (эталон «не сверен с живым»), иначе каждый прогон стал бы drift. */
function names(list) {
  if (list === undefined) return [];
  return Array.isArray(list) ? list.map((x) => nameOf(x) ?? '\u0000bad') : null;
}

/**
 * Сверка первого события system/init с ожидаемым (M7). Расхождение возвращает поле БЕЗ значений
 * (`detail` — фиксированный код: `set_mismatch`, `not_connected`, `shape`).
 * @param {object} initEvent
 * @param {{permissionMode?:string, tools?:string[], mcpServers?:string[], builtinPlugins?:string[]|null, builtinAgents?:string[]|null, pluginsMax?:number, agentsMax?:number}} expected
 * @returns {{ok:true, skipped:string[]}|{ok:false, field:'tools'|'mcp_servers'|'plugins'|'agents'|'permissionMode'|'init', detail?:string}}
 */
export function matchInit(initEvent, expected = {}) {
  if (!isObject(initEvent) || initEvent.type !== 'system' || initEvent.subtype !== 'init') return drift('init', 'shape');
  if (initEvent.permissionMode !== (expected.permissionMode ?? PERMISSION_MODE)) return drift('permissionMode');

  if (!Array.isArray(initEvent.tools)) return drift('tools', 'shape');
  const builtin = new Set(initEvent.tools.map(nameOf).filter((n) => n === null || !n.startsWith('mcp__')));
  if (!sameSet(builtin, new Set(expected.tools ?? []))) return drift('tools', 'set_mismatch');

  if (!Array.isArray(initEvent.mcp_servers)) return drift('mcp_servers', 'shape');
  const servers = initEvent.mcp_servers.map((s) => ({ name: nameOf(s), status: isObject(s) ? s.status : undefined }));
  const got = new Set(servers.map((s) => (s.name === null ? '\u0000bad' : normalize(s.name))));
  if (!sameSet(got, new Set((expected.mcpServers ?? []).map(normalize)))) return drift('mcp_servers', 'set_mismatch');
  if (servers.some((s) => s.status !== 'connected')) return drift('mcp_servers', 'not_connected');

  const skipped = [];
  const plugins = names(initEvent.plugins);
  if (plugins === null) return drift('plugins', 'shape');
  if (Array.isArray(expected.builtinPlugins)) {
    const allowed = new Set(expected.builtinPlugins);
    if (!plugins.every((n) => allowed.has(n))) return drift('plugins', 'set_mismatch');
  } else if (typeof expected.pluginsMax === 'number') {
    if (plugins.length > expected.pluginsMax) return drift('plugins', 'set_mismatch');
  } else skipped.push('plugins');

  const agents = names(initEvent.agents);
  if (agents === null) return drift('agents', 'shape');
  if (Array.isArray(expected.builtinAgents)) {
    const allowed = new Set([...expected.builtinAgents, DELEGATE_AGENT]);
    if (!agents.every((n) => allowed.has(n))) return drift('agents', 'set_mismatch');
  } else if (typeof expected.agentsMax === 'number') {
    if (agents.length > expected.agentsMax) return drift('agents', 'set_mismatch');
  } else skipped.push('agents');
  return { ok: true, skipped };
}

// ---------------- версионный флаг ----------------

const helpCache = new Map();

function defaultHelpExec(file, args, env) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: 15_000, windowsHide: true, env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? '') });
      });
    } catch { resolve({ code: 1, stdout: '' }); }
  });
}

/**
 * Есть ли `--no-session-persistence` в `claude --help` этой версии. Результат кэшируется по `cacheKey` (версия claude,
 * иначе путь бинаря). Любой сбой справки = «нет»: флаг не добавляется. `claude --help` модель не вызывает.
 * @param {{claudePath:string, exec?:(file:string,args:string[],env?:object)=>Promise<{code:number,stdout:string}>, cache?:Map, cacheKey?:string, env?:object}} p
 */
export async function supportsNoSessionPersistence({ claudePath, exec = defaultHelpExec, cache = helpCache, cacheKey, env } = {}) {
  const key = `no-session-persistence:${cacheKey ?? claudePath}`;
  if (cache.has(key)) return cache.get(key);
  let has = false;
  try {
    const r = await exec(claudePath, ['--help'], env);
    has = r?.code === 0 && String(r.stdout ?? '').includes('--no-session-persistence');
  } catch { has = false; }
  cache.set(key, has);
  return has;
}

// ---------------- hooks / settings ----------------

/**
 * Блок hooks для --settings (M9, ADR-018 п. 4): три хука gate в exec-форме `command` + `args` (без кавычек и `|| exit 2`,
 * одинаково в bash, PowerShell и cmd). Matcher покрывает ВСЕ инструменты загруженных серверов `^mcp__(?:<s1>|<s2>)__`:
 * объявленный send-инструмент проходит полную проверку, чтение — по read-list.json, остальное получает deny undeclared_tool.
 * Хук не читает окружение: всё передано аргументами. Без серверов хуки не нужны (вызывающий блок не пишет).
 * @param {{servers:string[], nodePath:string, gatePath:string, runDir:string, policyPath:string}} p servers: имена из agent.json.mcpServers
 */
export function buildHookSettings({ servers, nodePath, gatePath, runDir, policyPath }) {
  for (const [k, v] of Object.entries({ nodePath, gatePath, runDir, policyPath })) {
    if (!isStr(v)) throw new TypeError(`gate.${k} обязателен`);
  }
  const names = [...new Set((Array.isArray(servers) ? servers : []).map((n) => normalizeServerName(String(n))))];
  if (names.length === 0) throw new TypeError('gate.servers обязателен');
  const matcher = `^mcp__(?:${names.map(reEscape).join('|')})__`;
  const entry = (mode, withPolicy) => [{
    matcher,
    hooks: [{ type: 'command', command: nodePath, args: [gatePath, mode, runDir, ...(withPolicy ? [policyPath] : [])], timeout: 10 }],
  }];
  return { PreToolUse: entry('pre', true), PostToolUse: entry('post', false), PostToolUseFailure: entry('fail', false) };
}

const forwardSlashes = (p) => String(p).replace(/\\/g, '/');
/** I01/SEC05: в правилах разрешений Claude Code абсолютный путь начинается с `//` (одинарный `/` отсчитывается от корня проекта); Windows: `//c/<путь>`. */
export function absoluteRulePath(dir) {
  const f = forwardSlashes(dir);
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(f);
  if (drive) return `//${drive[1].toLowerCase()}${drive[2] ?? ''}`;
  return f.startsWith('/') ? `/${f}` : f;
}

/** permissions для --settings (W3): блокировка чтения вне песочницы и явный deny на env-файл, состояние и ~/.claude. */
export function buildPermissions({ paths }) {
  const rule = (dir) => `Read(${absoluteRulePath(dir)}/**)`;
  return { blockReadsOutsideWorkingDirectories: true, deny: [rule(paths.configDir), rule(paths.stateDir), 'Read(~/.claude/**)'] };
}

function homeOf(env, platform) {
  if (platform === 'win32') {
    const key = Object.keys(env ?? {}).find((k) => k.toUpperCase() === 'USERPROFILE');
    return key ? env[key] : undefined;
  }
  return env?.HOME;
}

const promptFile = (name) => parsePromptFile(readFileSync(new URL(`./prompts/${name}`, import.meta.url), 'utf8'));

// ---------------- buildLaunch ----------------

/**
 * Собирает запуск claude: пишет файлы 0600 в runDir и возвращает команду, аргументы, stdin и окружение.
 * Побочный эффект: файлы (`files`) и `mcp.json`, который вызывающий удаляет после прогона (removeMcpConfig, `finally`).
 *
 * @param {object} p
 * @param {{title?:string, notes?:string}} p.task
 * @param {string} p.runDir
 * @param {{mcpServers:string[], tools:string[], allowedTools:string[], servers:object}} [p.agent] результат loadAgentConfig
 * @param {{tools?:object}} [p.policy] политика отправки v2: имена send-инструментов = ключи `tools`
 * @param {'subscription'|'key'} p.mode SHAR8_MODEL_MODE
 * @param {string} p.claudePath абсолютный путь бинаря
 * @param {object} [p.env] окружение демона (из него отбирается окружение claude)
 * @param {object} [p.limits] по умолчанию LIMITS_RUN
 * @param {string} [p.platform]
 * @param {string} [p.nodePath] node для хуков gate
 * @param {string} [p.gatePath] hooks/send-gate.mjs (нужен, когда загружены серверы)
 * @param {string} [p.policyPath] send-policy.json для gate (по умолчанию из pathsFor)
 * @param {{configDir:string, stateDir:string}} [p.paths] иначе pathsFor({platform, home из env})
 * @param {string[]} [p.previous] блоки журнала прежних попыток (только при send-инструментах)
 * @param {string} [p.claudeVersion] строка версии для эталона init и ключа кэша справки
 * @param {boolean} [p.noSessionPersistence] явное значение; иначе решает `claude --help` (helpExec/helpCache)
 * @param {RegExp[]} [p.passEnv] дополнительные шаблоны имён окружения ребёнка (тесты); запреты они не обходят
 * @returns {Promise<{command:string, args:string[], input:string, files:string[], env:Record<string,string>, expected:object, extraSecrets:string[], mcpPath:string|null}>}
 */
export async function buildLaunch({
  task, runDir, agent, policy, mode, claudePath, env = process.env, limits = LIMITS_RUN, platform = process.platform,
  nodePath = process.execPath, gatePath, policyPath, paths, previous = [], claudeVersion,
  noSessionPersistence, helpExec, helpCache, perm, passEnv = [],
} = {}) {
  if (!isObject(task)) throw new TypeError('task обязателен');
  if (!isStr(runDir)) throw new TypeError('runDir обязателен');
  if (mode !== 'subscription' && mode !== 'key') throw new TypeError("mode: 'subscription' или 'key'");
  const abs = platform === 'win32' ? win32.isAbsolute : posix.isAbsolute;
  if (!isStr(claudePath) || !abs(claudePath)) throw new TypeError('claudePath должен быть абсолютным путём');
  const cfg = { mcpServers: [], tools: [], allowedTools: [], servers: {}, ...(agent ?? {}) };
  const lim = { ...LIMITS_RUN, ...(limits ?? {}) };
  const sendTools = Object.keys(policy?.tools ?? {});
  const send = sendTools.length > 0;
  const hasServers = cfg.mcpServers.length > 0;
  const writer = perm ?? createPerm({ platform, env });
  const file = (name) => join(runDir, FILES[name]);
  const written = [];
  const put = async (path, text) => { await writer.writeSecretFile(path, text); written.push(path); };

  const childEnv = buildChildEnv({ platform, env, mode, extra: passEnv });

  const { meta, body } = promptFile('delegate.md');
  await put(file('agents'), JSON.stringify({ [DELEGATE_AGENT]: { description: meta.description ?? 'Delegated TaskFlow task', prompt: body } }));

  const settings = {};
  if (hasServers) {
    // Gate закрывает ВСЕ инструменты загруженных серверов (M9): и при пустой политике, иначе новый write-инструмент откроется молча.
    // SEC04: хук получает ИТОГОВУЮ политику этого прогона (после канарейки: при её провале пустую) из runDir/policy.json 0600,
    // а не send-policy.json с диска: правка файла во время прогона и провал канарейки на хук не влияют.
    await put(file('policy'), JSON.stringify(policy ?? emptyPolicy()));
    settings.hooks = buildHookSettings({ servers: cfg.mcpServers, nodePath, gatePath, runDir, policyPath: file('policy') });
    await put(file('readList'), JSON.stringify([...new Set(cfg.allowedTools)]));      // замороженный на прогон список точных имён чтения
  }
  if (cfg.tools.length > 0) settings.permissions = buildPermissions({ paths: paths ?? defaultPaths(env, platform) });
  await put(file('settings'), JSON.stringify(settings));

  if (send) await put(file('system'), promptFile('send-mode.md').body);

  let mcpPath = null;
  let extraSecrets = [];
  const mcp = buildAgentMcpConfig(cfg);
  if (mcp) {
    mcpPath = await writeAgentMcpConfig(runDir, mcp, { perm: writer });
    written.push(mcpPath);
    extraSecrets = mcp.secrets;
  }

  const noSession = noSessionPersistence ?? await supportsNoSessionPersistence({
    claudePath, exec: helpExec ? (f, a) => helpExec(f, a, childEnv) : (f, a) => defaultHelpExec(f, a, childEnv),
    cache: helpCache, cacheKey: claudeVersion,
  });

  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--setting-sources', '',
    '--tools', cfg.tools.join(','),
    '--strict-mcp-config', ...(mcpPath ? ['--mcp-config', mcpPath] : []),
    '--permission-mode', PERMISSION_MODE,
    ...(cfg.allowedTools.length ? ['--allowedTools', cfg.allowedTools.join(',')] : []),
    '--agents', file('agents'), '--agent', DELEGATE_AGENT,
    ...(send ? ['--append-system-prompt-file', file('system')] : []),
    '--settings', file('settings'),
    '--max-turns', String(lim.MAX_TURNS), '--max-budget-usd', String(lim.MAX_BUDGET_USD),
    ...(noSession ? ['--no-session-persistence'] : []),
  ];

  return {
    command: claudePath, args, input: buildPrompt(task, { send, previous }), files: written, env: childEnv,
    expected: expectedInit({ agent: cfg, claudeVersion }), extraSecrets, mcpPath,
  };
}

function defaultPaths(env, platform) {
  const home = homeOf(env, platform);
  if (!isStr(home)) throw new TypeError('paths или HOME/USERPROFILE обязательны');
  return pathsFor({ platform, home, env });
}
