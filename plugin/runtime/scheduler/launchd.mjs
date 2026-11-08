// Адаптер launchd (macOS): реэкспорт из shim.mjs (DD-1). Использование: createAdapter('launchd', { paths, exec, uid }).
export { createAdapter, renderUnits } from '../shim.mjs';
