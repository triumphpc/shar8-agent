// Раннер делегирования: один тик = порядок `queue -> reap -> проверка окружения -> claim -> run` (M4, шаги 2..12).
// Конфигурация, сигналы и heartbeat — в tick.mjs. Здесь нет счётчика исполнений и обращения к тарифу (C2):
// отказ claim разбирается только как причина; паузы живут в state.mjs, константы — в limits.mjs.
// Без зависимостей, Node 20+. Секреты и тексты задач в логи не попадают (C15).

import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { toDateStr, datePart } from './vendor/core.js';
import { LIMITS } from './vendor/agent.js';
import { TaskflowRejected, TaskflowUnavailable, TaskflowAuthRejected } from './taskflow-client.mjs';
import { runLaunch, redactStderr } from './claude-run.mjs';
import { buildLaunch } from './claude-launch.mjs';
import { LIMITS_RUN, PAUSE } from './limits.mjs';
import { backoff as defaultBackoff, ladder } from './state.mjs';
import { ENV_CLASSES, classifyFailure, failureReason } from './env-check.mjs';
import { PLUGIN_VERSION } from './version.mjs';
import { parseStream } from './output.mjs';
import { emptyPolicy, sendToolNames } from './send-policy.mjs';
import { pathsFor } from './platform/paths.mjs';
import { createRunDir, findLatestRunDir, pruneRunDirs, sweepMcpConfigs } from './run-dir.mjs';
import { removeMcpConfig } from './mcp-config.mjs';
import { readAudit, buildJournal } from './audit.mjs';

export const GATE_PATH = fileURLToPath(new URL('../hooks/send-gate.mjs', import.meta.url));

/** Версия контракта shim -> раннер (необратима). */
export const CONTRACT = 1;
export const EXIT = Object.freeze({ OK: 0, FAILURE: 1, CONFIG: 78, AUTH: 77 });
/** Переменные env-файла, без которых тик не начинается (+ SHAR8_MODEL_MODE, проверяется в tick.mjs). */
export const REQUIRED_ENV = Object.freeze(['TASKFLOW_MCP_URL', 'TASKFLOW_MCP_TOKEN']);
/** Причины отказа claim уровня задачи; остальные (в том числе неизвестные) — уровень аккаунта. */
export const TASK_LEVEL_REASONS = new Set(['closed', 'not_delegated', 'not_due', 'not_found']);

const MAX_TEXT = 4 * LIMITS.NOTE_MAX;
const errText = (e) => String(e?.message || e).slice(0, 160);

/** Счётчики журнала для лога: только числа, ни адресатов, ни ссылок, ни текстов (C13). */
const journalCounts = (j) => {
  const by = (o) => (j?.entries || []).filter((e) => e.outcome === o).length;
  return { ok: by('ok'), blocked: by('blocked'), error: by('error'), started: by('started'), hiddenBlocked: j?.hidden?.blocked || 0 };
};

/** Состояние heartbeat для класса ошибки окружения. */
const heartbeatStateOf = (cls) => (['node_too_old', 'claude_missing', 'claude_too_old'].includes(cls) ? cls : 'paused_env');

/**
 * @returns {Promise<{outcome:'locked'|'empty'|'unavailable'|'auth_rejected'|'paused'|'env_error'|'done', processed:{id:string,status:string}[],
 *   reaped:string[], exit:number, state:string, reason?:string}>}
 */
export async function runOnce({
  client, run = runLaunch, lock, env = process.env, now = () => new Date(), log = () => {},
  limits = LIMITS_RUN, cwd, signal, stateDir = lock?.stateDir, manual = false, mode = 'subscription',
  envCheck = async () => ({ ok: true }), backoff = defaultBackoff, claudeKey = null, secrets = [],
  command, argsPrefix = [], passEnv, agent, policy: policyIn, policyPath, paths, platform = process.platform,
  nodePath = process.execPath, gatePath = GATE_PATH, claudeVersion, launcher = buildLaunch, canary,
  runDirs = { create: createRunDir, find: findLatestRunDir, prune: pruneRunDirs }, audit = { read: readAudit },
}) {
  if (!stateDir) throw new TypeError('stateDir обязателен: на нём держатся паузы');
  const result = { outcome: 'done', processed: [], reaped: [], exit: EXIT.OK, state: 'ok' };
  // Загруженные на шаге 1 (tick) agent.json и send-policy.json; без них набор пуст: серверов нет, отправка закрыта.
  const agentCfg = agent ?? { mcpServers: [], tools: [], allowedTools: [], servers: {} };
  let policy = policyIn ?? emptyPolicy();
  let send = sendToolNames(policy).length > 0;           // отправка включена только непустой политикой (AC-034)
  const homeDir = env.HOME || env.USERPROFILE || homedir();
  const filePaths = paths ?? pathsFor({ platform, home: homeDir, env });
  const policyFile = policyPath || filePaths.sendPolicy;
  const nowMs = () => now().getTime();
  const redact = (text) => redactStderr(String(text), { ...env, ...Object.fromEntries(secrets.map((v, i) => [`__secret_${i}`, v])) });
  /** Запись паузы не должна ронять тик: на ошибке диска пауза просто не появится. */
  const setPause = async (kind, entry) => {
    try { await backoff.set(stateDir, kind, entry); } catch (err) { log({ event: 'backoff_write_failed', kind, error: errText(err) }); }
  };
  const clearPause = async (kind) => {
    try { await backoff.clear(stateDir, kind); } catch (err) { log({ event: 'backoff_write_failed', kind, error: errText(err) }); }
  };
  /** Ступень лестницы env: пауза ladder(count), затем count + 1. Ручной проход лестницу не двигает (DD-13). */
  const bumpEnv = async (cls) => {
    if (manual) return;
    const prev = (await backoff.read(stateDir, nowMs())).entries.env;
    const count = Number.isInteger(prev?.count) && prev.count > 0 ? prev.count : 0;
    await setPause('env', { reason: cls, until: nowMs() + ladder(count), count: count + 1, at: nowMs() });
  };
  const paused = (state, kind, e) => {
    log({ event: 'paused', kind, reason: e.reason ?? null, ...(Number.isFinite(e.until) ? { until: e.until } : {}) });
    return { ...result, outcome: 'paused', state, reason: e.reason };
  };

  // Шаг 2: активные паузы env/auth/isolation — выход 0 до сети. Ручной run их пропускает.
  if (!manual) {
    const t = nowMs();
    const e = await backoff.active(stateDir, 'env', t);
    if (e) return paused('paused_env', 'env', e);
    const a = await backoff.active(stateDir, 'auth', t);
    if (a) return paused('paused_auth', 'auth', a);
    if (claudeKey) {
      const i = await backoff.active(stateDir, 'isolation', t, { claudeKey, pluginVersion: PLUGIN_VERSION });
      if (i) return paused('isolation_drift', 'isolation', i);
    }
  }

  /** Журнал из каталога прогона: аудит хуков, склеенный по tool_use_id. Сбой чтения даёт unavailable. */
  const readJournal = (dir, due, id) => {
    try { return buildJournal(audit.read(dir), { due }); } catch (err) {
      log({ event: 'journal_unavailable', id, error: errText(err) });
      return { due: due ?? null, entries: [], unavailable: true };
    }
  };

  // Шаг 3: замок.
  if (!lock.acquire()) { log({ event: 'locked' }); return { ...result, outcome: 'locked', state: 'locked' }; }
  try {
    const today = toDateStr(now());                       // локальная дата машины (C4, C8)
    // Остатки mcp.json после SIGKILL прошлого прогона (под замком, живых прогонов нет): и при send=off, чтобы секреты не залёживались.
    try { const n = sweepMcpConfigs({ stateDir }); if (n) log({ event: 'mcp_config_swept', count: n }); } catch (err) { log({ event: 'mcp_sweep_failed', error: errText(err) }); }
    try { runDirs.prune({ stateDir, now: nowMs() }); } catch (err) { log({ event: 'prune_failed', error: errText(err) }); }
    log({ event: 'send_mode', send, tools: sendToolNames(policy).length });

    // Шаг 4: queue.
    let q;
    try { q = await client.queue({ today }); } catch (err) {
      if (err instanceof TaskflowAuthRejected) {
        log({ event: 'auth_rejected', step: 'queue', status: err.status });
        await setPause('auth', { reason: `http_${err.status}`, until: nowMs() + PAUSE.AUTH_MS, at: nowMs() });
        return { ...result, outcome: 'auth_rejected', exit: EXIT.AUTH, state: 'auth_rejected' };
      }
      if (err instanceof TaskflowUnavailable) { log({ event: 'unavailable', step: 'queue', error: errText(err) }); return { ...result, outcome: 'unavailable', state: 'unavailable' }; }
      throw err;
    }
    await clearPause('auth');                              // успешный запрос после паузы её снимает

    // Шаг 5: reap зависших.
    for (const s of q.stale || []) {
      // Журнал зависшего прогона берётся из последнего каталога задачи; нет каталога или аудит нечитаем: перевод без журнала.
      let journal;
      try {
        const found = runDirs.find({ stateDir, taskId: s.id, now: nowMs(), claimedAt: s.claimedAt ?? null });
        if (found) journal = buildJournal(audit.read(found.dir), { due: found.meta?.due ?? null });
      } catch (err) { log({ event: 'journal_unavailable', id: s.id, error: errText(err) }); journal = undefined; }
      if (journal && !send && journal.entries.length === 0 && !journal.hidden) journal = undefined;   // без отправки пустой журнал не нужен
      try { await client.reap(journal ? { id: s.id, journal } : { id: s.id }); result.reaped.push(s.id); log({ event: 'reaped', id: s.id }); } catch (err) {
        log({ event: 'reap_refused', id: s.id, error: errText(err) });
      }
    }

    if (!q.queue?.length) { log({ event: 'empty' }); return { ...result, outcome: 'empty', state: 'empty' }; }

    // Шаг 6: пауза claim (queue и reap уже прошли). Ручной run её игнорирует.
    if (!manual) {
      const c = await backoff.active(stateDir, 'claim', nowMs());
      if (c) { log({ event: 'claim_paused', reason: c.reason ?? null }); return { ...result, outcome: 'paused', state: 'paused_claim', reason: c.reason }; }
    }

    // Шаг 7: проверка окружения без модели. Провал — claim не вызывается, квота не тратится.
    const check = await envCheck({ mode, env, manual });
    if (!check?.ok) {
      const cls = ENV_CLASSES.has(check?.class) ? check.class : 'claude_unrunnable';
      log({ event: 'env_error', step: 'check', class: cls, ...(check?.detail ? { detail: redact(check.detail).slice(0, 120) } : {}), manual });
      await bumpEnv(cls);
      return { ...result, outcome: 'env_error', exit: EXIT.CONFIG, state: heartbeatStateOf(cls), reason: cls };
    }
    const version = check?.claudeVersion ?? claudeVersion;   // для эталона init и кэша справки
    if (manual) await clearPause('env');                    // DD-13: успешная проверка ручного прохода снимает env

    // Канарейка семантики хука (ADR-018 п. 7): только при непустой политике и смене ключа claude; провал — прогон в режиме чтения.
    if (send && typeof canary === 'function') {
      let c;
      try { c = await canary({ policy, mode, env, claudeKey, claudeVersion: version, manual }); } catch (err) { c = { ok: false, reason: 'canary_error', error: errText(err) }; }
      if (!c?.ok) {
        log({ event: 'send_disabled', reason: 'canary', ...(c?.reason ? { detail: String(c.reason).slice(0, 40) } : {}) });
        policy = emptyPolicy();
        send = false;
      }
    }

    // Шаг 8: цикл ≤ MAX_TASKS_PER_RUN.
    for (const item of q.queue.slice(0, limits.MAX_TASKS_PER_RUN)) {
      if (signal?.aborted) break;
      // Захват прямо перед запуском, не пачкой: ожидающая задача не истечёт по TTL.
      let claimed;
      try { claimed = await client.claim({ id: item.id, today }); } catch (err) {
        if (err instanceof TaskflowRejected && TASK_LEVEL_REASONS.has(err.reason)) { log({ event: 'claim_refused', id: item.id, reason: err.reason }); continue; }
        if (err instanceof TaskflowRejected) {
          // Уровень аккаунта: следующий claim откажет так же, поэтому break и пауза на час (причина видна в status).
          log(err.reason === 'quota_exceeded' ? { event: 'claim_quota', resetsOn: err.resetsOn } : { event: 'claim_account_refused', reason: err.reason });
          await setPause('claim', { reason: err.reason, until: nowMs() + PAUSE.CLAIM_MS, at: nowMs(), ...(err.resetsOn ? { resetsOn: err.resetsOn } : {}) });
          result.state = 'paused_claim';
          result.reason = err.reason;
          break;
        }
        if (err instanceof TaskflowAuthRejected) {
          log({ event: 'auth_rejected', step: 'claim', id: item.id, status: err.status });
          await setPause('auth', { reason: `http_${err.status}`, until: nowMs() + PAUSE.AUTH_MS, at: nowMs() });
          Object.assign(result, { outcome: 'auth_rejected', exit: EXIT.AUTH, state: 'auth_rejected' });
          break;
        }
        if (err instanceof TaskflowUnavailable) { log({ event: 'unavailable', step: 'claim', id: item.id }); Object.assign(result, { outcome: 'unavailable', state: 'unavailable' }); break; }
        throw err;
      }
      await clearPause('claim');
      const { claimToken } = claimed;
      log({ event: 'claimed', id: item.id });

      const task = claimed.task || item;
      const due = datePart(task.due) ?? null;
      const writeFailed = async (text) => {
        try {
          await client.finish({ id: item.id, claimToken, status: 'failed', text });
          result.processed.push({ id: item.id, status: 'failed' });
        } catch (err) {
          log({ event: err instanceof TaskflowRejected ? 'finish_refused' : 'finish_unavailable', id: item.id, reason: err.reason, error: errText(err) });
          result.processed.push({ id: item.id, status: 'not_written' });
        }
      };

      // C15: без ключа journals сервер старый, отправка прошла бы без журнала. До запуска claude задача падает.
      if (send && !Array.isArray(claimed.journals)) {
        log({ event: 'journals_unsupported', id: item.id });
        await writeFailed('Сервер не поддерживает журнал действий');
        continue;
      }
      // Каталог прогона нужен всегда: в нём файлы запуска (agents.json, settings.json, read-list.json), слоты и журнал gate.
      let runDir;
      try { runDir = runDirs.create({ stateDir, taskId: item.id, due, now: nowMs(), claim: { claimToken, claimedAt: claimed.claimedAt } }).dir; } catch (err) {
        log({ event: 'run_dir_failed', id: item.id, error: errText(err) });
        await writeFailed('Не удалось подготовить каталог прогона');
        continue;
      }

      // Шаг 9: запуск claude. mcp.json (секреты серверов) живёт только вокруг запуска: finally снимает его на любом пути.
      let launch = null;
      let prepFailed = false;
      let r;
      let stderrTail = '';
      try {
        try {
          const previous = send ? claimed.journals.map((j) => j?.text).filter((t) => typeof t === 'string') : [];
          launch = await launcher({
            task, runDir, agent: agentCfg, policy, mode, claudePath: command, env, limits, platform, nodePath, gatePath,
            policyPath: policyFile, paths: filePaths, previous, claudeVersion: version, passEnv,
          });
          // Тестовый шов: интерпретатор и скрипт вместо бинаря (`node fake-claude.mjs <аргументы claude>`).
          if (argsPrefix.length) launch = { ...launch, args: [...argsPrefix, ...launch.args] };
          if (launch.mcpPath) log({ event: 'mcp_config', id: item.id, servers: agentCfg.mcpServers });   // только имена
        } catch (err) {
          prepFailed = true;
          log({ event: 'launch_prepare_failed', id: item.id, reason: err?.reason || err?.name || 'error' });
        }
        if (!prepFailed) {
          r = await run({
            launch, cwd, timeoutMs: limits.TASK_TIMEOUT_MS, pollMs: limits.POLL_MS, killGraceMs: limits.KILL_GRACE_MS,
            stdoutCapBytes: limits.STDOUT_CAP_BYTES, secretEnv: { ...env, ...Object.fromEntries(secrets.map((v, i) => [`__secret_${i}`, v])) },
            // Хвост stderr приходит уже отредактированным (safeTail): берём его для сигнатур и отдаём дальше в журнал.
            log: (e) => { if (e?.event === 'claude_stderr_tail' && typeof e.tail === 'string') stderrTail = e.tail; log(e); },
            signal,
            // Опрос статуса раз в POLL_MS (60 с) без модели: закрытая или снятая задача останавливает прогон.
            shouldAbort: async () => {
              const t = (await client.queue({ today, taskId: item.id })).task;
              return !t || !t.exists || t.done || t.status !== 'in_progress' || t.claimToken !== claimToken;
            },
          });
        }
      } finally {
        if (launch?.mcpPath) {
          try { removeMcpConfig(launch.mcpPath); } catch (err) { log({ event: 'mcp_config_remove_failed', id: item.id, error: errText(err) }); }
        }
      }
      if (prepFailed) {
        await writeFailed('Не удалось подготовить запуск claude');
        continue;
      }

      let outcome;
      let envClass = null;
      let parsed = null;
      if (r.kind === 'aborted') {
        log({ event: signal?.aborted ? 'interrupted' : 'aborted', id: item.id });
        log({ event: 'audit_at_abort', id: item.id, ...journalCounts(readJournal(runDir, due, item.id)) });
        result.processed.push({ id: item.id, status: 'aborted' });
        continue;                                      // при остановке демона цикл выше прервётся; задачу вернёт reaper по TTL
      }
      if (r.kind === 'timeout') outcome = { status: 'failed', text: 'Таймаут 15 минут' };
      else if (r.kind === 'spawn_error') envClass = classifyFailure({ spawnError: r.error });
      else if (r.kind === 'isolation_drift') {
        // Серверы не поднялись — ошибка окружения (лестница env), любое иное расхождение init — запись isolation.
        envClass = r.field === 'mcp_servers' && r.detail === 'not_connected' ? 'mcp_server_failed' : 'isolation_drift';
      } else {
        parsed = parseStream(r.stdout, { code: r.code, signal: r.signal });
        envClass = ENV_CLASSES.has(r.class) ? r.class : classifyFailure({ parsed, stdout: r.stdout, stderrTail: r.stderrTail ?? stderrTail, code: r.code, signal: r.signal });
      }
      if (envClass) outcome = { status: 'failed', text: redact(failureReason(envClass, { code: r.code, signal: r.signal, spawnError: r.error })) };
      else if (!outcome) outcome = parsed;
      const text = outcome.text.length > MAX_TEXT ? outcome.text.slice(0, MAX_TEXT) : outcome.text;
      // Журнал строится из аудита хуков при любом исходе (review, needs_info, failed, таймаут, spawn_error), не из текста модели.
      let journal = readJournal(runDir, due, item.id);
      const journalUseful = send || journal.unavailable || journal.entries.length > 0 || Boolean(journal.hidden);
      if (!journalUseful) journal = undefined;           // без отправки журнал прикладывается, только если gate что-то заблокировал

      // Шаг 11: agent_finish с claimToken; отказ finish — без повторов.
      try {
        const fin = await client.finish(journal
          ? { id: item.id, claimToken, status: outcome.status, text, journal }
          : { id: item.id, claimToken, status: outcome.status, text });
        if (journal && fin?.journalStored !== true) log({ event: 'journal_not_stored', id: item.id });   // результат уже записан, повторять нельзя
        log({ event: 'finished', id: item.id, status: outcome.status, ms: r.durationMs, costUsd: outcome.costUsd ?? undefined, ...(journal ? journalCounts(journal) : {}) });
        result.processed.push({ id: item.id, status: outcome.status });
      } catch (err) {
        // Без повторов (C12): отказ — закрыли или сняли делегирование; недоступность — закроет reaper по TTL.
        log({ event: err instanceof TaskflowRejected ? 'finish_refused' : 'finish_unavailable', id: item.id, reason: err.reason, error: errText(err) });
        result.processed.push({ id: item.id, status: 'not_written' });
      }

      if (envClass) {
        // Ошибка окружения после claim: не больше одного claim на эпизод — остальные задачи тика не берутся.
        log({ event: 'env_error', step: 'run', class: envClass, id: item.id });
        if (envClass === 'isolation_drift') {
          await setPause('isolation', { reason: 'init_mismatch', until: null, at: nowMs(), claudeKey, pluginVersion: PLUGIN_VERSION });
          result.state = 'isolation_drift';
        } else {
          await bumpEnv(envClass);
          result.state = heartbeatStateOf(envClass);
        }
        Object.assign(result, { outcome: 'env_error', exit: EXIT.CONFIG, reason: envClass });
        break;
      }
      // Шаг 12: claude отработал (любой исход, кроме ошибки окружения) — запись env и счётчик снимаются.
      await clearPause('env');
    }
    return result;
  } finally {
    lock.release();
  }
}
