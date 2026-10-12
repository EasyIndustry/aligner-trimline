// Agarre: el vértice, la arista o la cara de una pieza más cercana a un punto, y lo primero que
// corta un rayo.
//
// Se calcula en el marco de la pieza, así anda igual con la pieza girada. La tolerancia es POR
// EJE de la pieza: cada eje tiene una franja de `tol[k]`, y un punto "está cerca" de un rasgo si
// en cada eje queda adentro de su franja (distancia de Chebyshev escalada). Así, en una tabla
// fina, la franja del canto puede ser más angosta que la de la cara sin comerse el espesor.
//
// Se prefiere un vértice a una arista y una arista a una cara: es lo que hace útil al imán.
//
// Puro: no importa three ni DOM.

/** @typedef {import('./frame.js').Vec3} Vec3 */
/** @typedef {{ outer: Vec3[], holes: Vec3[][], normal: Vec3 }} PlanarFace */
/** @typedef {{ vertices: readonly Vec3[], edges: readonly (readonly [Vec3, Vec3])[], faces: readonly PlanarFace[] }} Rasgos */
/**
 * @typedef {{ kind: 'vertex', point: Vec3, d: number } | { kind: 'edge', point: Vec3, edge: readonly [Vec3, Vec3], d: number }
 *   | { kind: 'face', point: Vec3, face: PlanarFace, d: number }} Hallazgo
 */

/** @param {Vec3} a @param {Vec3} b @returns {Vec3} */ const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** @param {Vec3} a @param {Vec3} b */ const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** @param {Vec3} a @param {Vec3} b @returns {Vec3} */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** La distancia de p a q en la franja de cada eje (1: justo en el borde de la franja). @param {Vec3} p @param {Vec3} q @param {Vec3} tol */
const escalada = (p, q, tol) => Math.max(Math.abs(p[0] - q[0]) / tol[0], Math.abs(p[1] - q[1]) / tol[1], Math.abs(p[2] - q[2]) / tol[2]);

/** El punto del segmento ab más cercano a p. @param {Vec3} p @param {readonly [Vec3, Vec3]} ab @returns {Vec3} */
function alSegmento(p, [a, b]) {
  const d = sub(b, a), L2 = dot(d, d);
  const t = L2 ? Math.min(1, Math.max(0, dot(sub(p, a), d) / L2)) : 0;
  return [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
}

/** ¿El punto (sobre el plano de la cara) cae adentro del contorno y afuera de los agujeros? @param {Vec3} p @param {PlanarFace} f */
function sobreLaCara(p, f) {
  const n = f.normal;
  const k = [0, 1, 2].reduce((m, i) => (Math.abs(n[i]) > Math.abs(n[m]) ? i : m), 0);
  const [u, v] = [0, 1, 2].filter((i) => i !== k);
  /** @param {readonly Vec3[]} poly */
  const dentro = (poly) => {
    let adentro = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi, xj, yj] = [poly[i][u], poly[i][v], poly[j][u], poly[j][v]];
      if (yi > p[v] !== yj > p[v] && p[u] < ((xj - xi) * (p[v] - yi)) / (yj - yi) + xi) adentro = !adentro;
    }
    return adentro;
  };
  return dentro(f.outer) && !f.holes.some(dentro);
}

/** Los tipos de rasgo, del más al menos preferido. */
export const FEATURE_KINDS = Object.freeze(/** @type {const} */ (['vertex', 'edge', 'face']));

/**
 * El rasgo más cercano a `p` (todo en el marco de la pieza), o null si ninguno queda dentro de
 * su franja. `kinds`: los tipos que se aceptan (por defecto los tres); lo que no está en la lista
 * ni se mira, así que en una esquina sin vértices pedidos se devuelve su arista o su cara.
 * @param {Vec3} p @param {Rasgos} rasgos @param {Vec3} tol la franja de cada eje
 * @param {readonly ('vertex' | 'edge' | 'face')[]} [kinds]
 * @returns {Hallazgo | null}
 */
export function closestFeature(p, rasgos, tol, kinds = FEATURE_KINDS) {
  /** @type {Hallazgo | null} */
  let mejor = null;
  for (const v of kinds.includes('vertex') ? rasgos.vertices : []) {
    const d = escalada(p, v, tol);
    if (d <= 1 && (!mejor || d < mejor.d)) mejor = { kind: 'vertex', point: v, d };
  }
  if (mejor) return mejor;
  for (const e of kinds.includes('edge') ? rasgos.edges : []) {
    const q = alSegmento(p, e);
    const d = escalada(p, q, tol);
    if (d <= 1 && (!mejor || d < mejor.d)) mejor = { kind: 'edge', point: q, edge: e, d };
  }
  if (mejor) return mejor;
  for (const f of kinds.includes('face') ? rasgos.faces : []) {
    const n = f.normal;
    const q = sub(p, mul(n, dot(sub(p, f.outer[0]), n)));
    if (!sobreLaCara(q, f)) continue;
    const d = escalada(p, q, tol);
    if (d <= 1 && (!mejor || d < mejor.d)) mejor = { kind: 'face', point: q, face: f, d };
  }
  return mejor;
}

/** @param {Vec3} a @param {number} s @returns {Vec3} */
function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }

/**
 * Dónde corta un rayo a una malla (Möller–Trumbore): la distancia sobre el rayo (en unidades de
 * `dir`) y la normal de la cara que corta, o null.
 * @param {Vec3} origin @param {Vec3} dir @param {{ positions: readonly number[], indices: readonly number[] }} mesh
 * @returns {{ t: number, normal: Vec3 } | null}
 */
export function rayMesh(origin, dir, mesh) {
  const P = mesh.positions, I = mesh.indices;
  /** @type {{ t: number, normal: Vec3 } | null} */
  let mejor = null;
  for (let k = 0; k < I.length; k += 3) {
    const a = /** @type {Vec3} */ ([P[3 * I[k]], P[3 * I[k] + 1], P[3 * I[k] + 2]]);
    const b = /** @type {Vec3} */ ([P[3 * I[k + 1]], P[3 * I[k + 1] + 1], P[3 * I[k + 1] + 2]]);
    const c = /** @type {Vec3} */ ([P[3 * I[k + 2]], P[3 * I[k + 2] + 1], P[3 * I[k + 2] + 2]]);
    const e1 = sub(b, a), e2 = sub(c, a);
    const h = cross(dir, e2), det = dot(e1, h);
    if (Math.abs(det) < 1e-15) continue;
    const f = 1 / det, s = sub(origin, a), u = f * dot(s, h);
    if (u < 0 || u > 1) continue;
    const q = cross(s, e1), v = f * dot(dir, q);
    if (v < 0 || u + v > 1) continue;
    const t = f * dot(e2, q);
    if (t <= 1e-12 || (mejor && t >= mejor.t)) continue;
    const n = cross(e1, e2), m = Math.hypot(...n);
    mejor = { t, normal: mul(n, 1 / m) };
  }
  return mejor;
}

/**
 * Dónde entra un rayo a una caja centrada en el origen, de medio largo `h` por eje (o null si
 * no la corta): sirve de filtro rápido antes de mirar la malla.
 * @param {Vec3} origin @param {Vec3} dir @param {Vec3} h
 */
export function rayBox(origin, dir, h) {
  let t0 = -Infinity, t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(dir[k]) < 1e-300) {
      if (Math.abs(origin[k]) > h[k]) return null;
      continue;
    }
    const a = (-h[k] - origin[k]) / dir[k], b = (h[k] - origin[k]) / dir[k];
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  return t1 >= Math.max(t0, 0) ? Math.max(t0, 0) : null;
}
