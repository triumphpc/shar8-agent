// Адаптер systemd --user (Linux, «не live»): реэкспорт из shim.mjs (DD-1). Использование: createAdapter('systemd', { paths, exec }).
export { createAdapter, renderUnits } from '../shim.mjs';
