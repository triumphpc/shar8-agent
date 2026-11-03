// Числовые константы плагина: единственное место (тест pl-constants / pl-runner-pauses закрепляет значения).
// Здесь нет счётчика исполнений и тарифа (C2). Строки «до 1-го числа» нет.

const MIN = 60_000;

/** Лимиты одного прогона `claude` и тика. */
export const LIMITS_RUN = Object.freeze({
  MAX_TASKS_PER_RUN: 3,
  TASK_TIMEOUT_MS: 15 * MIN,
  POLL_MS: 60_000,
  KILL_GRACE_MS: 10_000,
  MAX_TURNS: 30,
  MAX_BUDGET_USD: '2.00',
  STDOUT_CAP_BYTES: 1_048_576,
});

/** Бюджет тика: MAX_TASKS_PER_RUN × (TASK_TIMEOUT_MS + KILL_GRACE_MS) + запас 10 минут = 55,5 мин; даёт PT1H. */
export const RUN_BUDGET_MS = LIMITS_RUN.MAX_TASKS_PER_RUN * (LIMITS_RUN.TASK_TIMEOUT_MS + LIMITS_RUN.KILL_GRACE_MS) + 10 * MIN;

/** Паузы раннера (таблица «Паузы и коды выхода»). */
export const PAUSE = Object.freeze({
  CLAIM_MS: 3_600_000,
  AUTH_MS: 600_000,
  ENV_LADDER_MS: Object.freeze([5, 10, 20, 40, 60].map((m) => m * MIN)),
});

/** Потолки отправки: файл политики их поднять не может (DD-6). */
export const SEND_LIMITS = Object.freeze({ SLOT_MAX: 20, SEND_TOTAL_MAX: 20 });

/** Проба при установке (раздел «Проба при установке»). */
export const PROBE = Object.freeze({
  WAIT_MS: 90_000,
  TOO_FAST_MS: 2_000,
  INSTALL_LOCK_WAIT_MS: 20 * MIN,
  REQUEST_MAX_MS: 10 * MIN,
});

/** Замок раннера (DD-8). */
export const LOCK = Object.freeze({
  WIN_HEARTBEAT_MS: 30_000,
  WIN_STALE_MS: 5 * MIN,
});

/** Пороги shim (он самодостаточен и не может импортировать этот файл: значения продублированы в shim.mjs, тест pl-shim-selfheal их сверяет). */
export const SHIM = Object.freeze({
  CLI_CHECK_MS: 6 * 60 * MIN,
  MISSING_CEILING_MS: 24 * 60 * MIN,
  UNREADABLE_CEILING_MS: 7 * 24 * 60 * MIN,
  LOG_MAX_BYTES: 1_048_576,
  CLI_TIMEOUT_MS: 15_000,
});

/** Возраст сборки плагина, после которого status предупреждает об обновлении (ADR-021 п. 7). */
export const BUILD = Object.freeze({ STALE_DAYS: 60 });
