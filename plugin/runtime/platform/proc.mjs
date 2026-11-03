// Запуск ребёнка и остановка ВСЕГО дерева процессов (M5, ADR-020 п. 1, C6).
// POSIX: своя группа процессов (detached) и kill(-pid). win32: без detached, windowsHide:true везде,
// taskkill /PID <pid> /T /F — только пока ребёнок не вышел (после exit PID может быть чужим);
// .cmd/.bat — только через cmd.exe с windowsVerbatimArguments и проверкой аргументов.
// Платформа и системные функции — параметры; по умолчанию настоящие.

import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { win32 } from 'node:path';

/** Аргумент для cmd.exe содержит символ, который нельзя безопасно передать (" % ^ & | < > или перевод строки). */
export class UnsafeArgError extends Error {
  constructor(message = 'argument is not safe for cmd.exe') { super(message); this.name = 'UnsafeArgError'; }
}

const UNSAFE = /["%^&|<>\r\n\0]/;
const BATCH = /\.(cmd|bat)$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Значение переменной окружения Windows без учёта регистра имени. */
export function winEnv(env, name) {
  const upper = name.toUpperCase();
  for (const [k, v] of Object.entries(env || {})) if (k.toUpperCase() === upper && typeof v === 'string' && v) return v;
  return undefined;
}

/** Абсолютный путь системной утилиты Windows (cwd ребёнка — песочница: поиск «сначала в cwd» недопустим). */
export function winSystemTool(env, exe) {
  const root = winEnv(env, 'SystemRoot') || winEnv(env, 'windir') || 'C:\\Windows';
  return win32.join(root, 'System32', exe);
}

function quoteForCmd(value) {
  if (UNSAFE.test(value)) throw new UnsafeArgError();
  return value === '' || /[\s,;=()!]/.test(value) ? `"${value}"` : value;
}

/**
 * @param {{platform?: string, spawnImpl?: Function, execFileImpl?: Function, killImpl?: Function, env?: object}} [deps]
 */
export function createProc({
  platform = process.platform, spawnImpl = nodeSpawn, execFileImpl = nodeExecFile, killImpl = process.kill.bind(process), env = process.env,
} = {}) {
  const win = platform === 'win32';
  const tracked = new Set();

  const exec = (file, args) => new Promise((resolve) => {
    try {
      execFileImpl(file, args, { windowsHide: true }, (err) => resolve({ err: err || null }));
    } catch (err) { resolve({ err }); }
  });

  function buildCall(cmd, args) {
    if (!win || !BATCH.test(cmd)) return { file: cmd, args, extra: {} };
    const line = [cmd, ...args].map(quoteForCmd).join(' ');
    const comspec = winEnv(env, 'ComSpec') || winSystemTool(env, 'cmd.exe');
    // /d — без AutoRun, /s /c "…" — внешние кавычки снимает сам cmd.exe.
    return { file: comspec, args: ['/d', '/s', '/c', `"${line}"`], extra: { windowsVerbatimArguments: true } };
  }

  /** @returns {{pid: number|undefined, child: any, exited: Promise<{code: number|null, signal: string|null, error?: Error}>, hasExited: () => boolean}} */
  function spawn(cmd, args = [], opts = {}) {
    const call = buildCall(cmd, args);
    const spawnOpts = { ...opts, ...call.extra, windowsHide: true };
    if (win) delete spawnOpts.detached; else spawnOpts.detached = true;
    const child = spawnImpl(call.file, call.args, spawnOpts);
    let done = false;
    const exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => { done = true; resolve({ code, signal }); });
      child.once('error', (error) => { done = true; resolve({ code: null, signal: null, error }); });
    });
    const handle = { pid: child.pid, child, exited, hasExited: () => done };
    tracked.add(handle);
    exited.then(() => tracked.delete(handle));
    return handle;
  }

  async function stopTree(handle, graceMs = 10_000) {
    const pid = handle?.pid;
    if (!Number.isInteger(pid) || pid <= 0) return;
    if (win) {
      if (handle.hasExited()) return;                       // после exit PID может принадлежать чужому процессу
      await exec(winSystemTool(env, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F']);
      await Promise.race([handle.exited, sleep(graceMs)]);
      return;
    }
    try { killImpl(-pid, 'SIGTERM'); } catch (err) { if (err?.code === 'ESRCH') return; }
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {                         // группа могла пережить лидера: ждём её исчезновения
      try { killImpl(-pid, 0); } catch { return; }
      await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
    }
    try { killImpl(-pid, 'SIGKILL'); } catch { /* группы уже нет */ }
  }

  function killAllTracked() {
    for (const handle of [...tracked]) {
      if (handle.hasExited() || !Number.isInteger(handle.pid)) continue;
      if (win) { exec(winSystemTool(env, 'taskkill.exe'), ['/PID', String(handle.pid), '/T', '/F']); continue; }
      try { killImpl(-handle.pid, 'SIGKILL'); } catch { /* уже нет */ }
    }
  }

  return { spawn, stopTree, killAllTracked };
}
