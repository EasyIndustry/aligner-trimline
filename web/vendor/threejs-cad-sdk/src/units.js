// Unidades de longitud: cuáles hay, a qué sistema pertenece cada una y cómo se convierten.
//
// El SDK trabaja en la unidad del documento (`taller.units`) y no sabe de ninguna otra: una
// medida es un número en esa unidad. Acá solo está lo necesario para decir cuál es, y para
// llevar a ella un valor que viene escrito en otra (los parámetros sugeridos de config.js).
//
// Puro: no importa three ni DOM.

/**
 * Cada unidad dice a qué sistema pertenece y cuántos milímetros mide.
 * @typedef {'mm' | 'cm' | 'm' | 'in' | 'ft'} Unit
 * @typedef {'metric' | 'imperial'} System
 */

/** @type {Readonly<Record<Unit, Readonly<{ system: System, mm: number }>>>} */
export const UNITS = Object.freeze({
  mm: Object.freeze({ system: 'metric', mm: 1 }),
  cm: Object.freeze({ system: 'metric', mm: 10 }),
  m: Object.freeze({ system: 'metric', mm: 1000 }),
  in: Object.freeze({ system: 'imperial', mm: 25.4 }),
  ft: Object.freeze({ system: 'imperial', mm: 304.8 }),
});

/** La unidad de un documento al que no se le dijo otra. */
export const DEFAULT_UNIT = /** @type {Unit} */ ('cm');

/** @param {unknown} unit @returns {Unit} */
export function checkUnit(unit) {
  if (typeof unit !== 'string' || !Object.hasOwn(UNITS, unit)) {
    throw new TypeError(`unidad inválida: ${String(unit)} (va ${Object.keys(UNITS).join(', ')})`);
  }
  return /** @type {Unit} */ (unit);
}

/** @param {Unit} unit @returns {System} */
export const systemOf = (unit) => UNITS[checkUnit(unit)].system;

/**
 * Lleva una longitud de una unidad a otra.
 * @param {number} value @param {Unit} from @param {Unit} to
 */
export function convertLength(value, from, to) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`longitud inválida: ${String(value)} (va un número)`);
  return (value * UNITS[checkUnit(from)].mm) / UNITS[checkUnit(to)].mm;
}
