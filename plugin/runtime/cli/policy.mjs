// `policy` (DD-15): состояние send-policy.json без значений. Shim пересылает команду раннеру из installPath (`policy-check`).
export { policy } from '../shim.mjs';
export { policyCheck } from '../tick.mjs';
