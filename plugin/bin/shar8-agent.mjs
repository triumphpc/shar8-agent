#!/usr/bin/env node
// Диспетчер команд по пути версии (M1): `node <installPath>/bin/shar8-agent.mjs <команда>` — его печатает /shar8-agent:install.
// После установки те же команды вызываются по стабильному пути `node ~/.config/shar8-agent/shim.mjs <команда>`.
// Логика возвращает код выхода и не вызывает process.exit (кроме точки входа ниже).

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXIT } from '../runtime/cli-constants.mjs';
import { install } from '../runtime/cli/install.mjs';
import { policy } from '../runtime/cli/policy.mjs';
import { status } from '../runtime/cli/status.mjs';
import { uninstall } from '../runtime/cli/uninstall.mjs';
import { run, SHIM_VERSION } from '../runtime/shim.mjs';
import { PLUGIN_VERSION } from '../runtime/version.mjs';

const USAGE = `usage: shar8-agent <команда>
  install [--schedule] [--linger] [--url <адрес>] [--mode subscription|key]   установка (только в терминале)
  status [--json]      состояние расписания, пауз и версий
  run                  один ручной проход
  uninstall [--purge]  снять расписание (токен остаётся; --purge удаляет и его)
  policy [--json]      проверка send-policy.json
  --version
`;

/** Разбор флагов install; неизвестный флаг -> { error }. */
export function parseInstallArgs(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--schedule') opts.schedule = true;
    else if (a === '--linger') opts.linger = true;
    else if (a === '--url' || a === '--mode') {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) return { error: `${a}: нужно значение` };
      opts[a.slice(2)] = v;
    } else if (a.startsWith('--url=')) opts.url = a.slice(6);
    else if (a.startsWith('--mode=')) opts.mode = a.slice(7);
    else return { error: `неизвестный аргумент: ${a}` };
  }
  return { opts };
}

/**
 * @param {string[]} argv
 * @param {{io?:object, env?:object, platform?:string, deps?:object}} [ctx]
 * @returns {Promise<number>}
 */
export async function main(argv, ctx = {}) {
  const io = ctx.io ?? { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY) };
  const env = ctx.env ?? process.env;
  const platform = ctx.platform ?? process.platform;
  const deps = ctx.deps ?? {};
  const shimDeps = { env, platform, stdout: (t) => io.stdout.write(t), stderr: (t) => io.stderr.write(t), isTTY: io.isTTY, ...deps };
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'install': {
      const parsed = parseInstallArgs(rest);
      if (parsed.error) { io.stderr.write(`${parsed.error}\n${USAGE}`); return EXIT.FAILURE; }
      return install(parsed.opts, { io, env, platform, deps });
    }
    case 'status': return status({ json: rest.includes('--json') }, shimDeps);
    case 'run': return run({}, shimDeps);
    case 'policy': return policy({ json: rest.includes('--json') }, shimDeps);
    case 'uninstall': return uninstall({ purge: rest.includes('--purge') }, shimDeps);
    case '--version': io.stdout.write(`shar8-agent ${PLUGIN_VERSION} (shim ${SHIM_VERSION})\n`); return EXIT.OK;
    default: io.stderr.write(USAGE); return EXIT.FAILURE;
  }
}

const isEntry = () => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isEntry()) process.exitCode = await main(process.argv.slice(2)).catch((err) => { process.stderr.write(`shar8-agent: ${String(err?.message || err).slice(0, 200)}\n`); return EXIT.FAILURE; });
