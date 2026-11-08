// Preflight режима с отправкой (SEC02): пользовательские настройки Claude Code не должны разрешать
// send-инструменты в обход gate. Под --permission-mode dontAsk правило allow из settings.json открыло бы
// инструмент, а при сбое хука (таймаут, exit 1) вызов ушёл бы без проверки. Поэтому при таком правиле
// демон не стартует (config_error). Файлы только читаются; значения правил наружу не выводятся:
// результат содержит имя файла и фиксированную причину.

import { readFileSync, readdirSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/** Managed-каталоги настроек Claude Code по ОС (ADR-018 п. 9): macOS, Linux, Windows. */
export const MANAGED_DIRS = Object.freeze({
  darwin: '/Library/Application Support/ClaudeCode',
  linux: '/etc/claude-code',
  win32: 'C:\\Program Files\\ClaudeCode',
});
/** Прежнее имя (macOS); оставлено для проверок и документации. */
export const MANAGED_DIR = MANAGED_DIRS.darwin;

/** Managed-каталог ОС; неизвестная платформа читается как Linux. */
export const managedDirFor = (platform = process.platform) => MANAGED_DIRS[platform] ?? MANAGED_DIRS.linux;

const realFs = { readFileSync, readdirSync };

/**
 * Файлы настроек, которые claude подмешивает к --settings: корень настроек (CLAUDE_CONFIG_DIR, если задан в
 * том же env, что получит claude, иначе ~/.claude), проектные (песочница) и managed (SEC12) своей ОС.
 * Каталог managed-settings.d читается по списку *.json; нет каталога: нормально.
 * `platform` и `fs` внедряются (тесты проверяют все три ОС на любой машине).
 */
export const settingsFiles = ({ home, cwd, configDir, platform = process.platform, managedDir = managedDirFor(platform), fs = realFs }) => {
  const join = platform === 'win32' ? win32.join : posix.join;
  const root = typeof configDir === 'string' && configDir !== '' ? configDir : join(home, '.claude');
  const files = [join(root, 'settings.json'), join(root, 'settings.local.json')];
  if (cwd) files.push(join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json'));
  if (managedDir) {
    files.push(join(managedDir, 'managed-settings.json'));
    try {
      for (const name of fs.readdirSync(join(managedDir, 'managed-settings.d')).filter((n) => n.endsWith('.json')).sort()) {
        files.push(join(managedDir, 'managed-settings.d', name));
      }
    } catch { /* нет каталога или он нечитаем: файлов нет */ }
  }
  return files;
};

const PLUGIN_PREFIX = 'mcp__plugin_';
const globToRegExp = (glob) => new RegExp(`^${glob.replace(/\*+/g, '*').split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's');

/** Правило allow покрывает инструмент: точное имя, префикс сервера, glob с «*» в любом месте или «всё». Хвост «(…)» срезается. */
export function ruleCoversTool(rule, tool) {
  if (typeof rule !== 'string') return false;
  let r = rule.trim().replace(/\([^)]*\)$/, '').trim();
  if (r === '') return false;
  if (r === '*' || r === 'mcp__*') return true;
  if (r === tool || tool.startsWith(`${r}__`)) return true;
  return r.includes('*') && globToRegExp(r).test(tool);
}

/** SEC13: allow-правило на плагинные MCP (mcp__plugin_…) отклоняется целиком. */
export const isPluginAllow = (rule) => typeof rule === 'string' && rule.trim().startsWith(PLUGIN_PREFIX);

/**
 * `tools` — полные имена send-инструментов из политики (sendToolNames). Правило allow на плагинный MCP отклоняется и без них.
 * @returns {{ ok: true } | { ok: false, problems: { file: string, reason: 'allow_send_tool'|'allow_plugin_tool'|'unreadable' }[] }}
 * Нет файла: нормально. Нечитаемый или битый файл: отказ (fail-closed), причина без текста ошибки.
 */
export function checkSettingsForSend({ home, cwd, configDir, platform = process.platform, managedDir, fs = realFs, tools = [], files = settingsFiles({ home, cwd, configDir, platform, fs, ...(managedDir !== undefined ? { managedDir } : {}) }) }) {
  const problems = [];
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') continue;
      problems.push({ file, reason: 'unreadable' });
      continue;
    }
    let doc;
    try { doc = JSON.parse(text); } catch { problems.push({ file, reason: 'unreadable' }); continue; }
    const allow = doc?.permissions?.allow;
    if (!Array.isArray(allow)) continue;
    if (allow.some((rule) => tools.some((t) => ruleCoversTool(rule, t)))) problems.push({ file, reason: 'allow_send_tool' });
    else if (allow.some(isPluginAllow)) problems.push({ file, reason: 'allow_plugin_tool' });
  }
  return problems.length ? { ok: false, problems } : { ok: true };
}
