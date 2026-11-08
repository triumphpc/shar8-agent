// Единственный источник текста команд (M11, ADR-021 п. 7): README, commands/*.md, вывод install/status и FAQ лендинга берут строки отсюда.
// Строка `triumph` разрешена только здесь и в plugin/README.md (AC-033); подстановка `${` допустима только здесь и в commands/*.md (C10).
// Слэш-команды ничего не исполняют: они печатают блок из констант, токен через модель не проходит (AC-D02).

export const NAMES = Object.freeze({
  plugin: 'shar8-agent', marketplace: 'shar8', pluginKey: 'shar8-agent@shar8', mirrorRepo: 'triumphpc/shar8-agent', tagPrefix: 'shar8-agent--v',
});

export const COMMANDS = Object.freeze({
  marketplaceAdd: `claude plugin marketplace add ${NAMES.mirrorRepo}`,
  pluginInstall: `claude plugin install ${NAMES.pluginKey}`,
  pluginInstallUser: `claude plugin install ${NAMES.pluginKey} --scope user`,
  marketplaceUpdate: `claude plugin marketplace update ${NAMES.marketplace}`,
  pluginUpdate: `claude plugin update ${NAMES.pluginKey}`,
  slash: Object.freeze({
    install: `/${NAMES.plugin}:install`, status: `/${NAMES.plugin}:status`, run: `/${NAMES.plugin}:run`, uninstall: `/${NAMES.plugin}:uninstall`,
  }),
  // Тело слэш-команды (подстановку ${CLAUDE_PLUGIN_ROOT} делает Claude Code); в FAQ и README этих строк нет.
  installTemplate: 'node "${CLAUDE_PLUGIN_ROOT}/bin/shar8-agent.mjs" install --schedule',
  installTemplateManual: 'node "${CLAUDE_PLUGIN_ROOT}/bin/shar8-agent.mjs" install',
  // Стабильный путь шима после установки; Windows (beta).
  shim: Object.freeze({ posix: `node ~/.config/${NAMES.plugin}/shim.mjs`, win32: `node "%LOCALAPPDATA%\\${NAMES.plugin}\\shim.mjs"` }),
  status: (p) => `${COMMANDS.shim[p]} status`,
  run: (p) => `${COMMANDS.shim[p]} run`,
  uninstall: (p) => `${COMMANDS.shim[p]} uninstall`,
});

export const EXIT = Object.freeze({ OK: 0, FAILURE: 1, AUTH: 77, CONFIG: 78 });

/** Имена файлов plugin/commands/<имя>.md. */
export const COMMAND_FILES = Object.freeze(['install', 'status', 'run', 'uninstall']);

const DESCRIPTIONS = Object.freeze({
  install: 'Установка агента делегирования: печатает команду для терминала (токен вводится только там)',
  status: 'Состояние агента делегирования: печатает команду status',
  run: 'Один ручной проход агента делегирования: печатает команду run',
  uninstall: 'Снять расписание агента делегирования: печатает команду uninstall',
});

const PREAMBLE = 'Ответь ровно этим блоком и больше ничего. Ничего не запускай, не вызывай инструменты.';

const block = (lines) => ['```', ...lines, '```'].join('\n');

function bodyOf(name) {
  if (name === 'install') {
    return [
      PREAMBLE, '',
      'Скопируйте нужную строку в терминал. Токен вводится там скрытым вводом и в этот чат не попадает.', '',
      'С расписанием (раз в минуту):', block([COMMANDS.installTemplate]), '',
      'Без расписания (запуск вручную командой run):', block([COMMANDS.installTemplateManual]),
    ].join('\n');
  }
  if (!COMMAND_FILES.includes(name)) throw new TypeError(`renderCommandFile: unknown command ${String(name)}`);
  return [
    PREAMBLE, '',
    'Mac и Linux:', block([COMMANDS[name]('posix')]), '',
    'Windows (beta):', block([COMMANDS[name]('win32')]),
  ].join('\n');
}

/** Текст plugin/commands/<name>.md; страж-тест сверяет файл с этим результатом. */
export function renderCommandFile(name) {
  if (!COMMAND_FILES.includes(name)) throw new TypeError(`renderCommandFile: unknown command ${String(name)}`);
  return `---\ndescription: ${DESCRIPTIONS[name]}\n---\n${bodyOf(name)}\n`;
}
