// MCP-конфиг прогона: claude запускается с --strict-mcp-config и видит ТОЛЬКО серверы из agent.json (спайк S1 (к):
// deny-префикс mcp__plugin_ не работает). Описания серверов копируются дословно из user-scope `mcpServers` файла
// `.claude.json` (`<CLAUDE_CONFIG_DIR>/.claude.json`, иначе `~/.claude.json`) во временный <runDir>/mcp.json (0600).
// Файл содержит токены в env/headers: в argv его содержимое не попадает, в логи не пишется (только имена
// серверов), удаляется после прогона claude на любом пути, остатки после SIGKILL убирает sweep (run-dir.mjs).

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MCP_FILE } from './run-dir.mjs';
import { createPerm } from './platform/perm.mjs';

export { sweepMcpConfigs } from './run-dir.mjs';

/** Ошибка конфигурации (exit 78). Причина фиксированная: текст файла и значения в сообщение не попадают. */
export class McpConfigError extends Error {
  constructor(reason) {
    super(`mcp_config: ${reason}`);
    this.name = 'McpConfigError';
    this.code = 'config_error';
    this.reason = reason;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v !== '';

/** Путь файла с user-scope mcpServers: тот же корень, что видит claude (CLAUDE_CONFIG_DIR из его окружения, иначе HOME). */
export const userConfigPath = ({ configDir, home }) => {
  const root = nonEmpty(configDir) ? configDir : home;
  if (!nonEmpty(root)) throw new McpConfigError('no_home');
  return join(root, '.claude.json');
};

const MIN_ARG_SECRET = 6;

/** Строки, которые не должны попасть в лог: значения env и headers, строки args (>= 6), url и значения его query. */
export function mcpSecrets(servers) {
  const out = [];
  for (const cfg of Object.values(servers)) {
    for (const bag of [cfg?.env, cfg?.headers]) {
      if (!isObject(bag)) continue;
      for (const v of Object.values(bag)) if (typeof v === 'string' && v !== '') out.push(v);
    }
    if (Array.isArray(cfg?.args)) for (const a of cfg.args) if (typeof a === 'string' && a.length >= MIN_ARG_SECRET) out.push(a);
    if (nonEmpty(cfg?.url)) {
      out.push(cfg.url);
      try {
        const u = new URL(cfg.url);
        for (const v of u.searchParams.values()) if (v !== '') out.push(v);
        if (u.password) out.push(decodeURIComponent(u.password));
      } catch { /* не разбирается как URL: целиком уже добавлен */ }
    }
  }
  return out;
}

const LIVE = new Set();

/** Удаляет файл (нет файла не ошибка). Из LIVE путь уходит только после успешного удаления; `rm` для подмены в тестах. */
export function removeMcpConfig(path, { rm = rmSync } = {}) {
  try { rm(path, { force: true }); } catch (err) {
    if (err?.code !== 'ENOENT') throw err;                  // путь остаётся в LIVE: exit-обработчик повторит
  }
  LIVE.delete(path);
}

/** Синхронно удаляет все файлы, записанные этим процессом: второй сигнал, выход процесса. */
export function removeAllMcpConfigs() {
  for (const path of [...LIVE]) { try { removeMcpConfig(path); } catch { /* sweep при следующем старте */ } }
}

// ---------------- T10: серверы из agent.json ----------------

/**
 * Содержимое user-scope `.claude.json` (разобранное) для loadAgentConfig({userMcp}). Файл не найден, нечитаем или
 * не JSON — McpConfigError с фиксированной причиной; scope local и project не читаются никогда.
 * @throws {McpConfigError} reason: no_home | missing_file | unreadable | invalid
 */
export function readUserMcp({ configDir, home } = {}) {
  const file = userConfigPath({ configDir, home });
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (err) { throw new McpConfigError(err?.code === 'ENOENT' ? 'missing_file' : 'unreadable'); }
  let doc;
  try { doc = JSON.parse(text); } catch { throw new McpConfigError('invalid'); }
  if (!isObject(doc)) throw new McpConfigError('invalid');
  return doc;
}

/**
 * Описания серверов из проверенного agent.json -> содержимое `<runDir>/mcp.json`. Ключи — сырые имена (Claude Code
 * сам нормализует их в mcp__<сервер>__). Пустой набор -> null: файл и флаг `--mcp-config` не нужны.
 * @param {{mcpServers: string[], servers: Record<string, object>}} config результат loadAgentConfig
 * @returns {null|{ config:{mcpServers:object}, found:string[], secrets:string[] }}
 */
export function buildAgentMcpConfig(config) {
  const names = Array.isArray(config?.mcpServers) ? config.mcpServers : [];
  if (names.length === 0) return null;
  const picked = {};
  for (const name of names) {
    if (!Object.hasOwn(config.servers ?? {}, name) || !isObject(config.servers[name])) throw new McpConfigError('invalid');
    picked[name] = JSON.parse(JSON.stringify(config.servers[name]));
  }
  return { config: { mcpServers: picked }, found: names.slice(), secrets: mcpSecrets(picked) };
}

/**
 * `<runDir>/mcp.json` с правами 0600 (ACL на Windows) через platform/perm. Путь регистрируется для удаления при
 * выходе процесса (removeAllMcpConfigs). Удалять после прогона: removeMcpConfig в `finally`.
 * @returns {Promise<string>} путь файла
 */
export async function writeAgentMcpConfig(runDir, cfg, { perm = createPerm() } = {}) {
  const path = join(runDir, MCP_FILE);
  await perm.writeSecretFile(path, JSON.stringify(cfg.config));
  LIVE.add(path);
  return path;
}
