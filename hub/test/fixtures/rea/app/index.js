import { ironRate } from './rates.js';
export function productionSummary(machines) {
  return { item: 'Iron Ingot', perMinute: machines * ironRate };
}
