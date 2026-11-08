// Адаптер Task Scheduler (Windows, beta): реэкспорт из shim.mjs (DD-1). Использование: createAdapter('schtasks', { paths, exec }).
export { createAdapter, renderUnits, execTimeLimitIso } from '../shim.mjs';
