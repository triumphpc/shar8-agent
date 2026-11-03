// Версия плагина. Меняется вместе с plugin/.claude-plugin/plugin.json.version (C8, тест pl-manifest).
export const PLUGIN_VERSION = '1.0.2';
// Дата сборки (UTC, YYYY-MM-DD): источник для предупреждения status «сборка старше 60 дней». Обновляется вместе с PLUGIN_VERSION
// при каждом релизе (ADR-021 п. 4); shim читает её как текст, поэтому формат строки менять нельзя.
export const PLUGIN_BUILT_AT = '2026-11-02';
