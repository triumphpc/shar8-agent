// `status` — самодостаточная реализация живёт в shim.mjs (работает и без кэша плагина); здесь только точка входа для bin (M1).
export { status, collectStatus, formatStatus } from '../shim.mjs';
