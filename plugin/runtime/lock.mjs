// Замок одного прогона демона: каталог lock.d с файлом pid. Замок мёртвого процесса отбирается,
// release вызывается в finally. Нужен против ручных запусков: планировщик второй экземпляр не стартует.
//
// DD-8. POSIX: pid + живость процесса (kill(pid,0)); EPERM (чужой пользователь) и возраст замка старше RUN_BUDGET_MS + 10 мин — замок брошен (PID переиспользован).
// win32: PID переиспользуются, поэтому живость — по отметке времени: держатель обновляет lock.d/pid
// каждые LOCK.WIN_HEARTBEAT_MS, замок без обновления дольше LOCK.WIN_STALE_MS считается брошенным;
// EPERM при пробе PID — «не наш» процесс (замок брошен). Параметры — только из limits.mjs.

import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { LOCK, RUN_BUDGET_MS } from './limits.mjs';

/** I04/SEC18: POSIX-замок старше бюджета тика с запасом считается брошенным (PID мог быть переиспользован живым процессом). */
export const POSIX_STALE_MS = RUN_BUDGET_MS + 10 * 60_000;

const FRESH_MS = 5000;

/**
 * @param {string} stateDir
 * @param {{pid?: number, platform?: string, now?: () => number, kill?: Function, fs?: object,
 *          setIntervalImpl?: Function, clearIntervalImpl?: Function}} [opts]
 */
export function createLock(stateDir, {
  pid = process.pid, platform = process.platform, now = Date.now, kill = process.kill.bind(process),
  fs = nodeFs, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval,
} = {}) {
  const win = platform === 'win32';
  const dir = join(stateDir, 'lock.d');
  const pidFile = join(dir, 'pid');
  let held = false;
  let timer = null;

  /** 'alive' | 'dead' | 'foreign' (EPERM) */
  function probe(p) {
    if (!Number.isInteger(p) || p <= 0) return 'dead';
    try { kill(p, 0); return 'alive'; } catch (err) { return err?.code === 'EPERM' ? 'foreign' : 'dead'; }
  }

  const ageMs = (path) => now() - fs.statSync(path).mtimeMs;

  function holderAlive() {
    let holder;
    try {
      holder = Number(fs.readFileSync(pidFile, 'utf8').trim());
    } catch {
      // pid ещё не записан: свежий каталог считаем занятым, старый — брошенным.
      try { return ageMs(dir) < FRESH_MS; } catch { return false; }
    }
    if (win) {
      let age;
      try { age = ageMs(pidFile); } catch { return false; }
      if (age >= LOCK.WIN_STALE_MS) return false;               // отметка не обновлялась: брошен
      return probe(holder) !== 'foreign';                       // EPERM — PID уже чужой
    }
    const alive = probe(holder);
    if (alive !== 'alive') return false;                        // мёртв или EPERM: процесс чужого пользователя, PID переиспользован
    try { return ageMs(pidFile) < POSIX_STALE_MS; } catch { return false; }   // живой, но замок старше бюджета тика: брошен
  }

  function startHeartbeat() {
    if (!win) return;
    timer = setIntervalImpl(() => {
      try { fs.writeFileSync(pidFile, `${pid}\n`, { mode: 0o600 }); } catch { /* следующий тик попробует снова */ }
    }, LOCK.WIN_HEARTBEAT_MS);
    timer?.unref?.();
  }

  return {
    stateDir,
    acquire() {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          fs.mkdirSync(dir, { mode: 0o700 });
          fs.writeFileSync(pidFile, `${pid}\n`, { mode: 0o600 });
          held = true;
          startHeartbeat();
          return true;
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
          if (holderAlive()) return false;
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
      return false;
    },
    release() {
      if (!held) return;
      held = false;
      if (timer) { clearIntervalImpl(timer); timer = null; }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
