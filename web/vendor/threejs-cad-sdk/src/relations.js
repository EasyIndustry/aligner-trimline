// Las cuentas de las relaciones entre partes: cuánto gira o corre una junta, qué cantos o
// direcciones sirven para una junta, cuánto se mueve o se estira la punta anclada de un vínculo,
// cómo se reparten los puntos de una unión y cuánto material atraviesa. El modelo las guarda
// (model.js) y el taller las pone en orden (index.js); acá solo está la cuenta.
//
// Puro: no importa three ni DOM.
import { frame, turn } from './frame.js';

/** @typedef {import('./frame.js').Vec3} Vec3 */
/** @typedef {import('./frame.js').Frame} Frame */
/** @typedef {{ min: Vec3, max: Vec3 }} Caja */

/** Los tipos de relación que el SDK sabe poner en orden. */
export const RELATION_KINDS = Object.freeze(['joint', 'fixing', 'link']);
/** Los tipos de junta: giro sobre un eje, o deslizamiento a lo largo de una dirección. */
export const JOINT_TYPES = Object.freeze(['revolute', 'prismatic']);

/** @param {Vec3} a @param {Vec3} b */ const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** @param {Vec3} a @param {Vec3} b @returns {Vec3} */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** @param {Vec3} a @param {Vec3} b @returns {Vec3} */ const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/**
 * El movimiento de una junta abierta en `value` (grados si gira, unidades del documento si
 * corre), como un marco del mundo que se le aplica a la parte móvil.
 * @param {'revolute' | 'prismatic'} type @param {Vec3} origin @param {Vec3} direction (unitario) @param {number} value
 * @returns {Frame}
 */
export function jointMotion(type, origin, direction, value) {
  if (type === 'revolute') return turn(frame(), direction, value, origin);
  return frame(/** @type {Vec3} */ (direction.map((x) => x * value)));
}

/** El valor dentro de los límites (si hay). @param {number} v @param {[number, number] | null} limits */
export const clampTo = (v, limits) => (limits ? Math.min(limits[1], Math.max(limits[0], v)) : v);

/** La distancia de un punto a una caja (0 si está adentro). @param {Vec3} p @param {Caja} b */
function aLaCaja(p, b) {
  return Math.hypot(...[0, 1, 2].map((k) => Math.max(b.min[k] - p[k], 0, p[k] - b.max[k])));
}

/**
 * Los cantos donde puede ir el eje de giro de una parte móvil (una puerta, una tapa), todo en el
 * marco de la base: los cuatro cantos de la cara de la móvil que mira a la base, con el sentido
 * que la abre ALEJÁNDOLA de la base. Primero los más cerca de la base y, entre esos, los más
 * largos (las bisagras van en el canto largo).
 * @param {Caja} m la caja de la móvil @param {Caja} b la caja de la base
 * @returns {{ origin: Vec3, direction: Vec3, length: number, distance: number }[]}
 */
export function hingeCandidates(m, b) {
  const ext = [0, 1, 2].map((k) => m.max[k] - m.min[k]);
  const t = /** @type {0 | 1 | 2} */ ([0, 1, 2].reduce((a, k) => (ext[k] < ext[a] ? k : a), 0));
  const cm = /** @type {Vec3} */ ([0, 1, 2].map((k) => (m.min[k] + m.max[k]) / 2));
  const cb = [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2);
  const st = cb[t] > cm[t] ? 1 : -1; // hacia dónde está la base
  const cara = st > 0 ? m.max[t] : m.min[t];
  /** @type {Vec3} */ const afuera = [0, 0, 0];
  afuera[t] = -st;
  const escala = Math.max(1, ...ext);
  /** @type {{ origin: Vec3, direction: Vec3, length: number, distance: number }[]} */
  const out = [];
  for (const e of [0, 1, 2].filter((k) => k !== t)) {
    const w = /** @type {0 | 1 | 2} */ ([0, 1, 2].find((k) => k !== t && k !== e));
    for (const pos of [m.min[w], m.max[w]]) {
      /** @type {Vec3} */ const origin = [0, 0, 0];
      origin[t] = cara; origin[w] = pos; origin[e] = m.min[e];
      /** @type {Vec3} */ let dir = [0, 0, 0];
      dir[e] = 1;
      if (dot(cross(dir, sub(cm, origin)), afuera) < 0) dir = [-dir[0], -dir[1], -dir[2]];
      const o = dir[e] > 0 ? origin : /** @type {Vec3} */ (origin.map((x, k) => (k === e ? m.max[e] : x)));
      /** @type {Vec3} */ const medio = [...origin];
      medio[e] = (m.min[e] + m.max[e]) / 2;
      out.push({ origin: o, direction: dir, length: ext[e], distance: aLaCaja(medio, b) });
    }
  }
  const tol = 1e-6 * escala;
  return out.sort((x, y) => (Math.abs(x.distance - y.distance) > tol ? x.distance - y.distance : y.length - x.length));
}

/**
 * Las direcciones en que puede correr una parte móvil (un cajón) sin chocar con las piezas de la
 * base, en el marco de la base: los seis sentidos de sus ejes, salvo los que barren alguna pieza
 * de la base. `travel` es el largo de la móvil en esa dirección (lo que puede salir) y `gap`,
 * cuánto queda su cara adentro de la caja de la base (negativo: sobresale). Primero las que
 * menos tienen que andar para salir.
 * @param {Caja} m @param {Caja[]} piezasBase @param {number} tol
 * @returns {{ direction: Vec3, travel: number, gap: number }[]}
 */
export function slideCandidates(m, piezasBase, tol) {
  const b = {
    min: /** @type {Vec3} */ ([0, 1, 2].map((k) => Math.min(...piezasBase.map((p) => p.min[k])))),
    max: /** @type {Vec3} */ ([0, 1, 2].map((k) => Math.max(...piezasBase.map((p) => p.max[k])))),
  };
  /** @type {{ direction: Vec3, travel: number, gap: number }[]} */
  const out = [];
  for (const k of [0, 1, 2]) for (const s of [1, -1]) {
    const travel = m.max[k] - m.min[k];
    const barrido = { min: /** @type {Vec3} */ ([...m.min]), max: /** @type {Vec3} */ ([...m.max]) };
    if (s > 0) barrido.max[k] += travel; else barrido.min[k] -= travel;
    const choca = piezasBase.some((p) => [0, 1, 2].every((i) => Math.min(barrido.max[i], p.max[i]) - Math.max(barrido.min[i], p.min[i]) > tol));
    if (choca) continue;
    /** @type {Vec3} */ const direction = [0, 0, 0];
    direction[k] = s;
    out.push({ direction, travel, gap: s > 0 ? b.max[k] - m.max[k] : m.min[k] - b.min[k] });
  }
  return out.sort((x, y) => x.gap - y.gap);
}

/**
 * Cuánto hay que correr, a lo largo de `d`, la punta de una pieza que está en `x0` para que
 * quede sobre el plano `n · x = h`. `n` y `d` tienen que ser paralelos (o casi).
 * @param {Vec3} n @param {number} h @param {Vec3} x0 @param {Vec3} d
 */
export const anchorDelta = (n, h, x0, d) => (h - dot(n, x0)) / dot(n, d);

/**
 * `count` puntos repartidos sobre un parche, normalizados (de 0 a 1): a lo largo de su lado más
 * largo, en 1/(n+1), 2/(n+1)…, y en el medio del otro.
 * @param {number} count @param {number} du el largo real del parche en u @param {number} dv el de v
 * @returns {[number, number][]}
 */
export function distribute(count, du, dv) {
  return Array.from({ length: count }, (_, i) => {
    const f = (i + 1) / (count + 1);
    return /** @type {[number, number]} */ (du >= dv ? [f, 0.5] : [0.5, f]);
  });
}

/**
 * Cuánto material atraviesa una recta que pasa por `p` en la dirección `dir` (unitaria): el
 * largo del tramo de sólido que contiene a `p` (o que empieza o termina en él). En una pieza
 * maciza es la sombra de la pieza sobre `dir`; en un caño, la pared. null si la recta no la toca.
 * @param {{ positions: ArrayLike<number>, indices: ArrayLike<number> }} mesh @param {Vec3} p @param {Vec3} dir
 */
export function crossing(mesh, p, dir) {
  const P = mesh.positions, I = mesh.indices;
  /** @type {number[]} */
  const ts = [];
  let escala = 0;
  for (let k = 0; k < P.length; k++) escala = Math.max(escala, Math.abs(P[k]));
  for (let k = 0; k < I.length; k += 3) {
    /** @param {number} i @returns {Vec3} */
    const v = (i) => [P[3 * i], P[3 * i + 1], P[3 * i + 2]];
    const a = v(I[k]), b = v(I[k + 1]), c = v(I[k + 2]);
    const e1 = sub(b, a), e2 = sub(c, a);
    const h = cross(dir, e2), det = dot(e1, h);
    if (Math.abs(det) < 1e-15) continue;
    const f = 1 / det, s = sub(p, a), u = f * dot(s, h);
    if (u < -1e-12 || u > 1 + 1e-12) continue;
    const q = cross(s, e1), w = f * dot(dir, q);
    if (w < -1e-12 || u + w > 1 + 1e-12) continue;
    ts.push(f * dot(e2, q));
  }
  ts.sort((x, y) => x - y);
  const eps = 1e-9 * Math.max(1, escala);
  /** @type {number[]} */
  const unicos = [];
  for (const t of ts) if (!unicos.length || t - /** @type {number} */ (unicos.at(-1)) > eps) unicos.push(t);
  if (unicos.length < 2 || unicos.length % 2) return null;
  let mejor = null;
  for (let i = 0; i < unicos.length; i += 2) {
    const [lo, hi] = [unicos[i], unicos[i + 1]];
    if (lo - eps <= 0 && 0 <= hi + eps) {
      if (mejor === null || hi - lo > mejor) mejor = hi - lo;
    }
  }
  return mejor;
}
