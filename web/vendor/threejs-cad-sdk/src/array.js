// Matrices: repetir una parte en línea, en área o alrededor de un eje.
//
// `arrayTransforms(spec)` es una función pura: devuelve las transformaciones (en el mundo)
// que llevan a la parte original a cada lugar, y no sabe de partes ni de documento. Es lo que
// usa `workshop.array(parte, spec)` para crear las instancias, y lo que puede usar una app
// para calcular dónde caería cada copia sin tocar el modelo.
//
// `count` cuenta a la ORIGINAL: con count = 4 hay tres copias nuevas. La transformación 0
// siempre es la identidad (la original donde está).
//
//   - 'linear': en una dirección. `distance` es el largo total, de la primera a la última
//     (fit 'span', por defecto: el paso se reparte), o la separación entre dos consecutivas
//     (fit 'step': el paso manda y sumar copias alarga la fila).
//   - 'area': en dos direcciones, `count × count2`, con sus `distance` y `distance2`.
//   - 'polar': alrededor de un eje que pasa por `center`. `angle` es el barrido total
//     (360 por defecto) o, con fit 'step', cuánto gira cada paso. Un barrido de 360° no
//     repite la primera copia (4 copias = cada 90°, no cada 120°); uno menor incluye las dos
//     puntas. Con `orient: true` (por defecto) cada copia gira con el barrido; con
//     `orient: false` queda paralela a la original y solo cambia de lugar — para eso hace
//     falta `origin`, el punto de la original que da la vuelta.
//
// Puro: no importa three ni DOM.
import { Point3d, Vector3d, Transform } from './geometry.js';

/** @typedef {import('./geometry.js').PointLike} PointLike */
/** @typedef {import('./geometry.js').VectorLike} VectorLike */
/** @typedef {import('./geometry.js').AxisLike} AxisLike */
/** @typedef {'span' | 'step'} Fit */
/** @typedef {{ type: 'linear', count: number, direction: VectorLike, distance: number, fit?: Fit }} LinearArray */
/** @typedef {{ type: 'area', count: number, count2: number, direction: VectorLike, direction2: VectorLike, distance: number, distance2: number, fit?: Fit }} AreaArray */
/** @typedef {{ type: 'polar', count: number, axis?: AxisLike, center?: PointLike, angle?: number, fit?: Fit, orient?: boolean }} PolarArray */
/** @typedef {LinearArray | AreaArray | PolarArray} ArraySpec */

/** @param {unknown} n @param {string} que */
function entero(n, que) {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new TypeError(`${que} inválido: ${String(n)} (va un entero de 1 o más)`);
  return n;
}

/** @param {unknown} n @param {string} que */
function numero(n, que) {
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new TypeError(`${que} inválido: ${String(n)} (va un número)`);
  return n;
}

/** @param {Fit | undefined} fit */
function checkFit(fit = 'span') {
  if (fit !== 'span' && fit !== 'step') throw new TypeError(`fit inválido: ${String(fit)} (va 'span' o 'step')`);
  return fit;
}

/** @param {VectorLike} v @param {string} que */
function direccion(v, que) {
  const w = Vector3d.from(v);
  if (!w.length) throw new Error(`${que} no puede ser nula`);
  return w.unitize();
}

/** Lo que separa a dos copias consecutivas. @param {number} distance @param {number} count @param {Fit} fit */
function paso(distance, count, fit) {
  return fit === 'step' ? distance : count > 1 ? distance / (count - 1) : 0;
}

/**
 * Las transformaciones, en el mundo, de cada elemento de la matriz. La 0 es la identidad.
 * @param {ArraySpec} spec
 * @param {{ origin?: PointLike }} [opts] `origin`: el punto de la original que gira, para una
 *   matriz polar con `orient: false`.
 * @returns {Transform[]}
 */
export function arrayTransforms(spec, { origin } = {}) {
  if (!spec || typeof spec !== 'object') throw new TypeError('la matriz va como { type: \'linear\' | \'area\' | \'polar\', count, … }');
  switch (spec.type) {
    case 'linear': {
      const n = entero(spec.count, 'count');
      const fit = checkFit(spec.fit);
      const d = direccion(spec.direction, 'direction');
      const s = paso(numero(spec.distance, 'distance'), n, fit);
      return Array.from({ length: n }, (_, k) => Transform.translation(d.multiply(k * s)));
    }
    case 'area': {
      const n = entero(spec.count, 'count'), m = entero(spec.count2, 'count2');
      const fit = checkFit(spec.fit);
      const d1 = direccion(spec.direction, 'direction'), d2 = direccion(spec.direction2, 'direction2');
      const s1 = paso(numero(spec.distance, 'distance'), n, fit), s2 = paso(numero(spec.distance2, 'distance2'), m, fit);
      /** @type {Transform[]} */
      const out = [];
      for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) out.push(Transform.translation(d1.multiply(i * s1).add(d2.multiply(j * s2))));
      return out;
    }
    case 'polar': {
      const n = entero(spec.count, 'count');
      const fit = checkFit(spec.fit);
      const { axis = 'z', center = [0, 0, 0], angle = 360, orient = true } = spec;
      numero(angle, 'angle');
      const giro = fit === 'step' ? angle : Math.abs(angle) >= 360 ? angle / n : n > 1 ? angle / (n - 1) : 0;
      if (!orient && origin === undefined) throw new Error('una matriz polar con orient: false necesita origin: el punto de la original que da la vuelta');
      const p0 = orient ? null : Point3d.from(/** @type {PointLike} */ (origin));
      return Array.from({ length: n }, (_, k) => {
        const t = Transform.rotation(k * giro, axis, center);
        return p0 ? Transform.translation(p0, p0.transform(t)) : t;
      });
    }
    default:
      throw new TypeError(`tipo de matriz inválido: ${String(/** @type {{ type?: unknown }} */ (spec).type)} (va 'linear', 'area' o 'polar')`);
  }
}
