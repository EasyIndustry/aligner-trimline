// Marcos: dónde está una parte y cómo está girada, separado de lo que la parte ES.
//
// Una pieza se define en su propio marco LOCAL (sus medidas, su forma, cuál eje es el
// largo) y esa definición no cambia nunca al moverla ni al girarla: lo único que cambia es
// su marco. Es la separación que hace Rhino entre la geometría y su transformación, y la
// que el modelo viejo no tenía — ahí girar 90° reescribía las medidas y la forma para que
// la pieza *pareciera* girada, y la orientación terminaba diciendo cuál era el ancho.
//
// Representación: matriz de rotación 3×3 por filas + traslación. No Euler: componer
// Eulers acumula error y los cuartos de vuelta dejan de ser exactos (cos(π/2) = 6e-17,
// no 0). Con matriz, cada composición se ASIENTA: las entradas que quedan a menos de 1e-9
// de -1, 0 o 1 se clavan ahí. Así girar 90° cuatro veces vuelve exactamente al principio,
// y una caja girada un cuarto de vuelta tiene medidas exactas, sin ruido.
//
// Este módulo no importa nada: lo puede usar el servidor.

/** @typedef {[number, number, number]} Vec3 */
/** Rotación 3×3 por filas: [m11, m12, m13, m21, m22, m23, m31, m32, m33]. */
/** @typedef {[number, number, number, number, number, number, number, number, number]} Mat3 */
/**
 * Un marco: rotación + traslación. Lleva un punto del espacio local al del padre:
 * p_padre = r · p_local + t.
 * @typedef {{ r: Mat3, t: Vec3 }} Frame
 */
/** @typedef {0 | 1 | 2 | 'x' | 'y' | 'z'} Axis */

const EPS = 1e-9;

/** @returns {Mat3} */
export const identity3 = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** @param {Vec3} [t] @param {Mat3} [r] @returns {Frame} */
export const frame = (t = [0, 0, 0], r = identity3()) => ({ r: /** @type {Mat3} */ ([...r]), t: /** @type {Vec3} */ ([...t]) });

/** @param {Axis} a @returns {0 | 1 | 2} */
export function axisIndex(a) {
  if (a === 0 || a === 1 || a === 2) return a;
  const k = { x: 0, y: 1, z: 2 }[a];
  if (k === undefined) throw new Error(`eje inválido: ${String(a)} (va 'x', 'y', 'z' o 0, 1, 2)`);
  return /** @type {0 | 1 | 2} */ (k);
}

/** -0 → 0, para que la consola no muestre "-0" en una medida. */
const clean = (/** @type {number} */ v) => (v === 0 ? 0 : v);

/**
 * Coseno y seno de un ángulo en grados, EXACTOS en los múltiplos de 90°.
 * @param {number} deg
 */
function cosSin(deg) {
  const n = ((deg % 360) + 360) % 360;
  if (n === 0) return [1, 0];
  if (n === 90) return [0, 1];
  if (n === 180) return [-1, 0];
  if (n === 270) return [0, -1];
  const rad = (deg * Math.PI) / 180;
  return [Math.cos(rad), Math.sin(rad)];
}

/**
 * Rotación de `deg` grados alrededor de un eje: uno de los tres del marco ('x', 'y', 'z')
 * o un vector cualquiera (se normaliza). Regla de la mano derecha.
 * @param {Axis | Vec3} axis
 * @param {number} deg
 * @returns {Mat3}
 */
export function rotation(axis, deg) {
  const [c, s] = cosSin(deg);
  /** @type {Vec3} */
  let k;
  if (Array.isArray(axis)) {
    const n = Math.hypot(axis[0], axis[1], axis[2]);
    if (!n) throw new Error('eje de giro nulo');
    k = [axis[0] / n, axis[1] / n, axis[2] / n];
  } else {
    k = [0, 0, 0];
    k[axisIndex(axis)] = 1;
  }
  // Rodrigues: R = c·I + s·[k]× + (1 − c)·k·kᵀ. Con k en un eje y c, s exactos, sale exacta.
  const [x, y, z] = k, C = 1 - c;
  return settle([
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ]);
}

/** @param {Mat3} a @param {Mat3} b @returns {Mat3} a · b, asentada */
export function mul3(a, b) {
  /** @type {number[]} */
  const o = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) o.push(a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]);
  return settle(/** @type {Mat3} */ (o));
}

/** @param {Mat3} r @param {Vec3} v @returns {Vec3} */
export function rotate(r, v) {
  return [
    clean(r[0] * v[0] + r[1] * v[1] + r[2] * v[2]),
    clean(r[3] * v[0] + r[4] * v[1] + r[5] * v[2]),
    clean(r[6] * v[0] + r[7] * v[1] + r[8] * v[2]),
  ];
}

/** @param {Mat3} r @returns {Mat3} la transpuesta, que en una rotación es la inversa */
export const transpose3 = (r) => [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]];

/** @param {Frame} f @param {Vec3} p @returns {Vec3} el punto, del espacio local al del padre */
export function apply(f, p) {
  const q = rotate(f.r, p);
  return [clean(q[0] + f.t[0]), clean(q[1] + f.t[1]), clean(q[2] + f.t[2])];
}

/**
 * `outer` después de `inner`: si `inner` es el marco de un hijo respecto de su padre y
 * `outer` el del padre respecto del mundo, el resultado es el del hijo respecto del mundo.
 * @param {Frame} outer @param {Frame} inner @returns {Frame}
 */
export function compose(outer, inner) {
  return { r: mul3(outer.r, inner.r), t: apply(outer, inner.t) };
}

/** @param {Frame} f @returns {Frame} */
export function invert(f) {
  const rt = transpose3(f.r);
  const t = rotate(rt, f.t);
  return { r: rt, t: [clean(-t[0]), clean(-t[1]), clean(-t[2])] };
}

/**
 * El marco girado `deg` grados alrededor de un eje que pasa por `pivot`. Todo en el
 * espacio del padre del marco (el eje, el pivote y el resultado).
 * @param {Frame} f @param {Axis | Vec3} axis @param {number} deg @param {Vec3} pivot
 * @returns {Frame}
 */
export function turn(f, axis, deg, pivot) {
  const R = rotation(axis, deg);
  const d = rotate(R, [f.t[0] - pivot[0], f.t[1] - pivot[1], f.t[2] - pivot[2]]);
  return { r: mul3(R, f.r), t: [clean(d[0] + pivot[0]), clean(d[1] + pivot[1]), clean(d[2] + pivot[2])] };
}

/**
 * ¿La rotación es una combinación de cuartos de vuelta? Entonces cada eje local cae
 * exactamente sobre un eje del padre, y las cajas, el imán y los cortes son exactos.
 * @param {Mat3} r
 */
export const isQuarterTurn = (r) => r.every((v) => v === 0 || v === 1 || v === -1);

/**
 * Re-ortonormaliza (Gram-Schmidt por filas) y clava en -1, 0 o 1 lo que quedó a menos de
 * 1e-9. Lo primero evita que una cadena larga de giros chicos se vaya deformando; lo
 * segundo hace que los cuartos de vuelta sean exactos.
 * @param {Mat3} r @returns {Mat3}
 */
export function settle(r) {
  const nrm = (/** @type {number[]} */ v) => { const n = Math.hypot(v[0], v[1], v[2]); return v.map((x) => x / n); };
  const a = nrm([r[0], r[1], r[2]]);
  const b0 = [r[3], r[4], r[5]];
  const d = a[0] * b0[0] + a[1] * b0[1] + a[2] * b0[2];
  const b = nrm([b0[0] - d * a[0], b0[1] - d * a[1], b0[2] - d * a[2]]);
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return /** @type {Mat3} */ ([...a, ...b, ...c].map((v) => {
    for (const k of [-1, 0, 1]) if (Math.abs(v - k) < EPS) return k;
    return v;
  }));
}

// ---------- puente con el modelo viejo y con three ----------

/**
 * Euler XYZ (radianes) → matriz. Mismo orden que THREE.Euler 'XYZ' y que rotatePoint de
 * core/geom.js: Rx · Ry · Rz. Para leer piezas del modelo viejo, que guardaba `rot`.
 * @param {Vec3} e @returns {Mat3}
 */
export function fromEuler([x, y, z]) {
  const rad = (/** @type {number} */ a) => (a * 180) / Math.PI;
  return mul3(mul3(rotation('x', rad(x)), rotation('y', rad(y))), rotation('z', rad(z)));
}

/**
 * Matriz → Euler XYZ (radianes). En el polo (|m13| ≈ 1) los otros dos ángulos no se
 * pueden separar: se manda todo a x y z queda en 0, igual que THREE.Euler.
 * @param {Mat3} r @returns {Vec3}
 */
export function toEuler(r) {
  const m13 = r[2];
  const y = Math.asin(Math.min(1, Math.max(-1, m13)));
  return Math.abs(m13) < 0.9999999
    ? [clean(Math.atan2(-r[5], r[8])), clean(y), clean(Math.atan2(-r[1], r[0]))]
    : [clean(Math.atan2(r[7], r[4])), clean(y), 0];
}

/**
 * Los 16 números de la Matrix4 de three, en el orden de `Matrix4.fromArray` (por
 * columnas). Es lo único que el visor necesita de un marco.
 * @param {Frame} f @returns {number[]}
 */
export function toColumns4({ r, t }) {
  return [r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0, t[0], t[1], t[2], 1];
}
