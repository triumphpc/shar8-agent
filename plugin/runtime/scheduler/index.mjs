// Выбор адаптера планировщика по платформе (M6). Реализация живёт в shim.mjs (DD-1): `uninstall` и самоснятие обязаны работать без кэша плагина.
export { adapterKindFor, createAdapter, renderUnits, TEMPLATE_VERSION, NAMES } from '../shim.mjs';
