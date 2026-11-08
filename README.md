# shar8-agent

A Claude Code plugin that lets an agent work through your task list on a schedule.

You mark a task "Агенту" (For the agent) in [shar8.app](https://shar8.app/for-agents/?utm_source=github&utm_medium=readme&utm_campaign=plugin), a personal task manager with an MCP server. The plugin picks the task up over MCP, runs Claude Code locally on your machine, and writes the result back into the task notes. The task status becomes "На проверке" (needs review) or "Нужно уточнение" (needs your answer). Only you close the task. If no task is delegated, the model is not called at all.

- Runs on your own Claude Code subscription or on your own `ANTHROPIC_API_KEY`. You choose the mode during install; there is no default.
- The only channel to shar8 is MCP over HTTPS with your personal token. The plugin has no other network addresses.
- By default the agent has no tools: it sees the task text and answers with text. Web search or other MCP servers are opt-in through `~/.config/shar8-agent/agent.json`.
- Sending anything outward (chat messages, mail) is off unless you describe an allow-list in `send-policy.json`.

Full documentation (Russian): [plugin/README.md](plugin/README.md). Landing page: [shar8.app/for-agents](https://shar8.app/for-agents/?utm_source=github&utm_medium=readme&utm_campaign=plugin).

## Install (Claude Code)

Requirements: Claude Code 2.1.308 or newer, Node.js 20 or newer, a personal shar8 token (cabinet, "Выдать токен"; shown once).

```sh
claude plugin marketplace add triumphpc/shar8-agent
claude plugin install shar8-agent@shar8
```

Then, in a Claude Code session, run `/shar8-agent:install` and paste the printed line into a terminal. The slash command only prints the line, so the token never passes through the model. If the slash command is unavailable, run `node "<installPath>/bin/shar8-agent.mjs" install`, where `<installPath>` is the plugin path from `claude plugin list --json`.

The installer asks for the server address (Enter keeps the default `https://shar8.app/mcp`), the token (hidden input), the model mode and whether to set up a schedule (default: once a minute). At the end it makes a probe run of `claude` and says plainly if the probe failed.

Manage and update:

```sh
node ~/.config/shar8-agent/shim.mjs status
node ~/.config/shar8-agent/shim.mjs run
node ~/.config/shar8-agent/shim.mjs uninstall

claude plugin marketplace update shar8
claude plugin update shar8-agent@shar8
```

## Supported systems (honest status)

| System | Status |
|---|---|
| macOS | Verified live on 2026-11-02: real shar8.app, real Claude Code, scheduled by launchd on a subscription; a delegated task was picked up within a minute and returned a report. |
| Linux | Implemented (systemd user timer), checked with files and fakes. **Not run live yet.** |
| Windows | **Beta.** Implemented (Task Scheduler), not verified live. |

Other MCP clients (OpenCode, Codex CLI) can connect to shar8 by token without this plugin; see the landing page above. This plugin itself targets Claude Code only.

## Security notes

- The agent sees all tasks you delegated to it, in full: title, notes, subtasks. Delegate only what you are fine sending to the model you chose.
- The token is typed with hidden input and stored only in `~/.config/shar8-agent/env` (mode 0600). It is not passed through command-line arguments, `settings.json` or `~/.claude.json`, and not written to logs.
- `claude` runs isolated: an empty tool list by default, `--permission-mode dontAsk`, MCP servers only from your `agent.json`, an allow-listed environment. Built-in tools in `agent.json` are limited to `Read`, `Glob`, `Grep`; `Bash`, `Write`, `Edit` and `WebFetch` are closed so the agent cannot read the token file.
- Limits per run: up to 3 tasks per pass, 15 minutes and a 2.00 USD budget per task.
- `uninstall` removes the schedule and keeps the token; `uninstall --purge` also removes the env file.

## License

MIT, see [LICENSE](LICENSE).

---

# shar8-agent (по-русски)

Плагин Claude Code, который по расписанию разбирает ваши задачи в [shar8.app](https://shar8.app/for-agents/?utm_source=github&utm_medium=readme&utm_campaign=plugin).

Вы ставите в задаче пометку «Агенту». Плагин забирает её по MCP, запускает Claude Code локально на вашем компьютере и кладёт результат в заметки задачи. Статус станет «На проверке» или «Нужно уточнение», закрываете задачу только вы. Если делегированных задач нет, модель не вызывается.

Установка:

```sh
claude plugin marketplace add triumphpc/shar8-agent
claude plugin install shar8-agent@shar8
```

Дальше в сессии Claude Code выполните `/shar8-agent:install` и вставьте напечатанную строку в терминал. Модель работает на вашей подписке Claude Code или на вашем ключе `ANTHROPIC_API_KEY`.

Статус систем: Mac проверен вживую 2 ноября 2026; Linux реализован, вживую не проверен; Windows в beta.

Безопасность: агент видит все делегированные ему задачи целиком. Токен хранится только в файле с правами 0600 и не попадает в аргументы команд и логи. По умолчанию у агента нет инструментов и он ничего не отправляет наружу. Подробности и полная документация: [plugin/README.md](plugin/README.md).

Лицензия: MIT.
