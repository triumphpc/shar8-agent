#!/usr/bin/env node
// Точка входа раннера для shim (контракт 1, необратим): `node tick.mjs --contract 1 <tick|run>`.
// Шаг 1 алгоритма M4: конфигурация до сети (env-файл с проверкой прав, режим модели, песочница). Дальше — runner.runOnce.
// Пути состояния только из pathsFor; токен живёт в env-файле и в HTTP-заголовке и не попадает в argv, события и ошибки.

import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTaskflowClient, isAllowedMcpUrl } from './taskflow-client.mjs';
import { runLaunch, killTrackedLaunches } from './claude-run.mjs';
import { createLock } from './lock.mjs';
import { ensureSandboxAsync } from './sandbox.mjs';
import { checkSettingsForSend } from './settings-preflight.mjs';
import { readUserMcp, removeAllMcpConfigs } from './mcp-config.mjs';
import { loadAgentConfig, normalizeServerName } from './agent-config.mjs';
import { emptyPolicy, loadSendPolicy, sendToolNames } from './send-policy.mjs';
import { createCanary } from './canary.mjs';
import { loadEnvFile } from './env-file.mjs';
import { pathsFor } from './platform/paths.mjs';
import { createPerm } from './platform/perm.mjs';
import { heartbeat, shimState } from './state.mjs';
import { MODEL_MODES, MODE_ENV, checkEnvironment, claudeKeyOf, resolveClaude } from './env-check.mjs';
import { PLUGIN_VERSION } from './version.mjs';
import { CONTRACT, EXIT, REQUIRED_ENV, runOnce } from './runner.mjs';
import { NONCE_RE, clearEnvPauseAfterProbe, executeProbe, readProbeRequest } from './probe.mjs';
import { writeJsonAtomic } from './state.mjs';

export { CONTRACT, EXIT };

const errText = (e) => String(e?.message || e).slice(0, 160);
/** JSON-строка в stdout: юнит пишет её в журнал тиков. */
const stdoutLog = (e) => console.log(JSON.stringify({ at: new Date().toISOString(), ...e }));
const stderrWrite = (t) => process.stderr.write(t);

/** `--contract N` (или `--contract=N`) выделяется из argv; остальное — подкоманда и её аргументы. */
function parseArgv(argv) {
  const rest = [];
  let contract;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--contract') contract = argv[++i];
    else if (a.startsWith('--contract=')) contract = a.slice('--contract='.length);
    else rest.push(a);
  }
  return { contract, rest };
}

/**
 * Подкоманда `policy-check [--json]` (DD-15): состояние send-policy.json без значений. Сеть, env-файл и claude не нужны.
 * Код 0 — ok, empty, missing; 78 — invalid (код причины и путь первой ошибки формы).
 */
export async function policyCheck(args, env = process.env, deps = {}) {
  const { stdout = (t) => process.stdout.write(t), platform = process.platform } = deps;
  const home = env.HOME || env.USERPROFILE || homedir();
  const paths = pathsFor({ platform, home, env });
  const perm = deps.perm ?? createPerm({ platform });
  const r = await loadSendPolicy(paths.sendPolicy, { perm, platform });
  let out;
  if (r.ok) {
    const tools = Object.keys(r.policy.tools).length;
    out = { state: tools === 0 ? 'empty' : 'ok', tools, ...(r.warnings?.length ? { warnings: [...new Set(r.warnings)] } : {}) };
  } else if (r.reason === 'missing') out = { state: 'missing', reason: 'missing', tools: 0 };
  else out = { state: 'invalid', reason: r.reason, ...(r.path?.length ? { path: r.path } : {}) };
  if (args.includes('--json')) stdout(`${JSON.stringify(out)}\n`);
  else {
    const extra = [out.reason ? `reason=${out.reason}` : '', out.path ? `path=${out.path.join('.')}` : '', out.tools !== undefined ? `tools=${out.tools}` : ''].filter(Boolean).join(' ');
    stdout(`policy: ${out.state}${extra ? ` ${extra}` : ''}\n`);
  }
  return out.state === 'invalid' ? EXIT.CONFIG : EXIT.OK;
}

/**
 * @param {string[]} argv аргументы после `tick.mjs`
 * @param {object} env окружение процесса (PATH, HOME)
 * @param {object} [deps] швы для тестов: log, stderr, run, createClient, killChildGroups, exit, passEnv, platform, perm, envCheck, loadEnv, workDir, now
 * @returns {Promise<number>} код выхода
 */
export async function main(argv, env = process.env, deps = {}) {
  const {
    log = stdoutLog, stderr = stderrWrite, run = runLaunch, createClient = createTaskflowClient, killChildGroups = killTrackedLaunches,
    exit = (c) => process.exit(c), passEnv, platform = process.platform, now,
  } = deps;
  const { contract, rest } = parseArgv(argv);
  if (contract !== String(CONTRACT)) {
    stderr(`contract_mismatch: ожидался --contract ${CONTRACT}\n`);
    return EXIT.CONFIG;
  }
  const sub = rest[0];
  if (sub === 'policy-check') return policyCheck(rest.slice(1), env, deps);
  if (sub !== 'tick' && sub !== 'run' && sub !== 'probe') {
    stderr('usage: tick.mjs --contract 1 <tick [--probe <nonce>]|run|probe <nonce>|policy-check>\n');
    return EXIT.FAILURE;
  }
  // Проба при установке: `tick --probe <nonce>` (или `probe <nonce>`) выполняется ДО queue и claim вместо обычного тика (FR-D06).
  let probeNonce = null;
  if (sub === 'probe') probeNonce = rest[1] ?? '';
  else if (sub === 'tick' && rest.includes('--probe')) probeNonce = rest[rest.indexOf('--probe') + 1] ?? '';
  if (probeNonce !== null && !NONCE_RE.test(probeNonce)) {
    stderr('probe: nonce должен быть 16 hex-символов\n');
    return EXIT.CONFIG;
  }
  const manual = sub === 'run';
  const started = Date.now();
  const home = env.HOME || env.USERPROFILE || homedir();
  const paths = pathsFor({ platform, home, env });
  const { stateDir } = paths;
  const perm = deps.perm ?? createPerm({ platform });
  try { await perm.ensurePrivateDir(stateDir); } catch (err) {
    log({ event: 'config_error', problem: 'state_dir', error: errText(err) });
    return EXIT.CONFIG;
  }
  /** Сбой записи heartbeat тик не роняет. */
  const safe = async (fn) => { try { await fn(); } catch (err) { log({ event: 'heartbeat_failed', error: errText(err) }); } };
  await safe(() => heartbeat.begin(stateDir, { runnerVersion: PLUGIN_VERSION, contract: CONTRACT, node: process.versions.node }, { perm }));
  const end = async (code, state, extra = {}) => {
    await safe(() => heartbeat.end(stateDir, { ...extra, state, exit: code, tickMs: Date.now() - started }, { perm }));
    return code;
  };
  let probeVia = 'scheduler';
  /** Результат пробы при ошибке до её запуска: install не должен ждать 90 секунд впустую. */
  const failProbe = async (cls) => {
    if (probeNonce === null) return;
    const result = { v: 1, nonce: probeNonce, at: Date.now(), ms: 0, class: cls, authMethod: null, answer: null, claudeVersion: null, via: probeVia };
    await safe(() => writeJsonAtomic(paths.probeResult, result, { perm }));
    await safe(() => rm(paths.probeRequest, { force: true }));
  };
  const configError = async (details) => {
    log({ event: 'config_error', ...details });
    await failProbe('config_error');
    return end(EXIT.CONFIG, 'config_error', { reason: details.reason ?? details.problem ?? null });
  };

  // Шаг 1: конфигурация до сети.
  const loadEnv = deps.loadEnv ?? ((file) => loadEnvFile(file, { perm }));
  const loaded = await loadEnv(paths.envFile);
  if (!loaded.ok) return configError({ problem: 'env_file', reason: loaded.reason, ...(loaded.key ? { key: loaded.key } : {}) });   // имя ключа, не значение
  // SEC12: имя неизвестного ключа может оказаться секретом (опечатка в имени, значение в имени): логируем только число.
  if ((loaded.unknown ?? []).length > 0) log({ event: 'env_unknown_key', count: loaded.unknown.length });
  const fileEnv = loaded.env;
  const missing = REQUIRED_ENV.filter((k) => !fileEnv[k]);
  if (missing.length) return configError({ problem: 'env_file', reason: 'missing_key', missing });
  const mode = fileEnv[MODE_ENV];
  if (!mode) return configError({ problem: 'model_mode', reason: 'model_mode_missing' });
  if (!MODEL_MODES.includes(mode)) return configError({ problem: 'model_mode', reason: 'model_mode_invalid' });
  if (mode === 'key' && !fileEnv.ANTHROPIC_API_KEY) return configError({ problem: 'model_mode', reason: 'api_key_missing' });
  if (mode !== 'key' && fileEnv.ANTHROPIC_API_KEY) return configError({ problem: 'model_mode', reason: 'model_mode_conflict' });
  // Окружение прогона: процесс + env-файл; вне режима key ключ API до claude не доходит ни при каких обстоятельствах.
  const runEnv = { ...env, ...fileEnv };
  if (mode !== 'key') delete runEnv.ANTHROPIC_API_KEY;

  let cwd;
  try { cwd = await ensureSandboxAsync({ override: deps.workDir ?? paths.workDir, home, platform, perm }); } catch (err) {
    return configError({ problem: 'sandbox', error: errText(err) });
  }
  const installed = (await shimState.read(stateDir)).install;
  const claudePath = resolveClaude({ claudeBin: fileEnv.CLAUDE_BIN, installedPath: installed?.claudePath, env: runEnv, platform });
  const claudeKey = claudePath ? claudeKeyOf(claudePath) : null;
  let lastCheck = null;
  const realCheck = async ({ mode: m, env: e }) => {
    const cached = (await shimState.read(stateDir)).claudeVersion;
    const r = await checkEnvironment({ mode: m, claudePath, env: e, versionCache: cached, platform });
    if (r.versionRecord) {
      try { await shimState.update(stateDir, { claudeVersion: r.versionRecord }, { perm }); } catch (err) { log({ event: 'shim_state_failed', error: errText(err) }); }
    }
    return r;
  };
  const check = deps.envCheck ?? realCheck;
  const envCheck = async (a) => { lastCheck = await check(a); return lastCheck; };

  if (probeNonce !== null) {
    const req = await readProbeRequest(paths, { now: Date.now() });
    if (req?.nonce === probeNonce) probeVia = req.via;
    const res = await executeProbe({
      nonce: probeNonce, via: probeVia, mode, runEnv, claudePath: claudePath ?? join(stateDir, 'claude-not-found'), claudeKey, envCheck,
      run, lock: createLock(stateDir, { platform }), paths, stateDir, cwd, secrets: [fileEnv.TASKFLOW_MCP_TOKEN, fileEnv.ANTHROPIC_API_KEY].filter(Boolean),
      log, perm, platform, passEnv, ...(deps.launcher ? { launcher: deps.launcher } : {}), ...(now ? { now: () => now().getTime() } : {}),
    });
    if (res.class === 'ok') await safe(() => clearEnvPauseAfterProbe(stateDir, { perm }));
    const code = res.class === 'ok' || res.class === 'lock_busy' ? EXIT.OK : EXIT.CONFIG;
    return end(code, res.class === 'ok' ? 'ok' : (res.class === 'lock_busy' ? 'locked' : 'probe_failed'), { reason: res.class === 'ok' ? 'probe' : res.class, ...(lastCheck?.claudeVersion ? { claude: lastCheck.claudeVersion } : {}) });
  }

  // agent.json и send-policy.json (M4 шаг 1): ошибка agent.json — 78 до сети; политика нечитаема, слишком открыта или невалидна —
  // отправка закрыта, тик идёт в режиме чтения (не 78, событие send_disabled с кодом причины без значений).
  const loadedPolicy = await loadSendPolicy(paths.sendPolicy, { perm, platform });
  let policy = emptyPolicy();
  if (loadedPolicy.ok) {
    policy = loadedPolicy.policy;
    for (const w of loadedPolicy.warnings ?? []) log({ event: 'send_policy_warning', warning: w });
  } else if (loadedPolicy.reason !== 'missing') {
    log({ event: 'send_disabled', reason: loadedPolicy.reason, ...(loadedPolicy.path?.length ? { path: loadedPolicy.path } : {}) });
  }
  let userMcp;
  try { userMcp = readUserMcp({ configDir: runEnv.CLAUDE_CONFIG_DIR, home }); } catch { userMcp = undefined; }   // нет файла: серверы из agent.json не найдутся
  const agentLoaded = loadAgentConfig({ file: paths.agentJson, userMcp, sendTools: sendToolNames(policy), env: runEnv, platform });
  if (!agentLoaded.ok) return configError({ problem: 'agent_config', reason: agentLoaded.code, path: agentLoaded.path });   // путь ключей, не значения
  const agent = agentLoaded.config;
  // Инструмент политики сервера, которого нет среди загруженных, открыть нечем: прогон идёт в режиме чтения (ADR-018 п. 9, не 78).
  const loadedServers = new Set(agent.mcpServers.map(normalizeServerName));
  const reachable = Object.fromEntries(Object.entries(policy.tools).filter(([name]) => loadedServers.has(/^mcp__(.+?)__/.exec(name)?.[1])));
  if (Object.keys(reachable).length < Object.keys(policy.tools).length) log({ event: 'send_server_missing', count: Object.keys(policy.tools).length - Object.keys(reachable).length });
  policy = { ...policy, tools: reachable };
  const sendTools = sendToolNames(policy);
  if (sendTools.length > 0) {
    const pf = checkSettingsForSend({ home, cwd, configDir: runEnv.CLAUDE_CONFIG_DIR, platform, tools: sendTools });
    if (!pf.ok) return configError({ problem: 'settings_allow_send', files: pf.problems.map((p) => ({ file: p.file, reason: p.reason })) });   // без значений правил
  }

  if (createClient === createTaskflowClient && !isAllowedMcpUrl(fileEnv.TASKFLOW_MCP_URL)) return configError({ problem: 'url_not_https' });   // SEC06: токен не уходит по http
  const ac = new AbortController();
  // Повторный сигнал (SEC06): не ждём вежливой остановки, убиваем группу ребёнка и выходим.
  let signals = 0;
  const onSignal = (name) => () => {
    signals++;
    log({ event: 'signal', signal: name, count: signals });
    if (signals === 1) { ac.abort(); return; }
    killChildGroups();
    removeAllMcpConfigs();                        // exit() не даёт выполниться finally: секреты убираем здесь
    exit(128 + (name === 'SIGINT' ? 2 : 15));
  };
  const onTerm = onSignal('SIGTERM');
  const onInt = onSignal('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  process.on('exit', removeAllMcpConfigs);        // последняя страховка: синхронное удаление при любом выходе процесса
  try {
    const out = await runOnce({
      client: createClient({ url: fileEnv.TASKFLOW_MCP_URL, token: fileEnv.TASKFLOW_MCP_TOKEN }),
      run, lock: createLock(stateDir, { platform }), env: runEnv, log, passEnv, ...(now ? { now } : {}),
      command: claudePath ?? join(stateDir, 'claude-not-found'),   // абсолютный несуществующий путь: запуск даст claude_not_found
      cwd, signal: ac.signal, manual, mode, envCheck, claudeKey, stateDir,
      secrets: [fileEnv.TASKFLOW_MCP_TOKEN, fileEnv.ANTHROPIC_API_KEY].filter(Boolean),
      agent, policy, policyPath: paths.sendPolicy, paths, platform,
      // Канарейка хука: только при непустой политике и найденном claude (ADR-018 п. 7); deps.canary подменяет, false отключает.
      ...(sendTools.length > 0 && claudePath && claudeKey && deps.canary !== false
        ? { canary: deps.canary ?? createCanary({ stateDir, claudePath, claudeKey, perm, platform, run, log, paths, cwd, runDirs: deps.runDirs, passEnv }) } : {}),
    });
    log({ event: 'run_end', outcome: out.outcome, processed: out.processed.length, reaped: out.reaped.length });
    return await end(out.exit, out.state, { reason: out.reason ?? null, ...(lastCheck?.claudeVersion ? { claude: lastCheck.claudeVersion } : {}) });
  } catch (err) {
    log({ event: 'unexpected_error', error: errText(err) });
    return end(EXIT.FAILURE, 'unexpected_error', { reason: null });
  } finally {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    process.off('exit', removeAllMcpConfigs);
  }
}

/** Запуск как программа определяется по realpath: каталог плагина может лежать за симлинком (~/.claude), иначе раннер молча не стартует. */
const isEntry = () => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isEntry()) {
  process.exitCode = await main(process.argv.slice(2));
}
