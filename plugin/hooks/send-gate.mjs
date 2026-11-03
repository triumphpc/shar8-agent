#!/usr/bin/env node
// Gate отправки (M9, ADR-018): хук PreToolUse/PostToolUse/PostToolUseFailure из --settings процесса claude.
// Единственная точка, где решается, откроется ли send-инструмент. Запускается в exec-форме (`command` + `args`),
// без оболочки: ни кавычек, ни `|| exit 2` в тексте хука; fail-closed обеспечивает сам процесс (код 2 при любом сбое).
//   node send-gate.mjs pre  <runDir> <policyPath>   решение allow|deny (или тишина для инструмента чтения)
//   node send-gate.mjs post <runDir>                итог ok
//   node send-gate.mjs fail <runDir>                итог error
// Порядок pre: (1) инструмент в read-list.json -> выход 0 без решения; (2) объявлен в policy.tools -> политика загружена,
// resolveCall, слот вида и общий слот, запись попытки в audit.jsonl ДО allow; (3) любой иной инструмент загруженных
// серверов -> deny undeclared_tool со строкой в журнале.
// Хук не читает окружение для решений, ничего не пишет вне runDir и не меняет вход вызова (updatedInput не используется).
// Значения адресатов и текстов не попадают ни в stdout, ни в stderr, ни в журнал.

import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCall } from '../runtime/send-resolver.mjs';
import { loadSendPolicy } from '../runtime/send-policy.mjs';
import { takeSendSlots } from '../runtime/send-slots.mjs';
import { appendAudit, extractRef } from '../runtime/audit.mjs';
import { createPerm } from '../runtime/platform/perm.mjs';

export const RUN_POLICY_FILE = 'policy.json';
export const STDIN_MAX_BYTES = 1024 * 1024;
export const READ_LIST_FILE = 'read-list.json';
const READ_LIST_MAX_BYTES = 256 * 1024;

const PHRASES = Object.freeze({
  policy: 'политика отправки не прочитана',
  undeclared_tool: 'инструмент не объявлен в политике',
  undeclared_field: 'поле вызова не объявлено в политике',
  type: 'неверный тип поля',
  target_missing: 'адресат не определён',
  not_allowed: 'адресат вне списка',
  field_missing: 'обязательное поле не задано',
  text_missing: 'текст не задан',
  control_chars: 'управляющие символы во входе',
  quick_action: 'быстрое действие в тексте',
  macro: 'запрещённый макрос',
  slot_limit: 'потолок исчерпан',
  total_limit: 'общий потолок исчерпан',
  gate_error: 'сбой проверки',
});

// Словарь причин журнала на сервере (js/agent.js) знает «limit» для потолков; остальные коды идут как есть.
const JOURNAL_REASON = Object.freeze({ slot_limit: 'limit', total_limit: 'limit' });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Общие поля записи из входа хука. */
function baseRecord(input, now) {
  const rec = {
    ts: now,
    tool_use_id: typeof input?.tool_use_id === 'string' && input.tool_use_id !== '' ? input.tool_use_id : `noid-${now}-${randomUUID().slice(0, 8)}`,
  };
  if (typeof input?.agent_type === 'string' && input.agent_type) rec.agent_type = input.agent_type;
  if (input?.agent_id !== undefined && input?.agent_id !== null && input.agent_id !== '') rec.sub = true;
  return rec;
}

/** Замороженный на прогон список точных имён чтения. Нет файла или он битый: пусто (всё иное закрывается, это безопасная сторона). */
export function readReadList(runDir) {
  try {
    const text = readFileSync(join(runDir, READ_LIST_FILE), 'utf8');
    if (text.length > READ_LIST_MAX_BYTES) return new Set();
    const list = JSON.parse(text);
    return new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * SEC04: итоговая политика прогона, записанная раннером в runDir/policy.json (0600) в нормализованном виде.
 * Любое отклонение (права, владелец, форма) — не загружена, gate закрыт.
 */
export async function loadRunPolicy(file, { perm, platform }) {
  try {
    const chk = await (perm ?? createPerm({ platform })).checkSecretFile(file, { requireOwner: true });
    if (!chk?.ok) return { ok: false };
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    if (!isObj(doc) || !isObj(doc.tools) || !isObj(doc.allow) || !isObj(doc.limits)) return { ok: false };
    const nul = (o) => Object.assign(Object.create(null), o);
    return { ok: true, policy: { ...doc, tools: nul(doc.tools), allow: nul(doc.allow), limits: nul(doc.limits) } };
  } catch {
    return { ok: false };
  }
}

/** Путь политики — файл прогона runDir/policy.json (раннер) или send-policy.json пользователя (прямой вызов, тесты). */
const isRunPolicy = (policyPath, runDir) => basename(policyPath) === RUN_POLICY_FILE && resolve(dirname(policyPath)) === resolve(runDir);

/**
 * Решение pre. Побочные эффекты: слоты и строки аудита в runDir.
 * @returns {Promise<{ decision: 'allow'|'deny'|'read', reason: string|null, record?: object }>}
 */
export async function decidePre({ input, runDir, policyPath, now = Date.now(), perm, platform = process.platform }) {
  const base = baseRecord(input, now);
  const tool = typeof input?.tool_name === 'string' ? input.tool_name : '';
  let kind;
  const block = (reason) => {
    // Текст и адресаты в запись не идут: только вид (слот) и имя инструмента из политики.
    const record = { ...base, ...(kind ? { kind } : {}), ...(tool ? { target: tool } : {}), event: 'blocked', reason: JOURNAL_REASON[reason] ?? reason };
    try { appendAudit(runDir, record); } catch { /* журнал недоступен: решение всё равно deny */ }
    return { decision: 'deny', reason, record };
  };
  try {
    if (tool !== '' && readReadList(runDir).has(tool)) return { decision: 'read', reason: null };
    if (tool === '') return block('undeclared_tool');
    const loaded = isRunPolicy(policyPath, runDir)
      ? await loadRunPolicy(policyPath, { perm, platform })
      : await loadSendPolicy(policyPath, { perm: perm ?? createPerm({ platform }), platform });
    if (!loaded.ok) return block('policy');
    const policy = loaded.policy;
    if (!Object.hasOwn(policy.tools, tool)) return block('undeclared_tool');
    kind = policy.tools[tool].slot;
    const r = resolveCall(policy, tool, input?.tool_input);
    if (!r.ok) return block(r.reason);
    const slots = takeSendSlots(runDir, r.call.slot, policy.limits[r.call.slot], base.tool_use_id);
    if (!slots.ok) return block(slots.reason);
    const record = { ...base, kind, target: tool, event: 'attempt' };
    appendAudit(runDir, record);                       // сбой записи: исключение, код 2; слот не возвращается
    return { decision: 'allow', reason: null, record };
  } catch {
    return block('gate_error');
  }
}

/**
 * Итог post (ok) или fail (error). Инструменты чтения в журнал не пишутся. Вид и цель берёт buildJournal из записи attempt
 * того же tool_use_id.
 * @returns {{ record: object|null }}
 */
export function recordPost({ input, runDir, event, now = Date.now() }) {
  const tool = typeof input?.tool_name === 'string' ? input.tool_name : '';
  if (tool !== '' && readReadList(runDir).has(tool)) return { record: null };
  const record = { ...baseRecord(input, now), event };
  if (event === 'ok') {
    const ref = extractRef(input?.tool_response);
    if (ref) record.ref = ref;
  } else {
    const raw = typeof input?.error === 'string' ? input.error : isObj(input?.tool_response) ? input.tool_response.error : '';
    record.reason = oneLine(raw).slice(0, 80) || 'ошибка';
  }
  appendAudit(runDir, record);
  return { record };
}

const verdict = (decision, reason) => JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: decision,
    permissionDecisionReason: decision === 'allow' ? 'send-gate' : PHRASES[reason] ?? PHRASES.gate_error,
  },
});

async function readInput(readStdin) {
  const raw = await readStdin();
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > STDIN_MAX_BYTES) throw new Error('input too large');
  let input;
  try { input = JSON.parse(raw); } catch { throw new Error('input is not json'); }   // без текста исключения: оно цитирует вход
  if (!isObj(input)) throw new Error('input is not an object');
  return input;
}

/**
 * @param {string[]} argv аргументы после имени скрипта
 * @param {() => Promise<string>|string} readStdin весь stdin
 * @param {(s: string) => any} write запись в stdout
 * @param {(code: number) => any} exit завершение процесса
 * @param {{now?: () => number, perm?: object, platform?: string}} [deps]
 */
export async function main(argv, readStdin, write, exit, { now = Date.now, perm, platform } = {}) {
  const [mode, runDir, policyPath] = argv;
  try {
    if (mode === 'pre') {
      if (!runDir || !policyPath) throw new Error('usage: pre <runDir> <policyPath>');
      const input = await readInput(readStdin);
      const r = await decidePre({ input, runDir, policyPath, now: now(), perm, platform });
      if (r.reason === 'gate_error') throw new Error(PHRASES.gate_error);   // упали внутри: код 2, а не решение
      if (r.decision !== 'read') await write(verdict(r.decision, r.reason));
      await exit(0);
      return;
    }
    if (mode === 'post' || mode === 'fail') {
      // Итог необязателен: любой сбой оставляет в журнале attempt без итога («начато, итог не подтверждён»).
      try {
        if (!runDir) throw new Error('usage');
        const input = await readInput(readStdin);
        recordPost({ input, runDir, event: mode === 'post' ? 'ok' : 'error', now: now() });
      } catch { /* молча */ }
      await exit(0);
      return;
    }
    throw new Error('usage: send-gate.mjs pre|post|fail');
  } catch (err) {
    // Страховка: короткая причина без значений, код 2 (блокирующая ошибка для claude).
    if (mode === 'pre' && runDir && err?.message !== PHRASES.gate_error) {
      try { appendAudit(runDir, { ts: now(), tool_use_id: `gate-${now()}-${randomUUID().slice(0, 8)}`, event: 'blocked', reason: 'gate_error' }); } catch { /* ignore */ }
    }
    try { process.stderr.write(`send-gate: ${String(err?.message || 'error').slice(0, 80)}\n`); } catch { /* ignore */ }
    await exit(2);
  }
}

async function readAllStdin() {
  const chunks = [];
  let total = 0;
  for await (const c of process.stdin) {
    total += c.length;
    if (total > STDIN_MAX_BYTES) throw new Error('input too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Запуск как программа — по realpath (симлинк в пути плагина иначе молча отключил бы хук). */
const isEntry = () => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isEntry()) {
  await main(
    process.argv.slice(2), readAllStdin,
    (s) => new Promise((res) => process.stdout.write(s, res)),
    (code) => { process.exitCode = code; setImmediate(() => process.exit(code)); },
  );
}
