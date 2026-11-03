#!/usr/bin/env node
// Заглушка-канарейка (ADR-018 п. 7): минимальный MCP-сервер по stdio без внешних зависимостей, один инструмент `ping`.
// Нужна раннеру, чтобы проверить на текущей версии claude семантику хука: `allow` из PreToolUse доходит до инструмента,
// `deny` — нет. Каждый дошедший вызов дописывается строкой в файл из argv[2] (только значение поля `target`, без текстов).
//   node canary-mcp.mjs <файл журнала вызовов>

import { appendFileSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const CANARY_SERVER = 'canary';
export const CANARY_TOOL = 'ping';
const PROTOCOL = '2024-11-05';

const TOOL = Object.freeze({
  name: CANARY_TOOL,
  description: 'Проверочный вызов канарейки: ничего не делает',
  inputSchema: {
    type: 'object',
    properties: { target: { type: 'string' }, text: { type: 'string' } },
    additionalProperties: false,
  },
});

/** Ответ на одно JSON-RPC сообщение или null (уведомления ответа не требуют). `record` вызывается на каждый tools/call. */
export function handle(msg, record = () => {}) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || msg.id === undefined) return null;
  const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : PROTOCOL,
        capabilities: { tools: {} }, serverInfo: { name: CANARY_SERVER, version: '1' },
      });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: [TOOL] });
    case 'tools/call': {
      if (msg.params?.name !== CANARY_TOOL) return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown tool' } };
      const target = msg.params?.arguments?.target;
      record(typeof target === 'string' ? target.slice(0, 40) : '');
      return ok({ content: [{ type: 'text', text: 'pong' }] });
    }
    default: return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } };
  }
}

export function serve(logFile, input = process.stdin, output = process.stdout) {
  const record = (target) => { if (logFile) appendFileSync(logFile, `${JSON.stringify({ tool: CANARY_TOOL, target })}\n`); };
  const rl = createInterface({ input });
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const reply = handle(msg, record);
    if (reply) output.write(`${JSON.stringify(reply)}\n`);
  });
  return rl;
}

const isEntry = () => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isEntry()) serve(process.argv[2]);
