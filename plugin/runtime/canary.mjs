// Канарейка семантики хука (ADR-018 п. 7, design M7): допущение «`allow` из PreToolUse открывает инструмент вне
// `--allowedTools`, а `deny` закрывает» проверено только на claude 2.1.308. При смене ключа claude (realpath|size|mtime) и ТОЛЬКО
// при непустой политике раннер запускает claude с заглушкой `canary__ping` (canary-mcp.mjs): разрешённый вызов обязан дойти до
// заглушки, запрещённый — нет. Провал: send_disabled (причина canary), прогон идёт в режиме чтения до смены ключа claude.
// Результат хранится в shim-state.json, раздел `canary`; значений адресатов и текстов в нём нет.
// Живой вызов (около 0,03 USD) выполняется только на реальной машине пользователя; тесты используют поддельный claude.

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLaunch } from './claude-launch.mjs';
import { createRunDir } from './run-dir.mjs';
import { shimState } from './state.mjs';
import { validatePolicy } from './send-policy.mjs';
import { readAudit } from './audit.mjs';
import { createPerm } from './platform/perm.mjs';
import { GATE_PATH } from './runner.mjs';
import { CANARY_SERVER, CANARY_TOOL } from './canary-mcp.mjs';

export const CANARY_MCP_PATH = fileURLToPath(new URL('./canary-mcp.mjs', import.meta.url));
export const CANARY_TOOL_NAME = `mcp__${CANARY_SERVER}__${CANARY_TOOL}`;
export const ALLOWED_TARGET = 'allowed';
export const DENIED_TARGET = 'denied';
export const CANARY_LIMITS = Object.freeze({ MAX_TURNS: 8, MAX_BUDGET_USD: '0.10', TIMEOUT_MS: 120_000 });

/** Синтетическая политика канарейки: один инструмент, один разрешённый адресат. Проходит ту же validatePolicy, что и пользовательская. */
export function canaryPolicyDoc() {
  return {
    version: 2,
    tools: { [CANARY_TOOL_NAME]: { slot: 'canary', list: 'canary_ok', target: [['target']], text: [['text']], extract: 'identity' } },
    allow: { canary_ok: [ALLOWED_TARGET] },
    limits: { canary: 4 },
  };
}

const TASK = {
  title: 'Проверка канарейки',
  notes: `Вызови инструмент ${CANARY_TOOL_NAME} ровно дважды: сначала с target="${ALLOWED_TARGET}" и text="ping", затем с target="${DENIED_TARGET}" и text="ping". `
    + 'Если вызов отклонён, не повторяй его и не ищи обходных путей. Ничего другого не делай и верни status review.',
};

const callsOf = (file) => {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l).target; } catch { return null; } });
  } catch { return []; }
};

/**
 * Чистая оценка итога: что дошло до заглушки и что gate разрешил.
 * @returns {{ conclusive: boolean, ok: boolean, reason: string }}
 */
export function judgeCanary({ calls, attempts }) {
  const reachedAllowed = calls.includes(ALLOWED_TARGET);
  const reachedDenied = calls.includes(DENIED_TARGET);
  if (reachedDenied) return { conclusive: true, ok: false, reason: 'deny_leaked' };         // deny не остановил вызов
  if (reachedAllowed) return { conclusive: true, ok: true, reason: 'ok' };
  if (attempts > 0) return { conclusive: true, ok: false, reason: 'allow_not_reached' };    // gate сказал allow, до заглушки не дошло
  return { conclusive: false, ok: false, reason: 'no_calls' };                              // модель вызова не сделала: вывода нет
}

/**
 * @param {object} p
 * @param {string} p.stateDir
 * @param {string} p.claudePath
 * @param {string} p.claudeKey ключ claude (claudeKeyOf)
 * @param {Function} p.run runLaunch или его подмена
 * @param {string} [p.cwd] песочница
 * @returns {(ctx: {mode: string, env: object, claudeVersion?: string}) => Promise<{ok: boolean, reason: string, cached?: boolean}>}
 */
export function createCanary({
  stateDir, claudePath, claudeKey, run, cwd, perm, platform = process.platform, log = () => {}, paths,
  nodePath = process.execPath, gatePath = GATE_PATH, mcpPath = CANARY_MCP_PATH, now = () => Date.now(), runDirs, passEnv,
}) {
  const writer = perm ?? createPerm({ platform });
  const create = runDirs?.create ?? createRunDir;
  return async function canary({ mode = 'subscription', env = process.env, claudeVersion } = {}) {
    const prev = (await shimState.read(stateDir)).canary;
    if (prev && prev.claudeKey === claudeKey) return { ok: prev.ok === true, reason: String(prev.reason ?? 'cached'), cached: true };

    const runDir = create({ stateDir, taskId: 'canary', due: null, now: now() }).dir;
    const callsFile = join(runDir, 'canary-calls.log');
    const policyFile = join(runDir, 'canary-policy.json');
    const checked = validatePolicy(canaryPolicyDoc());
    if (!checked.ok) return { ok: false, reason: 'canary_policy' };
    await writer.writeSecretFile(policyFile, JSON.stringify(canaryPolicyDoc()));
    const agent = {
      mcpServers: [CANARY_SERVER], tools: [], allowedTools: [],
      servers: { [CANARY_SERVER]: { type: 'stdio', command: nodePath, args: [mcpPath, callsFile] } },
    };
    let launch;
    try {
      launch = await buildLaunch({
        task: TASK, runDir, agent, policy: checked.policy, mode, claudePath, env, limits: CANARY_LIMITS, platform, nodePath, gatePath,
        policyPath: policyFile, paths, claudeVersion, passEnv,
      });
      const r = await run({
        launch, cwd, timeoutMs: CANARY_LIMITS.TIMEOUT_MS, pollMs: 0, killGraceMs: 5000, stdoutCapBytes: 1_048_576, secretEnv: env,
        log: (e) => log({ ...e, canary: true }),
      });
      if (r?.kind !== 'exit') {
        log({ event: 'canary_inconclusive', kind: r?.kind ?? 'none' });
        return { ok: false, reason: 'inconclusive' };
      }
      const attempts = readAudit(runDir).records.filter((x) => x.event === 'attempt').length;
      const verdict = judgeCanary({ calls: callsOf(callsFile), attempts });
      log({ event: 'canary_result', ok: verdict.ok, reason: verdict.reason, conclusive: verdict.conclusive });
      if (!verdict.conclusive) return { ok: false, reason: verdict.reason };
      await shimState.update(stateDir, { canary: { claudeKey, ok: verdict.ok, reason: verdict.reason, at: now() } }, { perm: writer });
      return { ok: verdict.ok, reason: verdict.reason };
    } catch (err) {
      log({ event: 'canary_failed', error: String(err?.message || err).slice(0, 120) });
      return { ok: false, reason: 'canary_error' };
    } finally {
      if (launch?.mcpPath) { try { rmSync(launch.mcpPath, { force: true }); } catch { /* sweep при следующем старте */ } }
    }
  };
}
