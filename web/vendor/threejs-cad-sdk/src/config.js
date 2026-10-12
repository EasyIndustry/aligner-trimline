// Los parámetros que dependen de en qué sistema y a qué escala se trabaja.
//
// Es el único lugar del SDK donde viven esos números: nada de `src/` los escribe a mano. Cada
// sistema (métrico, imperial) los trae en SU unidad natural, como los diría alguien que trabaja
// en él, y `tolerancesFor` los lleva a la unidad del documento. Así los mismos valores sirven
// si el documento está en mm, en cm o en m, y si alguien trabaja en pulgadas no recibe un
// "0,0787" que no significa nada para él.
//
// Son SUGERENCIAS. Un taller puede pisarlos al crearse (`createWorkshop({ tolerances })`) o
// pasar una tolerancia puntual a cada pregunta (`a.touches(b, { tolerance })`). Para otro
// criterio —otro oficio, otra máquina— se cambian acá o se pisan desde afuera, sin tocar el
// resto del SDK.
//
// Puro: no importa three ni DOM.
import { convertLength, systemOf, checkUnit } from './units.js';

/** @typedef {import('./units.js').Unit} Unit */
/** @typedef {import('./units.js').System} System */

/**
 * Tolerancias sugeridas.
 *   touch:       dos partes se tocan si están a esta distancia o menos.
 *   penetration: se meten una en otra si la penetración pasa de esto.
 *   grab:        el agarre (closest) engancha un vértice, una arista o una cara a esta distancia
 *                o menos (con tope por eje: ver GRAB_RATIO).
 *   snap:        el imán (snap) pega un borde a otro a esta distancia o menos.
 *   minLength:   al estirar un conjunto, ninguna pieza estirada queda más corta que esto.
 * Métrico: 2 mm, 1,5 mm, 10 mm, 25 mm y 10 mm. Imperial: 1/16 in, 3/64 in, 3/8 in, 1 in y 3/8 in.
 * @type {Readonly<Record<System, Readonly<{ unit: Unit, touch: number, penetration: number, grab: number, snap: number, minLength: number }>>>}
 */
export const TOLERANCE_PRESETS = Object.freeze({
  metric: Object.freeze({ unit: 'mm', touch: 2, penetration: 1.5, grab: 10, snap: 25, minLength: 10 }),
  imperial: Object.freeze({ unit: 'in', touch: 1 / 16, penetration: 3 / 64, grab: 3 / 8, snap: 1, minLength: 3 / 8 }),
});

/**
 * La franja del agarre en cada eje de una pieza es `grab`, pero nunca más que esta proporción
 * del largo de ese eje: en una tabla fina, la franja del canto no se come todo el espesor.
 */
export const GRAB_RATIO = 0.3;

/**
 * @typedef {Object} Tolerances
 * @property {number} touch         distancia máxima para que dos partes se toquen, en la unidad del documento
 * @property {number} penetration   cuánto se pueden meter una en otra antes de chocar, en la unidad del documento
 * @property {number} grab          distancia del agarre (closest), en la unidad del documento
 * @property {number} snap          distancia del imán (snap), en la unidad del documento
 * @property {number} minLength     el largo mínimo de una pieza al estirar, en la unidad del documento
 */

/**
 * Las tolerancias para un documento en `unit`: las sugeridas de su sistema, llevadas a su
 * unidad, y encima lo que se pida. `overrides` va en la unidad del documento.
 * @param {Unit} unit @param {Partial<Tolerances>} [overrides]
 * @returns {Readonly<Tolerances>}
 */
export function tolerancesFor(unit, overrides = {}) {
  const preset = TOLERANCE_PRESETS[systemOf(checkUnit(unit))];
  /** @type {Tolerances} */
  const out = {
    touch: convertLength(preset.touch, preset.unit, unit),
    penetration: convertLength(preset.penetration, preset.unit, unit),
    grab: convertLength(preset.grab, preset.unit, unit),
    snap: convertLength(preset.snap, preset.unit, unit),
    minLength: convertLength(preset.minLength, preset.unit, unit),
  };
  for (const k of /** @type {const} */ (['touch', 'penetration', 'grab', 'snap', 'minLength'])) {
    const v = overrides[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new TypeError(`tolerancia ${k} inválida: ${String(v)} (va un número de 0 o más, en la unidad del documento)`);
    out[k] = v;
  }
  return Object.freeze(out);
}
