// Каталог прогона (M7): runs/<id>-<мс>/ с meta.json, slots/ и audit.jsonl (его пишут хуки gate).
// Права 0700/0600 (C9). Очистка трогает только обычные каталоги с именем по шаблону внутри runs/:
// симлинки не удаляются и не разыменовываются.

import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RUN_KEEP_MS = 14 * 24 * 3600 * 1000;
/** Временный MCP-конфиг прогона (содержит секреты серверов): живёт только пока работает claude. */
export const MCP_FILE = 'mcp.json';
const NAME = /^([A-Za-z0-9_-]{1,40})-(\d{1,16})$/;
const runsOf = (stateDir) => join(stateDir, 'runs');

const safeId = (taskId) => {
  const id = String(taskId ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  return id || 'task';
};

/**
 * claim ({claimedAt}) пишется в meta.json (claimToken не пишется на диск): reaper берёт журнал только из каталога того захвата,
 * который он закрывает (I05). Файл 0600, токен в логи и ответы не идёт.
 * @returns {{ dir: string }}
 */
export function createRunDir({ stateDir, taskId, due, now = Date.now(), claim }) {
  const runs = runsOf(stateDir);
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  const id = safeId(taskId);
  let dir;
  for (let bump = 0; ; bump++) {
    dir = join(runs, `${id}-${now + bump}`);
    try { mkdirSync(dir, { mode: 0o700 }); break; } catch (err) { if (err?.code !== 'EEXIST' || bump > 1000) throw err; }
  }
  mkdirSync(join(dir, 'slots'), { mode: 0o700 });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    v: 1, taskId: String(taskId ?? ''), due: due ?? null, startedAt: now,
    ...(claim ? {
      claimedAt: Number.isFinite(Number(claim.claimedAt)) && claim.claimedAt !== null ? Number(claim.claimedAt) : null,
    } : {}),
  }), { mode: 0o600 });
  return { dir };
}

const isPlainDir = (path) => { try { const st = lstatSync(path); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } };

/**
 * Последний каталог задачи по meta.taskId не старше RUN_KEEP_MS. Если передан claimedAt (даже null),
 * берутся только каталоги с таким же meta.claimedAt; null или число без пары не совпадают ни с чем.
 * @returns {{ dir: string, meta: object } | null}
 */
export function findLatestRunDir({ stateDir, taskId, now = Date.now(), claimedAt }) {
  const byClaim = claimedAt !== undefined;
  const wanted = Number.isFinite(Number(claimedAt)) && claimedAt !== null ? Number(claimedAt) : null;
  let names;
  try { names = readdirSync(runsOf(stateDir)); } catch { return null; }
  let best = null;
  for (const name of names) {
    if (!NAME.test(name)) continue;
    const dir = join(runsOf(stateDir), name);
    if (!isPlainDir(dir)) continue;
    let meta;
    try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); } catch { continue; }
    if (!meta || meta.taskId !== String(taskId) || !Number.isFinite(Number(meta.startedAt))) continue;
    if (now - Number(meta.startedAt) > RUN_KEEP_MS) continue;
    if (byClaim && (wanted === null || meta.claimedAt !== wanted)) continue;
    if (!best || Number(meta.startedAt) > Number(best.meta.startedAt)) best = { dir, meta };
  }
  return best;
}

/**
 * Sweep: удаляет оставшиеся mcp.json во ВСЕХ каталогах прогона (SIGKILL демона не даёт выполниться finally).
 * Вызывать под замком демона: чужой живой прогон не должен существовать. Каталоги не трогаются.
 * @returns {number} сколько файлов удалено
 */
export function sweepMcpConfigs({ stateDir }) {
  let names;
  try { names = readdirSync(runsOf(stateDir)); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!NAME.test(name)) continue;
    const dir = join(runsOf(stateDir), name);
    if (!isPlainDir(dir)) continue;
    const file = join(dir, MCP_FILE);
    try { lstatSync(file); } catch { continue; }
    try { rmSync(file, { force: true }); removed++; } catch { /* останется до следующего раза */ }
  }
  return removed;
}

/** Удаляет каталоги старше keepMs (по метке времени в имени). @returns {number} сколько удалено */
export function pruneRunDirs({ stateDir, now = Date.now(), keepMs = RUN_KEEP_MS }) {
  sweepMcpConfigs({ stateDir });                 // оставшиеся секреты уходят и из каталогов, которые ещё хранятся
  let names;
  try { names = readdirSync(runsOf(stateDir)); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    const m = NAME.exec(name);
    if (!m) continue;
    const dir = join(runsOf(stateDir), name);
    if (!isPlainDir(dir)) continue;
    if (now - Number(m[2]) <= keepMs) continue;
    try { rmSync(dir, { recursive: true, force: true }); removed++; } catch { /* останется до следующего раза */ }
  }
  return removed;
}
