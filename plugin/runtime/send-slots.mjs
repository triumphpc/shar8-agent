// Слоты потолков отправки (M9): <runDir>/slots/<слот>-<n>, создаются флагом wx. Первый успех и есть слот.
// Слот не возвращается ни при каком исходе вызова (ADR-006): потолок считает попытки, а не успехи.
// Помимо слота вида (потолок из политики) каждый разрешённый вызов занимает общий слот `_total`
// с потолком SEND_TOTAL_MAX из кода: файлом политики его не поднять (DD-6).

import { closeSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { SEND_LIMITS } from './limits.mjs';

/** Имя общего слота; ведущее «_» в политике запрещено, поэтому слот вида с таким именем невозможен. */
export const TOTAL_SLOT = '_total';
// Имя слота вида совпадает с правилом политики (send-policy.mjs): строчная буква, затем буквы, цифры, «_».
const SLOT_RE = /^(?:[a-z][a-z0-9_]{0,31}|_total)$/;

/**
 * @returns {{ ok: true, n: number } | { ok: false }} ok:false — потолок исчерпан
 * @throws любая ошибка, кроме EEXIST (gate превращает её в deny gate_error)
 */
export function takeSlot(runDir, slot, limit, toolUseId) {
  if (!SLOT_RE.test(String(slot))) throw new TypeError('bad slot kind');
  const max = Number(limit);
  if (!Number.isSafeInteger(max) || max < 0) throw new TypeError('bad limit');
  for (let n = 1; n <= max; n++) {
    let fd;
    try {
      fd = openSync(join(runDir, 'slots', `${slot}-${n}`), 'wx', 0o600);
    } catch (err) {
      if (err?.code === 'EEXIST') continue;
      throw err;
    }
    try { writeSync(fd, String(toolUseId ?? '')); } finally { closeSync(fd); }
    return { ok: true, n };
  }
  return { ok: false };
}

/**
 * Слот вида, затем общий слот. Исчерпан слот вида: общий не трогается. Исчерпан общий: слот вида уже занят (попытка считается).
 * @returns {{ ok: true } | { ok: false, reason: 'slot_limit'|'total_limit' }}
 */
export function takeSendSlots(runDir, slot, limit, toolUseId, totalMax = SEND_LIMITS.SEND_TOTAL_MAX) {
  if (slot === TOTAL_SLOT) throw new TypeError('bad slot kind');
  if (!takeSlot(runDir, slot, limit, toolUseId).ok) return { ok: false, reason: 'slot_limit' };
  if (!takeSlot(runDir, TOTAL_SLOT, totalMax, toolUseId).ok) return { ok: false, reason: 'total_limit' };
  return { ok: true };
}
