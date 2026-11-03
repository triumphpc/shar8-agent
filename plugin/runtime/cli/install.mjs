// CLI `install` (M1): единственная команда, куда вводится токен. Шаги 1..9 из design.md:
// TTY -> версии -> плагин в scope user -> вопросы -> стабильные пути -> запись (env-файл, загрузчик, shim) -> расписание (только по --schedule) -> проба -> итог.
// Токен и ключ API: скрытый ввод, пишутся ТОЛЬКО в env-файл (0600 / ACL); ни в argv дочерних процессов, ни в вывод, ни в settings.json / ~/.claude.json.
// Все внешние действия идут через deps (exec, prompt, lock, sleep, now, perm, fs, adapter): тесты подменяют их подделками и пишут в mkdtemp.

import { existsSync } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS, EXIT, NAMES } from '../cli-constants.mjs';
import { writeEnvFile } from '../env-file.mjs';
import { PROBE, RUN_BUDGET_MS } from '../limits.mjs';
import { createLock } from '../lock.mjs';
import { MIN_CLAUDE_VERSION, MIN_NODE_MAJOR, defaultExec as procExec, parseVersion, versionAtLeast } from '../env-check.mjs';
import { buildChildEnv } from '../platform/env-allow.mjs';
import { createPerm } from '../platform/perm.mjs';
import { awaitProbeResult, describeProbe, newNonce, readProbeResult, writeProbeRequest } from '../probe.mjs';
import { SHIM_VERSION, TEMPLATE_VERSION, adapterKindFor, buildPathEnv, createAdapter, defaultExec as schedExec, execTimeLimitIso, pathsFor, renderLoaderConf, resolveStablePath, writeFileAtomic } from '../shim.mjs';
import { shimState } from '../state.mjs';
import { isAllowedMcpUrl } from '../taskflow-client.mjs';
import { createPrompter, PromptAborted } from './prompt.mjs';

export const DEFAULT_URL = 'https://shar8.app/mcp';
/** Формат токена для умолчательного URL (FR-D16); для чужого URL проверяется только длина. */
export const DEFAULT_TOKEN_RE = /^shar8_[A-Za-z0-9_-]{16,}$/;
export const CUSTOM_TOKEN_MIN = 16;
export const MAX_ATTEMPTS = 3;
const TEMPLATE_FILES = ['com.shar8.agent.plist.tpl', 'shar8-agent.service.tpl', 'shar8-agent.timer.tpl', 'Shar8Agent.xml.tpl'];

class ConfigError extends Error {
  constructor(message, code = EXIT.CONFIG) { super(message); this.name = 'ConfigError'; this.code = code; }
}

const errText = (e) => String(e?.message || e).slice(0, 200);
const platformLabel = { darwin: '', linux: 'Linux: не live (проверено файлами, подделками и CI)', win32: 'Windows: beta (реализовано, вживую не проверено)' };

/**
 * @param {{schedule?:boolean, linger?:boolean, url?:string, mode?:'subscription'|'key'}} opts
 * @param {{io:{stdin:any,stdout:any,stderr:any,isTTY:boolean}, env?:object, platform?:string, deps?:object}} ctx
 * @returns {Promise<number>} 0 | 78 | 1
 */
export async function install(opts = {}, ctx) {
  const { io } = ctx;
  const env = ctx.env ?? process.env;
  const platform = ctx.platform ?? process.platform;
  const deps = ctx.deps ?? {};
  const out = (t) => io.stdout.write(t);
  const secrets = [];
  const scrub = (t) => secrets.reduce((acc, s) => (s ? acc.split(s).join('***') : acc), String(t));
  const say = (t) => out(`${scrub(t)}\n`);
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const nowMs = deps.now ?? Date.now;
  const fs = deps.fs ?? nodeFs;
  let prompter = null;
  try {
    // 1. TTY обязателен: без него ничего не записывается (AC-D02).
    if (!io.isTTY) {
      io.stderr.write('install вводит токен и работает только в терминале (нужен TTY); ничего не записано\n');
      return EXIT.CONFIG;
    }
    const home = deps.home ?? env.HOME ?? env.USERPROFILE ?? homedir();
    const paths = pathsFor({ platform, home, env });
    const perm = deps.perm ?? createPerm({ platform, env });
    const pluginRoot = deps.pluginRoot ?? fileURLToPath(new URL('../../', import.meta.url));
    const tryExec = (fn) => async (file, args, o) => { try { return await fn(file, args, o); } catch (e) { return { code: null, stdout: '', stderr: errText(e) }; } };
    const exec = deps.exec ?? tryExec(procExec);
    const schedulerExec = deps.exec ?? schedExec;

    // 2. Версии: Node >= 20, claude >= 2.1.308. Ниже — отказ без юнитов (AC-D14).
    const nodeVersion = deps.nodeVersion ?? process.versions.node;
    if (!(Number(String(nodeVersion).split('.')[0]) >= MIN_NODE_MAJOR)) throw new ConfigError(`Node ${nodeVersion} слишком старый: нужен Node ${MIN_NODE_MAJOR} или новее. Расписание не установлено`);
    const nodeRes = resolveStablePath('node', { env, platform, home, current: deps.nodePath ?? process.execPath });
    const claudeRes = deps.claudePath ? { path: deps.claudePath, versioned: false, warning: null } : resolveStablePath('claude', { env, platform, home });
    if (!claudeRes.path) throw new ConfigError('claude не найден в PATH: установите Claude Code и повторите install');
    const nodePath = nodeRes.path ?? deps.nodePath ?? process.execPath;
    const claudePath = claudeRes.path;
    const childEnv = (mode) => buildChildEnv({ platform, env, mode });
    const claudeCall = (args, mode = 'subscription') => exec(claudePath, args, { env: childEnv(mode), timeoutMs: 20_000 });
    const ver = await claudeCall(['--version']);
    const claudeVersion = ver?.code === 0 ? (parseVersion(ver.stdout)?.join('.') ?? null) : null;
    if (!claudeVersion) throw new ConfigError('не удалось определить версию claude (`claude --version`); проверьте, что он запускается');
    if (!versionAtLeast(claudeVersion, MIN_CLAUDE_VERSION)) throw new ConfigError(`claude ${claudeVersion} слишком старый: нужен ${MIN_CLAUDE_VERSION} или новее. Расписание не установлено`);

    // 3. Плагин в scope user и включён.
    const list = await claudeCall(['plugin', 'list', '--json']);
    let entries = null;
    try { const doc = JSON.parse(String(list?.stdout)); entries = Array.isArray(doc) ? doc : (Array.isArray(doc?.plugins) ? doc.plugins : null); } catch { /* ниже */ }
    const mine = (entries ?? []).filter((e) => e && (e.id === NAMES.pluginKey || (e.name === NAMES.plugin && e.marketplace === NAMES.marketplace)));
    const userEntry = mine.find((e) => e.scope === 'user' && e.enabled !== false);
    if (!userEntry) {
      throw new ConfigError(`плагин ${NAMES.pluginKey} должен быть установлен в scope user и включён. Выполните: ${COMMANDS.pluginInstallUser}`);
    }

    const kind = adapterKindFor(platform);
    const adapter = deps.adapter ?? (kind ? createAdapter(kind, { paths, exec: schedulerExec, fs: deps.schedFs, uid: deps.uid, sleep, env, existsSync: deps.existsSync }) : null);
    const prevState = await shimState.read(paths.stateDir);
    // Явное --schedule: доступность планировщика проверяется ДО вопросов (иначе пользователь введёт токен зря).
    const checkAvailable = async () => {
      if (!adapter) throw new ConfigError(`расписание на платформе ${platform} не поддерживается; используйте run`);
      const a = await adapter.isAvailable();
      if (!a.ok) throw new ConfigError(`расписание недоступно: ${a.reason ?? 'планировщик не отвечает'}. Запускайте вручную: ${COMMANDS.run(platform === 'win32' ? 'win32' : 'posix')}`);
    };
    if (opts.schedule) await checkAvailable();

    // 4. Вопросы. Токен и ключ — скрытым вводом; тариф не запрашивается нигде.
    prompter = deps.prompt ?? createPrompter(io);
    const url = await askUrl(opts, prompter, say);
    const token = await askToken(prompter, url, say);
    secrets.push(token);
    const mode = await askMode(opts, prompter, say);
    let apiKey = '';
    if (mode === 'key') {
      for (let i = 0; i < MAX_ATTEMPTS && !apiKey; i++) {
        const v = (await prompter.askSecret('Ключ API (ANTHROPIC_API_KEY, ввод скрыт): ')).trim();
        if (v && !/[\r\n\0]/.test(v)) apiKey = v; else say('ключ не может быть пустым');
      }
      if (!apiKey) throw new ConfigError('ключ API не введён');
      secrets.push(apiKey);
    }
    let schedule = Boolean(opts.schedule);
    if (!schedule) {
      // Default is "yes": the schedule is available to everyone; only an explicit "no" skips the timer.
      const answer = (await prompter.ask('Запускать агента по расписанию, раз в минуту? [Y/n] ')).trim().toLowerCase();
      schedule = !(answer === 'n' || answer === 'no' || answer === 'н' || answer === 'нет');
      if (schedule) await checkAvailable();
    }
    if (opts.linger && !(schedule && platform === 'linux')) say('--linger действует только с расписанием на Linux: игнорируется');

    // 5. Стабильные пути; версионный путь без стабильной ссылки — предупреждение.
    for (const r of [nodeRes, claudeRes]) if (r.warning) say(`ВНИМАНИЕ: ${r.warning}`);
    if (mode === 'subscription' && schedule && platform === 'darwin') {
      say('ВНИМАНИЕ: подписка из планировщика launchd на Mac не проверена (спайк S-LAUNCHD не дошёл до входа claude.ai). Если проба не пройдёт, выберите режим «ключ» (2) и повторите install.');
    }

    // 6. Запись. Атомарно; env-файл 0600 / ACL по SID.
    await perm.ensurePrivateDir(paths.configDir);
    await perm.ensurePrivateDir(paths.stateDir);
    if (paths.logDir) await perm.ensurePrivateDir(paths.logDir);
    const packagedShim = join(pluginRoot, 'runtime', 'shim.mjs');
    const selftest = await exec(nodePath, [packagedShim, 'selftest'], { timeoutMs: 20_000 });
    let selfDoc = null;
    try { selfDoc = JSON.parse(String(selftest?.stdout).trim().split('\n').pop()); } catch { /* не JSON */ }
    if (selftest?.code !== 0 || !selfDoc?.ok) throw new ConfigError('упакованный shim не прошёл selftest: установка прервана, ничего не заменено', EXIT.FAILURE);

    await writeEnvFile(paths.envFile, {
      TASKFLOW_MCP_URL: url, TASKFLOW_MCP_TOKEN: token, SHAR8_MODEL_MODE: mode, ...(mode === 'key' ? { ANTHROPIC_API_KEY: apiKey } : {}),
    }, { perm });
    const chk = await perm.checkSecretFile(paths.envFile, { requireOwner: true });
    if (!chk.ok) {
      await fs.rm(paths.envFile, { force: true });
      throw new ConfigError(`права env-файла не подтверждены (${chk.reason}): файл удалён, установка прервана`);
    }
    if (platform === 'win32') {
      await writeFileAtomic(paths.loader, await fs.readFile(join(pluginRoot, 'runtime', 'loader', 'launch.js')), { mode: 0o644, fs });
    } else {
      await writeFileAtomic(paths.loader, await fs.readFile(join(pluginRoot, 'runtime', 'loader', 'tick.sh')), { mode: 0o755, fs });
      await perm.writeSecretFile(paths.loaderConf, renderLoaderConf({ nodePath, stateDir: paths.stateDir }));
    }
    const nextShim = await fs.readFile(packagedShim);
    let prevShim = null;
    try { prevShim = await fs.readFile(paths.shim); } catch { /* первый install */ }
    if (prevShim && !prevShim.equals(nextShim)) await writeFileAtomic(paths.shimPrev, prevShim, { mode: 0o644, fs });
    await writeFileAtomic(paths.shim, nextShim, { mode: 0o644, fs });
    const claudeConfigDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
    const prevInstall = prevState.install ?? {};
    await shimState.writeInstall(paths.stateDir, {
      installedAt: new Date(nowMs()).toISOString(), platform, nodePath, claudePath, configDir: claudeConfigDir,
      ...(env.CLAUDE_CODE_PLUGIN_CACHE_DIR ? { pluginCacheDir: env.CLAUDE_CODE_PLUGIN_CACHE_DIR } : {}),
      pluginKey: NAMES.pluginKey, templateVersion: TEMPLATE_VERSION, schedule: schedule || prevInstall.schedule === true,
      linger: Boolean(opts.linger && schedule && platform === 'linux'),
    }, { perm });
    await shimState.update(paths.stateDir, {
      shimVersion: SHIM_VERSION, liveness: { absentTicks: 0, unreadableSince: null, missingConfigSince: null, lastCliCheckAt: null, lastCliVerdict: null },
    }, { perm });

    // 7. Старый демон снимается всегда; расписание — только при --schedule / ответе «y».
    const lock = deps.lock ?? createLock(paths.stateDir, { platform });
    const waitLock = async () => {
      const start = nowMs();
      let told = false;
      while (!lock.acquire()) {
        if (!told) { say('жду завершения идущей задачи...'); told = true; }
        if (nowMs() - start >= (deps.lockWaitMs ?? PROBE.INSTALL_LOCK_WAIT_MS)) throw new ConfigError('идущая задача не завершилась за 20 минут: повторите install позже');
        await sleep(1000);
      }
    };
    const scheduleWarnings = [];
    const nonce = newNonce();
    const via = schedule ? 'scheduler' : 'terminal';
    let kickFailed = null;
    if (schedule) {
      const templates = {};
      for (const f of TEMPLATE_FILES) templates[f] = await fs.readFile(join(pluginRoot, 'templates', f), 'utf8');
      const userSid = platform === 'win32' ? await perm.currentSid() : undefined;
      if (platform === 'win32' && !userSid) throw new ConfigError('не удалось определить SID пользователя: расписание не установлено');
      const params = {
        paths, nodePath, claudeDir: dirOf(claudePath, platform), loaderPath: paths.loader, launchJsPath: paths.loader, shimPath: paths.shim, stateDir: paths.stateDir,
        logDir: paths.logDir, pathEnv: buildPathEnv({ nodePath, claudePath, platform }), userSid, linger: Boolean(opts.linger), templateVersion: TEMPLATE_VERSION,
        execTimeLimit: execTimeLimitIso(RUN_BUDGET_MS),
      };
      await waitLock();
      try {
        await writeProbeRequest(paths, { nonce, via, now: nowMs() }, { perm });          // до включения таймера
        await adapter.register(params, templates);
        scheduleWarnings.push(...(adapter.takeWarnings?.() ?? []));
      } finally { lock.release(); }
      try { await adapter.kickstart(); } catch (e) { kickFailed = errText(e); }
    } else {
      if (adapter) { try { await adapter.removeLegacy(); } catch (e) { say(`старый демон снять не удалось: ${errText(e)}`); } }
      await waitLock();
      lock.release();                                                                  // проба берёт замок сама
      await writeProbeRequest(paths, { nonce, via, now: nowMs() }, { perm });
    }

    // 8. Проба: настоящий claude -p «ответь ok» без queue и claim.
    say(schedule ? 'проверяю окружение планировщика: жду пробу до 90 секунд...' : 'проверяю окружение из терминала (не из планировщика)...');
    let result;
    if (schedule) {
      result = await awaitProbeResult(paths, nonce, { timeoutMs: PROBE.WAIT_MS, sleep, now: nowMs });
      if (result?.class === 'lock_busy') {                                              // первый тик столкнулся с замком install: повторить пробу
        await writeProbeRequest(paths, { nonce, via, now: nowMs() }, { perm });
        try { await adapter.kickstart(); } catch (e) { kickFailed = errText(e); }
        result = await awaitProbeResult(paths, nonce, { timeoutMs: PROBE.WAIT_MS, sleep, now: nowMs });
      }
    } else {
      await (deps.runProbe ?? defaultRunProbe)({ nonce, env: { ...env, HOME: home }, platform, deps });
      result = await readProbeResult(paths, nonce);
    }
    const described = describeProbe(result, { via });

    // 9. Итог.
    const sh = platform === 'win32' ? 'win32' : 'posix';
    say('');
    say(`env-файл: ${paths.envFile} (права только для вас); токен нигде больше не хранится`);
    say(`режим модели: ${mode === 'key' ? 'ключ API' : 'подписка Claude'}; сервер: ${url}`);
    say(schedule ? `расписание: установлено, раз в минуту (${kind})` : `расписание: не установлено; запускайте вручную: ${COMMANDS.run(sh)}`);
    for (const w of scheduleWarnings) say(w === 'linger_failed' ? 'ВНИМАНИЕ: loginctl enable-linger не выполнен: таймер работает только пока вы вошли в систему' : `ВНИМАНИЕ: ${w}`);
    if (kickFailed) say(`ВНИМАНИЕ: пробный запуск через планировщик не удался (${kickFailed}); первый тик придёт по расписанию`);
    if (!schedule && prevInstall.schedule === true) say('ВНИМАНИЕ: расписание уже было установлено; чтобы обновить его юнит под новые пути, запустите install --schedule');
    for (const line of described.lines) say(line);
    say('');
    say(`состояние:    ${COMMANDS.status(sh)}`);
    say(`один проход:  ${COMMANDS.run(sh)}`);
    say(`снять:        ${COMMANDS.uninstall(sh)}`);
    say(`обновить:     ${COMMANDS.marketplaceUpdate} && ${COMMANDS.pluginUpdate}`);
    if (platformLabel[platform]) say(platformLabel[platform]);
    const legacyEnv = join(home, '.config', 'taskflow-agent', 'env');
    if (existsSync(legacyEnv)) say(`Найден старый файл ${legacyEnv}: он не читается и не переносится; адрес и токен введены заново.`);
    return described.ok ? EXIT.OK : EXIT.FAILURE;
  } catch (err) {
    if (err instanceof PromptAborted) { io.stderr.write('установка прервана\n'); return EXIT.FAILURE; }
    if (err instanceof ConfigError) { io.stderr.write(`${scrub(err.message)}\n`); return err.code; }
    io.stderr.write(`install: непредвиденная ошибка: ${scrub(errText(err))}\n`);
    return EXIT.FAILURE;
  } finally {
    if (!deps.prompt) prompter?.close();
  }
}

const dirOf = (p, platform) => (platform === 'win32' ? p.replace(/[\\/][^\\/]*$/, '') : p.replace(/\/[^/]*$/, '') || '/');

async function askUrl(opts, prompter, say) {
  if (opts.url !== undefined) return validateUrl(opts.url);
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const a = (await prompter.ask(`URL MCP-сервера [${DEFAULT_URL}]: `)).trim();
    if (a === '') return DEFAULT_URL;
    try { return validateUrl(a); } catch (e) { say(e.message); }
  }
  throw new ConfigError('адрес сервера не введён');
}

function validateUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new ConfigError('адрес сервера должен быть полным URL (https://...)'); }
  if (!isAllowedMcpUrl(raw)) throw new ConfigError('адрес сервера должен начинаться с https:// (http допустим только для localhost, 127.0.0.1 и [::1])');
  if (/[\r\n\0\s]/.test(String(raw))) throw new ConfigError('адрес сервера не должен содержать пробелов');
  // адрес сайта без пути (https://shar8.app) — частая ошибка ввода: MCP живёт на /mcp, иначе очередь отвечает HTML
  if (u.pathname === '' || u.pathname === '/') return `${u.origin}/mcp${u.search}`;
  return String(raw);
}

async function askToken(prompter, url, say) {
  const isDefault = url === DEFAULT_URL;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const t = (await prompter.askSecret('Личный токен (ввод скрыт): ')).trim();
    if (/[\r\n\0]/.test(t)) { say('токен не должен содержать переводов строки'); continue; }
    if (isDefault ? DEFAULT_TOKEN_RE.test(t) : t.length >= CUSTOM_TOKEN_MIN) return t;
    say(isDefault ? 'токен для shar8.app начинается с shar8_ (его выдаёт кабинет); проверьте, что скопировали его целиком' : `для своего сервера токен должен быть не короче ${CUSTOM_TOKEN_MIN} символов`);
  }
  throw new ConfigError('токен не введён');
}

async function askMode(opts, prompter, say) {
  if (opts.mode === 'subscription' || opts.mode === 'key') return opts.mode;
  if (opts.mode !== undefined) throw new ConfigError('--mode: subscription или key');
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const a = (await prompter.ask('Режим модели: 1 — подписка Claude (вход claude.ai), 2 — ключ API [1/2]: ')).trim();
    if (a === '1') return 'subscription';
    if (a === '2') return 'key';
    say('введите 1 или 2 (Enter режим не выбирает)');
  }
  throw new ConfigError('режим модели не выбран');
}

/** Проба из терминала (DD-11): тот же код раннера в процессе install, без планировщика. */
async function defaultRunProbe({ nonce, env, platform, deps }) {
  const { main } = await import('../tick.mjs');
  await main(['--contract', '1', 'tick', '--probe', nonce], env, { platform, log: () => {}, stderr: () => {}, ...(deps.tickDeps ?? {}) });
}

