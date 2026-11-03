// Запуск процесса claude (M7): runLaunch берёт результат buildLaunch и запускает его через platform/proc
// (своя группа процессов на POSIX, taskkill /T на Windows), слушает stdout построчно и сверяет первое событие
// system/init с ожидаемым ещё до первого вызова инструмента: расхождение — kill дерева и результат
// `isolation_drift` (поле без значений). Таймаут, отмена демона (shouldAbort, signal), лимит stdout, редакция stderr.
//
// Лимит ходов: `--max-turns` принимается парсером claude 2.1.309, но его нет в `claude --help` (S-INIT).
// Срабатывание проверяется по результату: parseStream отдаёт subtype `error_max_turns`.

import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { createProc } from './platform/proc.mjs';
import { matchInit } from './claude-launch.mjs';

export const STDERR_TAIL = 4096;

const MIN_SECRET_LEN = 6;
const HEADER_LINE = /(authorization|x-proxy-token|proxy-authorization)\s*[:=][^\n]*/gi;
const BEARER = /bearer\s+[A-Za-z0-9._~+\/=-]+/gi;

/** Набор секретов из окружения: значения, их строки и значения «Имя-заголовка: значение». */
export function secretsOf(env = {}) {
  const secrets = new Set();
  for (const v of Object.values(env)) {
    if (typeof v !== 'string') continue;
    if (v.length >= MIN_SECRET_LEN) secrets.add(v);
    for (const line of v.split(/\r?\n/)) if (line.length >= MIN_SECRET_LEN) secrets.add(line.trim());
    for (const line of v.split(/\r?\n/)) {          // «Имя-заголовка: значение» — значение отдельно
      const m = /^[A-Za-z0-9-]+:\s*(.+)$/.exec(line.trim());
      if (m && m[1].length >= MIN_SECRET_LEN) secrets.add(m[1].trim());
    }
  }
  return secrets;
}

/**
 * Хвост stderr для лога (C15): все секреты окружения и строки Authorization / X-Proxy-Token заменены
 * на <redacted>. Длина и sha256 в логе считаются по сырому хвосту.
 */
export function redactStderr(tail, env = {}) {
  const secrets = secretsOf(env);
  let out = tail.replace(HEADER_LINE, '$1: <redacted>').replace(BEARER, 'Bearer <redacted>');
  for (const sec of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(sec).join('<redacted>');
  return out;
}

/**
 * Редактирование по окну (STDERR_TAIL + длина секрета), и только потом обрезка до STDERR_TAIL:
 * секрет на границе хвоста не остаётся обрезанным куском. Неполная первая строка отбрасывается.
 */
export function safeTail(window, truncated, env) {
  let red = redactStderr(window, env);
  if (truncated) { const i = red.indexOf('\n'); red = i >= 0 ? red.slice(i + 1) : ''; }
  if (red.length > STDERR_TAIL) {
    red = red.slice(-STDERR_TAIL);
    const i = red.indexOf('\n');
    red = i >= 0 ? red.slice(i + 1) : '';
  }
  return red;
}

const defaultProc = createProc();

/** Немедленно убивает все живые деревья, запущенные через runLaunch (повторный сигнал демону, SEC06). */
export function killTrackedLaunches() {
  defaultProc.killAllTracked();
}

const MAX_LINE_BUFFER = 1_048_576;

/**
 * @param {object} p
 * @param {{command:string, args:string[], input:string, env:object, expected?:object, extraSecrets?:string[]}} p.launch результат buildLaunch
 * @param {string} [p.cwd] пустая песочница
 * @param {number} [p.timeoutMs]
 * @param {number} [p.pollMs]
 * @param {number} [p.killGraceMs]
 * @param {number} [p.stdoutCapBytes]
 * @param {object|null} [p.expected] ожидаемый init; null отключает сверку; по умолчанию launch.expected
 * @param {object} [p.secretEnv] окружение демона: его значения вырезаются из stderr (SEC05)
 * @param {() => Promise<boolean>|boolean} [p.shouldAbort]
 * @param {AbortSignal} [p.signal]
 * @param {ReturnType<typeof createProc>} [p.proc]
 * @param {(event: object) => void} [p.log]
 * @param {(init: object, match: object) => void} [p.onInit] вызывается один раз на первом init
 * @returns {Promise<{kind:'exit',code,signal,stdout,durationMs}|{kind:'isolation_drift',field,detail?,durationMs}|{kind:'aborted',durationMs}|{kind:'timeout',durationMs}|{kind:'spawn_error',error}>}
 */
export function runLaunch({
  launch, cwd, timeoutMs, pollMs, killGraceMs = 10_000, stdoutCapBytes = 1_048_576, expected = launch?.expected,
  secretEnv = process.env, shouldAbort, signal, proc = defaultProc, log = () => {}, onInit,
}) {
  return new Promise((resolve) => {
    const started = Date.now();
    if (signal?.aborted) { resolve({ kind: 'aborted', durationMs: 0 }); return; }
    const extra = launch.extraSecrets ?? [];
    const allSecrets = extra.length ? { ...secretEnv, ...Object.fromEntries(extra.map((v, i) => [`__extra_secret_${i}`, v])) } : secretEnv;
    const secretLen = Math.min(65_536, Math.max(0, ...[...secretsOf(allSecrets)].map((x) => x.length)));
    const windowLen = STDERR_TAIL + secretLen;

    let handle;
    try {
      handle = proc.spawn(launch.command, launch.args, { stdio: ['pipe', 'pipe', 'pipe'], env: launch.env, cwd });
    } catch (error) { resolve({ kind: 'spawn_error', error }); return; }
    const child = handle.child;

    let settled = false;
    let stopping = null;
    let stdoutBytes = 0;
    const out = [];
    let errTail = '';
    let errTruncated = false;
    let pollTimer = null;
    let timeoutTimer = null;
    let polling = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', onSignal);
      resolve(result);
    };
    const stop = (kind, extraFields = {}) => {
      if (stopping || settled) return;
      stopping = kind;
      proc.stopTree(handle, killGraceMs).then(() => finish({ kind, ...extraFields, durationMs: Date.now() - started }));
    };
    const onSignal = () => stop('aborted');
    signal?.addEventListener('abort', onSignal, { once: true });

    child.once('error', (error) => finish({ kind: 'spawn_error', error }));

    // Первое событие system/init: сверка до первого вызова инструмента.
    const decoder = new StringDecoder('utf8');
    let lineBuf = '';
    let initSeen = expected === null || expected === undefined;
    const scan = (chunk) => {
      lineBuf += decoder.write(chunk);
      let nl;
      while (!initSeen && (nl = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        // SEC09: сообщение модели или результат инструмента ДО system/init — порядок событий нарушен, сверять нечего: изоляция не подтверждена.
        if (event?.type === 'assistant' || event?.type === 'user') {
          initSeen = true;
          lineBuf = '';
          log({ event: 'isolation_drift', field: 'init_order' });
          stop('isolation_drift', { field: 'init_order' });
          break;
        }
        if (event?.type !== 'system' || event.subtype !== 'init') continue;
        initSeen = true;
        lineBuf = '';
        const match = matchInit(event, expected);
        try { onInit?.(event, match); } catch (err) { log({ event: 'on_init_failed', error: String(err?.message || err).slice(0, 120) }); }
        if (match.ok) log({ event: 'claude_init', ok: true, skipped: match.skipped });
        else {
          const detail = match.detail ? { detail: match.detail } : {};
          log({ event: 'isolation_drift', field: match.field, ...detail });
          stop('isolation_drift', { field: match.field, ...detail });
        }
      }
      if (!initSeen && lineBuf.length > MAX_LINE_BUFFER) lineBuf = '';
    };

    child.stdout.on('data', (d) => {
      if (stdoutBytes < stdoutCapBytes) {
        const room = stdoutCapBytes - stdoutBytes;
        const piece = d.length > room ? d.subarray(0, room) : d;
        stdoutBytes += piece.length;
        out.push(piece);
      }
      if (!initSeen) scan(d);
    });
    child.stderr.on('data', (d) => {
      errTail += d.toString('utf8');
      if (errTail.length > windowLen) { errTail = errTail.slice(-windowLen); errTruncated = true; }
    });

    child.on('close', (code, sig) => {
      if (errTail) {
        const raw = errTail.slice(-STDERR_TAIL);
        log({
          event: 'claude_stderr_tail', length: raw.length,
          sha256: createHash('sha256').update(raw).digest('hex'), tail: safeTail(errTail, errTruncated, allSecrets),
        });
      }
      if (stopping || settled) return;
      // SEC09: чистый выход без system/init при включённой сверке — изоляция не подтверждена (ошибки входа/лимита выходят с кодом != 0 и классифицируются отдельно).
      if (!initSeen && code === 0) {
        log({ event: 'isolation_drift', field: 'init_missing' });
        stopping = 'isolation_drift';
        proc.stopTree(handle, killGraceMs).then(() => finish({ kind: 'isolation_drift', field: 'init_missing', durationMs: Date.now() - started }));
        return;
      }
      stopping = 'exit';
      // Остатки группы (дочерние MCP-процессы) не оставляем.
      proc.stopTree(handle, killGraceMs).then(() => finish({
        kind: 'exit', code, signal: sig, stdout: Buffer.concat(out).toString('utf8'), durationMs: Date.now() - started,
      }));
    });

    child.stdin.on('error', () => { /* процесс мог закрыть stdin раньше */ });
    child.stdin.end(launch.input ?? '');

    if (timeoutMs > 0) timeoutTimer = setTimeout(() => stop('timeout'), timeoutMs);
    if (typeof shouldAbort === 'function' && pollMs > 0) {
      pollTimer = setInterval(async () => {
        if (polling || stopping || settled) return;
        polling = true;
        try {
          if (await shouldAbort()) stop('aborted');
        } catch (err) {
          log({ event: 'abort_check_failed', error: String(err?.message || err).slice(0, 120) });
        } finally { polling = false; }
      }, pollMs);
    }
  });
}
