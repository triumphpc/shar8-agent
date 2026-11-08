// Файлы состояния (M10, Data Models): JSON с полем `v`, запись только через writeJsonAtomic (tmp -> fsync -> rename, 0600),
// читатели терпимы к отсутствию, лишним полям и битому JSON. Секретов в этих файлах нет.

import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PAUSE } from './limits.mjs';
import { createPerm } from './platform/perm.mjs';

const MAX_JSON_BYTES = 65_536;
const defaultPerm = () => createPerm();

export async function writeJsonAtomic(path, value, { perm = defaultPerm() } = {}) {
  await perm.writeSecretFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** @returns {Promise<{ok:true,value:any}|{ok:false,reason:'missing'|'json'|'size'}>} */
export async function readJson(path, { max = MAX_JSON_BYTES } = {}) {
  let fh;
  try {
    fh = await open(path, 'r');
    const buf = Buffer.alloc(max + 1);                       // читаем не больше max+1 байт: гигантский файл не грузим в память
    const { bytesRead } = await fh.read(buf, 0, max + 1, 0);
    if (bytesRead > max) return { ok: false, reason: 'size' };
    try { return { ok: true, value: JSON.parse(buf.subarray(0, bytesRead).toString('utf8')) }; } catch { return { ok: false, reason: 'json' }; }
  } catch {
    return { ok: false, reason: 'missing' };
  } finally {
    await fh?.close().catch(() => {});
  }
}

// ---------------- лестница и backoff ----------------

/** Пауза для вида `env` после `count` подряд идущих провалов (0 — первый): 5, 10, 20, 40, 60 минут, дальше потолок. */
export function ladder(count) {
  const steps = PAUSE.ENV_LADDER_MS;
  const i = Number.isInteger(count) && count > 0 ? Math.min(count, steps.length - 1) : 0;
  return steps[i];
}

export const BACKOFF_KINDS = Object.freeze(['auth', 'claim', 'env', 'isolation']);
/** Максимум паузы вида от `now`; запись с `until` дальше считается повреждённой. `isolation` без срока. */
const MAX_UNTIL_MS = Object.freeze({
  auth: PAUSE.AUTH_MS, claim: PAUSE.CLAIM_MS, env: PAUSE.ENV_LADDER_MS[PAUSE.ENV_LADDER_MS.length - 1],
});
const backoffPath = (stateDir) => join(stateDir, 'backoff.json');
const isPlain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function assertKind(kind) {
  if (!BACKOFF_KINDS.includes(kind)) throw new TypeError(`unknown backoff kind: ${String(kind)}`);
}

/** Оставляет корректные записи; запись с меткой из будущего дальше максимума вида (или без числового until) отбрасывается. */
function sanitize(entries, now) {
  const out = {};
  if (!isPlain(entries)) return out;
  for (const kind of BACKOFF_KINDS) {
    const e = entries[kind];
    if (!isPlain(e)) continue;
    if (kind === 'isolation') { if (e.until === null || e.until === undefined) out[kind] = e; continue; }
    if (!Number.isFinite(e.until) || e.until > now + MAX_UNTIL_MS[kind]) continue;
    out[kind] = e;
  }
  return out;
}

async function readEntries(stateDir, now) {
  const r = await readJson(backoffPath(stateDir));
  return r.ok && isPlain(r.value) ? sanitize(r.value.entries, now) : {};
}

async function writeEntries(stateDir, entries, perm) {
  if (Object.keys(entries).length === 0) { await rm(backoffPath(stateDir), { force: true }); return; }
  await writeJsonAtomic(backoffPath(stateDir), { v: 1, entries }, { perm });
}

export const backoff = {
  /** @returns {Promise<{v:1, entries:object}>} только корректные записи, в том числе уже истёкшие (нужен env.count) */
  async read(stateDir, now = Date.now()) {
    return { v: 1, entries: await readEntries(stateDir, now) };
  },
  /** Меняет только запись своего вида; остальные виды остаются как есть. */
  async set(stateDir, kind, entry, { perm, now = Date.now() } = {}) {
    assertKind(kind);
    if (!isPlain(entry)) throw new TypeError('backoff entry must be an object');
    const entries = await readEntries(stateDir, now);
    entries[kind] = { ...entry };
    await writeEntries(stateDir, entries, perm);
  },
  async clear(stateDir, kind, { perm, now = Date.now() } = {}) {
    assertKind(kind);
    const entries = await readEntries(stateDir, now);
    if (!(kind in entries)) return;
    delete entries[kind];
    await writeEntries(stateDir, entries, perm);
  },
  /**
   * Активная запись вида или null. Для `isolation` — пока ключ `claude` и версия плагина совпадают с ctx
   * ({claudeKey, pluginVersion}); для остальных — пока until > now.
   */
  async active(stateDir, kind, now = Date.now(), ctx = {}) {
    assertKind(kind);
    const e = (await readEntries(stateDir, now))[kind];
    if (!e) return null;
    if (kind === 'isolation') return e.claudeKey === ctx.claudeKey && e.pluginVersion === ctx.pluginVersion ? e : null;
    return e.until > now ? e : null;
  },
};

// ---------------- heartbeat ----------------

const heartbeatPath = (stateDir) => join(stateDir, 'heartbeat.json');
const iso = (now) => new Date(now).toISOString();

export const heartbeat = {
  /** Начало тика: phase 'start'. Тик, убитый на середине, виден как 'start' без 'done'. */
  async begin(stateDir, base = {}, { perm, now = Date.now() } = {}) {
    await writeJsonAtomic(heartbeatPath(stateDir), { ...base, v: 1, at: iso(now), phase: 'start' }, { perm });
  },
  /** Конец тика: phase 'done', поля начала (версии и т.п.) сохраняются, result их перекрывает. */
  async end(stateDir, result = {}, { perm, now = Date.now() } = {}) {
    const prev = await readJson(heartbeatPath(stateDir));
    const base = prev.ok && isPlain(prev.value) ? prev.value : {};
    await writeJsonAtomic(heartbeatPath(stateDir), { ...base, ...result, v: 1, at: iso(now), phase: 'done' }, { perm });
  },
};

// ---------------- shim-state.json ----------------

const shimStatePath = (stateDir) => join(stateDir, 'shim-state.json');
export const SHIM_STATE_LAYOUT = 1;

export const shimState = {
  /** Всегда объект: отсутствующий или битый файл даёт пустое состояние с layout 1. */
  async read(stateDir) {
    const r = await readJson(shimStatePath(stateDir));
    const value = r.ok && isPlain(r.value) ? r.value : {};
    return { ...value, v: 1, layout: Number.isInteger(value.layout) ? value.layout : SHIM_STATE_LAYOUT };
  },
  /** Раздел `install` пишет только install (DD-5); остальные разделы не затрагиваются. layout не понижается. */
  async writeInstall(stateDir, install, { perm } = {}) {
    if (!isPlain(install)) throw new TypeError('install must be an object');
    const cur = await shimState.read(stateDir);
    await writeJsonAtomic(shimStatePath(stateDir), { ...cur, install: { ...install } }, { perm });
  },
  /** Разделы shim (`liveness`, `claudeVersion`, `heal`) и `shimVersion`; `install` через writeInstall. */
  async update(stateDir, patch, { perm } = {}) {
    if (!isPlain(patch) || 'install' in patch || 'layout' in patch) throw new TypeError('patch must not touch install or layout');
    const cur = await shimState.read(stateDir);
    await writeJsonAtomic(shimStatePath(stateDir), { ...cur, ...patch }, { perm });
  },
};
