// Contacto e intersección entre piezas: ¿se tocan?, ¿se meten una en otra?, y dónde.
//
// Hoy una pieza es su caja (ver README: la forma real viene después), así que esto trabaja
// con cajas ORIENTADAS — giradas como estén, no alineadas al mundo. Es lo que el modelo
// viejo no podía: placement.js decide con cajas alineadas a los ejes, que para una pieza
// girada son más grandes que la pieza.
//
// Tres preguntas distintas, porque en carpintería son tres cosas distintas:
//   - intersects: ¿se meten una en otra? Un choque: hay que recortar o mover.
//   - touches: ¿se tocan sin meterse? Ahí va cola, un tornillo, un tarugo.
//   - contacts: ¿dónde se tocan? Una cara (con su polígono y su área), una arista o un punto.
//
// Las tolerancias no se escriben acá: vienen de afuera, en la unidad del documento (los
// valores sugeridos viven en config.js). Dos piezas se tocan si están a `tol` o menos, y se
// meten una en otra si la penetración pasa del umbral de penetración.
//
// Puro: no importa three ni DOM.
/** @typedef {import('./frame.js').Vec3} Vec3 */
/** @typedef {import('./model.js').Model} Model */
/** @typedef {import('./model.js').PieceDef} PieceDef */

/**
 * Una caja orientada en el mundo: centro, sus tres ejes (unitarios) y medio largo por eje.
 * @typedef {{ id: string, c: Vec3, ax: [Vec3, Vec3, Vec3], h: Vec3 }} OBB
 */

// ---------- vectores ----------
/** @param {Vec3} a @param {Vec3} b @returns {Vec3} */ const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** @param {Vec3} a @param {Vec3} b @returns {Vec3} */ const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** @param {Vec3} a @param {number} s @returns {Vec3} */ const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
/** @param {Vec3} a @param {Vec3} b */ const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** @param {Vec3} a @param {Vec3} b @returns {Vec3} */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** @param {Vec3} a */ const len = (a) => Math.hypot(a[0], a[1], a[2]);

/** La caja orientada de una pieza, en el mundo. @param {Model} m @param {string} id @returns {OBB} */
export function obbOf(m, id) {
  const p = m.piece(id);
  const f = m.worldFrame(id);
  const r = f.r;
  return {
    id,
    c: [...f.t],
    ax: [[r[0], r[3], r[6]], [r[1], r[4], r[7]], [r[2], r[5], r[8]]],
    h: [p.size[0] / 2, p.size[1] / 2, p.size[2] / 2],
  };
}

/** La misma caja, `d` (en la unidad del documento) más grande hacia cada lado. @param {OBB} b @param {number} d @returns {OBB} */
const inflate = (b, d) => ({ ...b, h: [b.h[0] + d, b.h[1] + d, b.h[2] + d] });

/** Sus 6 planos, con la normal hacia afuera: un punto está adentro si n·x ≤ d. @param {OBB} b */
function planes(b) {
  /** @type {{ n: Vec3, d: number, axis: 0 | 1 | 2, side: 1 | -1 }[]} */
  const out = [];
  for (let i = 0; i < 3; i++) {
    for (const s of /** @type {(1 | -1)[]} */ ([1, -1])) {
      const n = mul(b.ax[i], s);
      out.push({ n, d: dot(n, b.c) + b.h[i], axis: /** @type {0 | 1 | 2} */ (i), side: s });
    }
  }
  return out;
}

/** Sus 6 caras como polígonos (4 esquinas, en orden). @param {OBB} b */
function faces(b) {
  return planes(b).map((pl) => {
    const [u, v] = [0, 1, 2].filter((k) => k !== pl.axis);
    const center = add(b.c, mul(pl.n, b.h[pl.axis]));
    const U = mul(b.ax[u], b.h[u]), V = mul(b.ax[v], b.h[v]);
    /** @type {Vec3[]} */
    const poly = [sub(sub(center, U), V), sub(add(center, U), V), add(add(center, U), V), add(sub(center, U), V)];
    return { ...pl, poly, center };
  });
}

/**
 * Recorta un polígono plano contra un semiespacio n·x ≤ d (Sutherland–Hodgman).
 * @param {Vec3[]} poly @param {Vec3} n @param {number} d @returns {Vec3[]}
 */
function clip(poly, n, d) {
  /** @type {Vec3[]} */
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = dot(n, a) - d, db = dot(n, b) - d;
    if (da <= 1e-9) out.push(a);
    if ((da < -1e-9 && db > 1e-9) || (da > 1e-9 && db < -1e-9)) out.push(add(a, mul(sub(b, a), da / (da - db))));
  }
  return out;
}

/** Área de un polígono plano en 3D. @param {Vec3[]} poly */
function area(poly) {
  /** @type {Vec3} */
  let s = [0, 0, 0];
  for (let i = 0; i < poly.length; i++) s = add(s, cross(poly[i], poly[(i + 1) % poly.length]));
  return len(s) / 2;
}

/**
 * Teorema de los ejes separadores: cuánto se solapan las dos cajas en el eje en que MENOS
 * se solapan. Negativo: están separadas por al menos esa distancia. Es la profundidad de
 * penetración de verdad para dos cajas (los 15 ejes: 3 + 3 caras y 9 productos de aristas).
 * @param {OBB} a @param {OBB} b
 */
export function satDepth(a, b) {
  const d = sub(b.c, a.c);
  /** @type {Vec3[]} */
  const ejes = [...a.ax, ...b.ax];
  for (const x of a.ax) for (const y of b.ax) {
    const c = cross(x, y);
    const n = len(c);
    if (n > 1e-9) ejes.push(mul(c, 1 / n)); // ejes paralelos: el producto no aporta
  }
  let min = Infinity;
  for (const L of ejes) {
    const ra = a.h[0] * Math.abs(dot(a.ax[0], L)) + a.h[1] * Math.abs(dot(a.ax[1], L)) + a.h[2] * Math.abs(dot(a.ax[2], L));
    const rb = b.h[0] * Math.abs(dot(b.ax[0], L)) + b.h[1] * Math.abs(dot(b.ax[1], L)) + b.h[2] * Math.abs(dot(b.ax[2], L));
    min = Math.min(min, ra + rb - Math.abs(dot(d, L)));
  }
  return min;
}

/**
 * La intersección de dos cajas: un poliedro convexo. Su borde son las caras de cada caja
 * recortadas por la otra. Devuelve sus caras (polígonos), sus vértices y su volumen, o null
 * si no se tocan.
 * @param {OBB} a @param {OBB} b
 * @returns {{ faces: Vec3[][], vertices: Vec3[], volume: number } | null}
 */
export function intersectBoxes(a, b) {
  /** @type {Map<string, Vec3[]>} un polígono por plano: si las dos cajas comparten un plano, va una vez */
  const porPlano = new Map();
  for (const [x, y] of [[a, b], [b, a]]) {
    for (const f of faces(x)) {
      let poly = f.poly;
      for (const pl of planes(y)) { poly = clip(poly, pl.n, pl.d); if (poly.length < 3) break; }
      if (poly.length < 3 || area(poly) < 1e-9) continue;
      const key = [...f.n.map((v) => Math.round(v * 1e6)), Math.round(f.d * 1e6)].join(',');
      if (!porPlano.has(key)) porPlano.set(key, poly);
    }
  }
  const caras = [...porPlano.values()];
  if (!caras.length) return null;
  /** @type {Vec3[]} */
  const vertices = [];
  for (const poly of caras) for (const v of poly) if (!vertices.some((w) => len(sub(v, w)) < 1e-7)) vertices.push(v);
  // volumen de un convexo: suma de pirámides desde un punto interior
  const c = mul(vertices.reduce(add, [0, 0, 0]), 1 / vertices.length);
  let volume = 0;
  for (const poly of caras) {
    /** @type {Vec3} */
    let s = [0, 0, 0];
    for (let i = 0; i < poly.length; i++) s = add(s, cross(poly[i], poly[(i + 1) % poly.length]));
    const n = len(s);
    if (n < 1e-12) continue;
    volume += (n / 2) * Math.abs(dot(mul(s, 1 / n), sub(poly[0], c))) / 3;
  }
  return { faces: caras, vertices, volume };
}

/**
 * Dónde se tocan dos cajas que no se meten una en otra.
 *   - 'face': dos caras enfrentadas y en el mismo plano (con tolerancia): el polígono donde
 *     se solapan, en el plano del medio, con su área. Es el caso de la cola y los tornillos.
 *   - 'edge' / 'point': una arista o un vértice apoyado en la otra (una pieza girada sobre
 *     otra). El segmento o el punto, a la tolerancia.
 * @param {OBB} a @param {OBB} b @param {number} tol
 * @returns {{ kind: 'face' | 'edge' | 'point', points: Vec3[], area: number, normal: Vec3,
 *             faceA: { axis: 0 | 1 | 2, side: 1 | -1 } | null, faceB: { axis: 0 | 1 | 2, side: 1 | -1 } | null }[]}
 */
export function contactsOf(a, b, tol) {
  /** @type {ReturnType<typeof contactsOf>} */
  const out = [];
  // una cara de contacto más angosta que 1/200 de la tolerancia es una astilla, no una cara
  const sliver = Math.max(1e-12, (tol / 200) ** 2);
  const fa = faces(a), fb = faces(b);
  for (const x of fa) {
    for (const y of fb) {
      if (dot(x.n, y.n) > -1 + 1e-9) continue;                          // enfrentadas
      const gap = dot(x.n, sub(y.center, x.center));
      if (Math.abs(gap) > tol) continue;                               // en el mismo plano
      let poly = x.poly;
      const [u, v] = [0, 1, 2].filter((k) => k !== y.axis);
      for (const k of [u, v]) {                                         // recortada por los 4 lados de y
        for (const s of [1, -1]) {
          const n = mul(b.ax[k], s);
          poly = clip(poly, n, dot(n, b.c) + b.h[k]);
          if (poly.length < 3) break;
        }
        if (poly.length < 3) break;
      }
      if (poly.length < 3) continue;
      const ar = area(poly);
      if (ar < sliver) continue; // una astilla de área casi nula: eso es una arista, se ve abajo
      const medio = mul(x.n, gap / 2);
      out.push({ kind: 'face', points: poly.map((q) => add(q, medio)), area: ar, normal: x.n, faceA: { axis: x.axis, side: x.side }, faceB: { axis: y.axis, side: y.side } });
    }
  }
  if (out.length) return out;
  // sin caras: ¿una arista o un vértice? Lo que queda de `a` adentro de `b` agrandada
  const r = intersectBoxes(a, inflate(b, tol));
  if (!r) return out;
  let lejos = [r.vertices[0], r.vertices[0]], dmax = 0;
  for (const p of r.vertices) for (const q of r.vertices) { const d = len(sub(p, q)); if (d > dmax) { dmax = d; lejos = [p, q]; } }
  const centro = mul(r.vertices.reduce(add, [0, 0, 0]), 1 / r.vertices.length);
  // la normal: de a hacia b, por el centro de lo que se toca
  const haciaB = sub(b.c, a.c);
  const n = len(haciaB) > 1e-9 ? mul(haciaB, 1 / len(haciaB)) : /** @type {Vec3} */ ([0, 1, 0]);
  // ¿Punto o arista? Al agrandar la caja por `tol`, un vértice (de ángulos rectos) baja
  // tol·√3 por su diagonal, y el plano donde apoya lo corta en un triángulo de lado
  // tol·√18 ≈ 4,24·tol: eso mide un contacto de punto. Una arista mide lo que la arista.
  if (dmax <= 6 * tol) out.push({ kind: 'point', points: [centro], area: 0, normal: n, faceA: null, faceB: null });
  else out.push({ kind: 'edge', points: lejos, area: 0, normal: n, faceA: null, faceB: null });
  return out;
}

/**
 * Pares de piezas (de las dos partes) cuyas cajas en el mundo, agrandadas por `tol`, se
 * cruzan: la criba rápida antes de las cuentas finas.
 * @param {Model} m @param {string[]} as @param {string[]} bs @param {number} tol
 * @returns {[string, string][]}
 */
export function candidatePairs(m, as, bs, tol) {
  /** @type {[string, string][]} */
  const out = [];
  const visto = new Set();
  const caja = new Map([...as, ...bs].map((id) => [id, m.box(id, 'world')]));
  for (const x of as) {
    for (const y of bs) {
      if (x === y) continue;
      const k = x < y ? `${x}|${y}` : `${y}|${x}`;
      if (visto.has(k)) continue;
      visto.add(k);
      const A = /** @type {import('./model.js').Box} */ (caja.get(x)), B = /** @type {import('./model.js').Box} */ (caja.get(y));
      if ([0, 1, 2].every((i) => A.min[i] <= B.max[i] + tol && B.min[i] <= A.max[i] + tol)) out.push(x < y ? [x, y] : [y, x]);
    }
  }
  return out;
}
