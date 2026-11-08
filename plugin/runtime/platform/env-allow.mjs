// Окружение процесса `claude` (ADR-020 п. 3, ADR-017 п. 8): белый список, платформенный.
// win32: имена сравниваются по toUpperCase() с сохранением исходного написания (`Path`, `ComSpec`, `windir`).
// Не проходят никогда: TASKFLOW_*, служебные переменные лаунчера (префикс собирается ниже, AC-033), CLAUDE_CODE_OAUTH_TOKEN. ANTHROPIC_API_KEY — только в режиме `key`.

const COMMON = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'TERM', 'SHELL',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'CLAUDE_CONFIG_DIR',
]);
const COMMON_PREFIX = ['LC_', 'CLAUDE_CODE_'];
const WIN32_ONLY = new Set([
  'SYSTEMROOT', 'SYSTEMDRIVE', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'WINDIR',
]);
// Пользователь задаёт их у себя сам; раннер их не требует и не пишет (design, M5).
const USER_OWN = new Set(['ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS']);
// Префикс лаунчера собран из частей: литерал запрещён списком AC-033 (scripts/lib/forbidden-substrings.mjs), правило при этом прежнее.
const NEVER_PREFIX = ['TASKFLOW_', ['AI', 'LAUNCHER', ''].join('_')];
const NEVER_EXACT = new Set(['CLAUDE_CODE_OAUTH_TOKEN']);

/** Разрешено ли имя `name` на платформе `platform` в режиме `mode` ('subscription' | 'key'). */
export function isAllowedName(name, { platform = process.platform, mode } = {}) {
  const win = platform === 'win32';
  const upper = name.toUpperCase();
  if (NEVER_EXACT.has(upper) || NEVER_PREFIX.some((p) => upper.startsWith(p))) return false;
  if (upper === 'ANTHROPIC_API_KEY') return mode === 'key' && (win || name === upper);
  const key = win ? upper : name;
  if (USER_OWN.has(key) || COMMON_PREFIX.some((p) => key.startsWith(p))) return true;
  if (win) return COMMON.has(key) || WIN32_ONLY.has(key);
  return COMMON.has(name) || /^(http_proxy|https_proxy|no_proxy)$/.test(name);
}

/**
 * Окружение ребёнка. `extra` — дополнительные шаблоны (RegExp) для тестов; они не обходят запреты.
 * @returns {Record<string,string>}
 */
export function buildChildEnv({ platform = process.platform, env = process.env, mode = 'subscription', extra = [] } = {}) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    const upper = name.toUpperCase();
    if (NEVER_EXACT.has(upper) || NEVER_PREFIX.some((p) => upper.startsWith(p))) continue;
    if (isAllowedName(name, { platform, mode }) || (extra.some((re) => re.test(name)) && upper !== 'ANTHROPIC_API_KEY')) out[name] = value;
  }
  return out;
}
