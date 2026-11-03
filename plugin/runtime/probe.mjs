// Проба при установке (FR-D06, DD-11, раздел «Проба при установке»): файлы probe-request.json / probe-result.json с nonce,
// настоящий `claude -p «ответь ok»` с флагами изоляции M7 (только через buildLaunch, C4) БЕЗ queue и claim.
// Сторона раннера: executeProbe. Сторона install: writeProbeRequest, awaitProbeResult, describeProbe. Токен в файлах пробы не пишется.

import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { PROBE, LIMITS_RUN } from './limits.mjs';
import { backoff, readJson, writeJsonAtomic } from './state.mjs';
import { createRunDir } from './run-dir.mjs';
import { buildLaunch } from './claude-launch.mjs';
import { runLaunch } from './claude-run.mjs';
import { ENV_CLASSES, classifyFailure, parseEvents } from './env-check.mjs';
import { parseStream } from './output.mjs';
import { emptyPolicy } from './send-policy.mjs';
import { COMMANDS } from './cli-constants.mjs';

export const PROBE_PROMPT = 'ответь ok';
/** Потолок самого запуска claude в пробе: хватает на вход и один ответ, дольше ждать нечего. */
export const PROBE_RUN_TIMEOUT_MS = 80_000;
export const NONCE_RE = /^[0-9a-f]{16}$/;

export const newNonce = () => randomBytes(8).toString('hex');

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** @param {{nonce:string, via:'scheduler'|'terminal', now?:number}} r */
export async function writeProbeRequest(paths, { nonce, via, now = Date.now() }, { perm } = {}) {
  if (!NONCE_RE.test(nonce)) throw new TypeError('nonce: 16 hex');
  await rm(paths.probeResult, { force: true });                       // старый результат не засчитывается
  await writeJsonAtomic(paths.probeRequest, { v: 1, nonce, at: now, via }, { perm });
}

/** Запрос не старше 10 минут с корректным nonce, иначе null. */
export async function readProbeRequest(paths, { now = Date.now() } = {}) {
  const r = await readJson(paths.probeRequest);
  if (!r.ok || !isObj(r.value)) return null;
  const q = r.value;
  if (!NONCE_RE.test(String(q.nonce)) || !Number.isFinite(q.at) || now - q.at > PROBE.REQUEST_MAX_MS) return null;
  return { nonce: q.nonce, via: q.via === 'terminal' ? 'terminal' : 'scheduler', at: q.at };
}

/** Результат с тем же nonce, иначе null (результат без совпавшего nonce игнорируется). */
export async function readProbeResult(paths, nonce) {
  const r = await readJson(paths.probeResult);
  if (!r.ok || !isObj(r.value) || r.value.nonce !== nonce || typeof r.value.class !== 'string') return null;
  return r.value;
}

/**
 * Ждёт результат пробы: опрос файла, часы и сон внедряются (тесты не ждут по-настоящему).
 * @returns {Promise<object|null>} результат или null (не дождались)
 */
export async function awaitProbeResult(paths, nonce, { timeoutMs = PROBE.WAIT_MS, pollMs = 500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const start = now();
  for (;;) {
    const res = await readProbeResult(paths, nonce);
    if (res) return res;
    if (now() - start >= timeoutMs) return null;
    await sleep(pollMs);
  }
}

const ACTIONS = Object.freeze({
  not_logged_in: 'войдите в Claude Code: выполните `claude` и пройдите вход, затем повторите install',
  auth_failed: 'войдите в Claude Code заново (`claude`) или проверьте ключ API, затем повторите install',
  key_missing: 'в режиме «ключ» нужен ANTHROPIC_API_KEY: повторите install и введите ключ',
  mode_mismatch: 'режим модели не совпадает со входом claude: повторите install и выберите подходящий режим (1 — подписка, 2 — ключ)',
  claude_missing: 'claude не найден: добавьте его в PATH и повторите install',
  claude_too_old: 'обновите claude до 2.1.308 или новее и повторите install',
  node_too_old: 'обновите Node до версии 20 или новее и повторите install',
  claude_unrunnable: 'claude не запускается: проверьте путь и права файла, затем повторите install',
  claude_not_found: 'claude не найден по записанному пути: повторите install',
  claude_crashed: 'claude упал до первого ответа: запустите `claude` вручную и посмотрите ошибку',
  subscription_limit: 'лимит подписки Claude исчерпан: подождите сброса лимита или перейдите на режим «ключ»',
  credit_exhausted: 'баланс API исчерпан: пополните его',
  mcp_server_failed: 'MCP-сервер не запустился: проверьте agent.json',
  isolation_drift: 'изоляция запуска не подтверждена: обновите плагин или сообщите об ошибке',
  plugin_disabled: `плагин выключен: включите его (claude plugin enable shar8-agent@shar8)`,
  wrong_scope: `плагин поставлен не в scope user: ${COMMANDS.pluginInstallUser}`,
  plugin_unavailable: `плагин не найден: ${COMMANDS.pluginInstallUser}`,
  config_error: 'ошибка конфигурации: проверьте env-файл и agent.json (команда status покажет причину)',
  lock_busy: 'идёт другая задача: повторите install позже',
  probe_timeout: 'claude не ответил за отведённое время: проверьте сеть и вход',
  probe_failed: 'claude вернул ошибку: запустите `claude -p "ответь ok"` вручную и посмотрите вывод',
});

/** Что делать пользователю при классе провала пробы. */
export const probeAction = (cls) => ACTIONS[cls] ?? `класс ${cls}: запустите status и посмотрите причину`;

/**
 * Человеческий итог пробы для install.
 * @returns {{ok:boolean, reached:boolean, lines:string[]}}
 */
export function describeProbe(result, { via } = {}) {
  const fromTerminal = (result?.via ?? via) === 'terminal';
  const how = fromTerminal ? 'из терминала, не из планировщика' : 'через планировщик';
  if (!result) return { ok: false, reached: false, lines: [`проба не дошла до \`claude\` (${how}): ответа нет. Таймер оставлен; запустите status и посмотрите последний тик`] };
  if (result.class === 'ok') {
    if (Number.isFinite(result.ms) && result.ms < PROBE.TOO_FAST_MS) {
      return { ok: false, reached: false, lines: [`проба не дошла до \`claude\` (${how}): ответ за ${result.ms} мс — так быстро claude не отвечает. Запустите status и посмотрите последний тик`] };
    }
    const auth = result.authMethod ? `, вход: ${result.authMethod}` : '';
    return { ok: true, reached: true, lines: [`проба ok (${how}): claude ответил «${String(result.answer ?? '').slice(0, 40)}» за ${result.ms} мс${auth}`] };
  }
  return { ok: false, reached: true, lines: [`проба не прошла (${how}): ${result.class}`, `что сделать: ${probeAction(result.class)}`] };
}

// ---------------- сторона раннера ----------------

/** Поля result-события stream-json: текст ответа и признак ошибки. */
function resultOf(stdout) {
  const r = [...parseEvents(stdout)].reverse().find((e) => e.type === 'result');
  return r ? { isError: r.is_error === true, text: String(r.result ?? ''), subtype: r.subtype ?? null } : null;
}

/**
 * Настоящая проба: проверка окружения и `claude -p «ответь ok»` с флагами изоляции. queue и claim не вызываются.
 * Результат всегда записывается в probe-result.json (в том числе провал и lock_busy), запрос удаляется.
 * @returns {Promise<{class:string, ms:number}>}
 */
export async function executeProbe({
  nonce, via = 'scheduler', mode, runEnv, claudePath, claudeKey = null, envCheck, run = runLaunch, launcher = buildLaunch, lock, paths, stateDir = paths.stateDir,
  cwd, secrets = [], log = () => {}, now = Date.now, perm, platform = process.platform, nodePath = process.execPath, signal, passEnv,
  limits = { ...LIMITS_RUN, MAX_TURNS: 2, MAX_BUDGET_USD: '0.25' }, runTimeoutMs = PROBE_RUN_TIMEOUT_MS, createDir = createRunDir,
}) {
  const t0 = now();
  const finish = async (cls, extra = {}) => {
    const ms = Math.max(0, now() - t0);
    const result = { v: 1, nonce, at: now(), ms, class: cls, authMethod: extra.authMethod ?? null, answer: extra.answer ?? null, claudeVersion: extra.claudeVersion ?? null, via };
    try { await writeJsonAtomic(paths.probeResult, result, { perm }); } catch (err) { log({ event: 'probe_write_failed', error: String(err?.message || err).slice(0, 120) }); }
    await rm(paths.probeRequest, { force: true }).catch(() => {});
    log({ event: 'probe', class: cls, ms, via });
    return result;
  };
  if (!lock.acquire()) return finish('lock_busy');
  let runDir = null;
  try {
    const check = await envCheck({ mode, env: runEnv, manual: true });
    if (!check?.ok) {
      const cls = ENV_CLASSES.has(check?.class) ? check.class : 'claude_unrunnable';
      return await finish(cls, { claudeVersion: check?.claudeVersion });
    }
    runDir = createDir({ stateDir, taskId: 'probe', due: null, now: now() }).dir;
    const launch0 = await launcher({
      task: { id: 'probe', title: 'probe', notes: '', due: null }, runDir, agent: { mcpServers: [], tools: [], allowedTools: [], servers: {} }, policy: emptyPolicy(),
      mode, claudePath, env: runEnv, limits, platform, nodePath, paths, claudeVersion: check.claudeVersion, passEnv,
    });
    const launch = { ...launch0, input: PROBE_PROMPT };
    const r = await run({
      launch, cwd, timeoutMs: runTimeoutMs, pollMs: 0, killGraceMs: 5000, stdoutCapBytes: limits.STDOUT_CAP_BYTES,
      secretEnv: { ...runEnv, ...Object.fromEntries(secrets.map((v, i) => [`__secret_${i}`, v])) }, log, signal,
    });
    const base = { authMethod: check.authMethod ?? null, claudeVersion: check.claudeVersion };
    if (r.kind === 'timeout') return await finish('probe_timeout', base);
    if (r.kind === 'aborted') return await finish('probe_failed', base);
    if (r.kind === 'spawn_error') return await finish(classifyFailure({ spawnError: r.error }) ?? 'probe_failed', base);
    if (r.kind === 'isolation_drift') return await finish('isolation_drift', base);
    const parsed = parseStream(r.stdout, { code: r.code, signal: r.signal });
    const res = resultOf(r.stdout);
    if (res && !res.isError && parsed.numTurns > 0) return await finish('ok', { ...base, answer: res.text.replace(/\s+/g, ' ').trim().slice(0, 80) });
    const cls = classifyFailure({ parsed, stdout: r.stdout, code: r.code, signal: r.signal });
    const known = cls && ENV_CLASSES.has(cls) ? cls : 'probe_failed';
    return await finish(known, base);
  } catch (err) {
    log({ event: 'probe_error', error: String(err?.message || err).slice(0, 120) });
    return await finish('probe_failed');
  } finally {
    lock.release();
    if (runDir) { try { rmSync(runDir, { recursive: true, force: true }); } catch { /* срок хранения подчистит */ } }
  }
}

/** Успешная проба снимает запись `env` (раздел «Сброс» таблицы пауз). */
export async function clearEnvPauseAfterProbe(stateDir, { perm } = {}) {
  await backoff.clear(stateDir, 'env', { perm });
}
