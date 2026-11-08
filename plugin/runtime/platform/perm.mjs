// Секретные файлы и каталоги: права (M5, ADR-020 п. 1, C7).
// POSIX: 0600/0700, владелец, O_NOFOLLOW|O_EXCL. win32: по SID и SDDL (`icacls <путь> /save`, UTF-16LE);
// имена принципалов и текст вывода icacls НЕ разбираются (локализованы, OEM-кодировка).
// Нельзя проверить -> `unverifiable` (политика закрыта, install отказывает).

import * as fsp from 'node:fs/promises';
import { constants as FC } from 'node:fs';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { winSystemTool } from './proc.mjs';

export class PermError extends Error {
  constructor(reason, message = reason) { super(message); this.name = 'PermError'; this.reason = reason; }
}

const MAX_SECRET_BYTES = 65_536;
const SID_RE = /S-1-\d+(?:-\d+)+/;
const SYSTEM_SIDS = new Set(['S-1-5-18', 'SY', 'S-1-5-32-544', 'BA', 'S-1-3-4', 'OW']);
const FULL_RIGHTS = new Set(['FA', 'GA', '0X1F01FF']);

const defaultFs = {
  open: fsp.open, lstat: fsp.lstat, mkdir: fsp.mkdir, chmod: fsp.chmod, rename: fsp.rename,
  readFile: fsp.readFile, rm: fsp.rm, constants: FC,
  getuid: typeof process.getuid === 'function' ? () => process.getuid() : undefined,
  tmpdir,
};

/** Запуск внешней утилиты: { code, stdout }; бросает, если запустить нельзя (нет файла). */
export function defaultExec(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, encoding: 'buffer', timeout: 15_000, ...opts }, (err, stdout, stderr) => {
      if (err && typeof err.code !== 'number') { reject(err); return; }
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

/**
 * Разбор SDDL списка доступа; чистая функция.
 * @returns {{ok:true}|{ok:false, reason:'acl'|'unverifiable'}}
 */
export function evaluateSddl(sddl, userSid) {
  const start = sddl.indexOf('D:');
  if (start < 0) return { ok: false, reason: 'unverifiable' };
  let dacl = sddl.slice(start + 2);
  const sacl = dacl.indexOf('S:');
  if (sacl >= 0) dacl = dacl.slice(0, sacl);
  const open = dacl.indexOf('(');
  const flags = open < 0 ? dacl : dacl.slice(0, open);
  if (!/^[A-Z]*$/.test(flags)) return { ok: false, reason: 'unverifiable' };
  if (!flags.includes('P')) return { ok: false, reason: 'acl' };                 // наследование не снято
  const aces = [...dacl.matchAll(/\(([^()]*)\)/g)].map((m) => m[1].split(';'));
  if (aces.length === 0 || aces.some((a) => a.length < 6)) return { ok: false, reason: 'unverifiable' };
  const user = userSid.toUpperCase();
  let userFull = false;
  for (const [type, , rights, , , rawSid] of aces) {
    const sid = rawSid.toUpperCase();
    if (type !== 'A') return { ok: false, reason: 'acl' };
    if (sid === user) {
      if (!FULL_RIGHTS.has(rights.toUpperCase())) return { ok: false, reason: 'acl' };
      userFull = true;
    } else if (!SYSTEM_SIDS.has(sid)) return { ok: false, reason: 'acl' };
  }
  return userFull ? { ok: true } : { ok: false, reason: 'acl' };
}

/** Вторая непустая строка файла /save — SDDL (первая — путь, он локализован и не разбирается). */
function sddlLine(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length >= 2 && lines[1].includes('D:') ? lines[1] : null;
}
/** icacls /save пишет UTF-16LE (с BOM или без); при провале — UTF-8. Выбирает кодировку, в которой нашёлся SDDL. */
function extractSddl(buf) {
  const bom16 = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
  const tries = bom16 || buf.length % 2 === 0 ? ['utf16le', 'utf8'] : ['utf8', 'utf16le'];
  for (const enc of tries) {
    const line = sddlLine(buf.toString(enc));
    if (line) return line;
  }
  return null;
}

/**
 * @param {{platform?: string, fs?: object, exec?: Function, env?: object}} [deps]
 */
export function createPerm({ platform = process.platform, fs: fsDeps = {}, exec = defaultExec, env = process.env } = {}) {
  const fs = { ...defaultFs, ...fsDeps };
  const win = platform === 'win32';
  let sidCache;

  async function currentSid() {
    if (!win) return null;
    if (sidCache !== undefined) return sidCache;
    try {
      const r = await exec(winSystemTool(env, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
      sidCache = r.code === 0 ? (SID_RE.exec(String(r.stdout))?.[0] ?? null) : null;
    } catch { sidCache = null; }
    return sidCache;
  }

  const icacls = () => winSystemTool(env, 'icacls.exe');

  async function restrictWin(path, isDir) {
    const sid = await currentSid();
    if (!sid) throw new PermError('unverifiable', 'cannot determine current SID');
    const grant = `*${sid}:${isDir ? '(OI)(CI)F' : 'F'}`;
    let r;
    try { r = await exec(icacls(), [path, '/inheritance:r', '/grant:r', grant]); } catch { throw new PermError('unverifiable', 'icacls is not available'); }
    if (r.code !== 0) throw new PermError('acl', 'icacls refused to set the ACL');
  }

  async function writeSecretFile(path, data) {
    const tmp = join(dirname(path), `.${randomBytes(6).toString('hex')}.tmp`);
    const flags = win
      ? fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      : fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
    let fh;
    try {
      fh = await fs.open(tmp, flags, 0o600);
      if (win) await restrictWin(tmp, false);                // ACL до того, как в файле появится секрет
      else await fh.chmod(0o600);
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

  async function ensurePrivateDir(path) {
    await fs.mkdir(path, { recursive: true, mode: 0o700 });
    if (win) { await restrictWin(path, true); return; }
    const st = await fs.lstat(path);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new PermError('not_file', 'not a directory');
    await fs.chmod(path, 0o700);
  }

  async function aclVerdict(path) {
    const sid = await currentSid();
    if (!sid) return { ok: false, reason: 'unverifiable' };
    const tmp = join(fs.tmpdir(), `shar8-acl-${randomBytes(6).toString('hex')}.sddl`);
    try {
      const r = await exec(icacls(), [path, '/save', tmp]);
      if (r.code !== 0) return { ok: false, reason: 'unverifiable' };
      const line = extractSddl(await fs.readFile(tmp));
      return line ? evaluateSddl(line, sid) : { ok: false, reason: 'unverifiable' };
    } catch {
      return { ok: false, reason: 'unverifiable' };
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  const lstatOrReason = async (path) => {
    try { return { st: await fs.lstat(path) }; } catch (err) {
      return { fail: { ok: false, reason: err?.code === 'ENOENT' ? 'missing' : 'unverifiable' } };
    }
  };
  const foreign = (st) => typeof fs.getuid === 'function' && st.uid !== fs.getuid();

  async function checkSecretFile(path, { requireOwner = true, maxSize = MAX_SECRET_BYTES } = {}) {
    const { st, fail } = await lstatOrReason(path);
    if (fail) return fail;
    if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' };
    if (!st.isFile()) return { ok: false, reason: 'not_file' };
    if (st.size > maxSize) return { ok: false, reason: 'size' };
    if (win) return aclVerdict(path);                          // владелец по SDDL не виден: покрывается ACL «только пользователь»
    if ((st.mode & 0o177) !== 0) return { ok: false, reason: 'mode' };
    if (requireOwner && foreign(st)) return { ok: false, reason: 'owner' };
    return { ok: true };
  }

  async function checkPrivateDir(path, { requireOwner = true } = {}) {
    const { st, fail } = await lstatOrReason(path);
    if (fail) return fail;
    if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' };
    if (!st.isDirectory()) return { ok: false, reason: 'not_file' };
    if (win) return aclVerdict(path);
    if ((st.mode & 0o777) !== 0o700) return { ok: false, reason: 'mode' };
    if (requireOwner && foreign(st)) return { ok: false, reason: 'owner' };
    return { ok: true };
  }

  return { writeSecretFile, ensurePrivateDir, checkSecretFile, checkPrivateDir, currentSid };
}
