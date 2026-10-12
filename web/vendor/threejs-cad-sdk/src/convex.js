// Poliedros convexos: la forma real de una pieza, partida en pedazos convexos.
//
// Un convexo es la intersección de semiespacios (n·x ≤ d). Con eso, sin ningún kernel:
//   - intersecar dos convexos es juntar sus planos (y da otro convexo);
//   - restarle a A un convexo B da varios convexos (A afuera de cada plano de B, adentro de los
//     anteriores);
//   - la profundidad de penetración y el contacto entre dos convexos salen del teorema de los
//     ejes separadores y del recorte de polígonos, como para las cajas de contact.js.
// Una pieza con perfil, torneado, cortes, agujeros o recortes es una UNIÓN de convexos que no se
// solapan: su contacto exacto es el de sus pedazos.
//
// Cada plano lleva `tag`: null si su cara es plana de verdad, o el nombre de la superficie lisa
// (un cilindro, un cono) que aproxima. Un contacto contra una superficie lisa no es de cara: es
// la línea donde apoya.
//
// Puro: no importa three ni DOM.
import { apply, rotate } from './frame.js';

/** @typedef {import('./frame.js').Vec3} Vec3 */
/** @typedef {import('./frame.js').Frame} Frame */
/** @typedef {{ n: Vec3, d: number, tag: string | null }} Plane */
/** @typedef {{ poly: Vec3[], plane: Plane }} CFace */
/** @typedef {{ planes: Plane[], faces: CFace[], vertices: Vec3[], scale: number }} Convex */

/** @param {Vec3} a @param {Vec3} b @returns {Vec3} */ const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** @param {Vec3} a @param {Vec3} b @returns {Vec3} */ const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** @param {Vec3} a @param {number} s @returns {Vec3} */ const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
/** @param {Vec3} a @param {Vec3} b */ const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** @param {Vec3} a @param {Vec3} b @returns {Vec3} */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** @param {Vec3} a */ const len = (a) => Math.hypot(a[0], a[1], a[2]);
/** @param {Vec3} a @returns {Vec3} */ const unit = (a) => mul(a, 1 / len(a));

/** El vector área de un polígono plano (Newell): su largo es el doble del área. @param {readonly Vec3[]} poly @returns {Vec3} */
export function areaVector(poly) {
  /** @type {Vec3} */
  let s = [0, 0, 0];
  for (let i = 0; i < poly.length; i++) s = add(s, cross(poly[i], poly[(i + 1) % poly.length]));
  return s;
}
/** @param {readonly Vec3[]} poly */
export const polyArea = (poly) => len(areaVector(poly)) / 2;
/** @param {readonly Vec3[]} poly @returns {Vec3} */
export const centroid = (poly) => mul(poly.reduce(add, /** @type {Vec3} */ ([0, 0, 0])), 1 / poly.length);

/**
 * Recorta un polígono plano contra el semiespacio n·x ≤ d (Sutherland–Hodgman).
 * @param {readonly Vec3[]} poly @param {Vec3} n @param {number} d @param {number} eps @returns {Vec3[]}
 */
export function clip(poly, n, d, eps) {
  /** @type {Vec3[]} */
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = dot(n, a) - d, db = dot(n, b) - d;
    if (da <= eps) out.push(a);
    if ((da < -eps && db > eps) || (da > eps && db < -eps)) out.push(add(a, mul(sub(b, a), da / (da - db))));
  }
  return out;
}

/** Un cuadrado enorme sobre el plano, antihorario visto desde su normal. @param {Plane} pl @param {number} S @returns {Vec3[]} */
function cuadradoEn(pl, S) {
  const a = /** @type {Vec3} */ (Math.abs(pl.n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
  const u = unit(cross(pl.n, a)), v = cross(pl.n, u);
  const c = mul(pl.n, pl.d);
  return [add(add(c, mul(u, -S)), mul(v, -S)), add(add(c, mul(u, S)), mul(v, -S)), add(add(c, mul(u, S)), mul(v, S)), add(add(c, mul(u, -S)), mul(v, S))];
}

/**
 * El convexo de unos semiespacios, o null si no encierran volumen. `scale` es el tamaño de lo
 * que se trabaja (de él salen las tolerancias, para que no dependan de la unidad).
 * @param {readonly Plane[]} planes @param {number} scale @returns {Convex | null}
 */
export function fromPlanes(planes, scale) {
  const eps = 1e-9 * scale;
  /** @type {Plane[]} */
  const unicos = [];
  for (const p of planes) {
    const k = unicos.findIndex((q) => dot(q.n, p.n) > 1 - 1e-12);
    if (k < 0) unicos.push(p);
    else if (p.d < unicos[k].d - eps || (Math.abs(p.d - unicos[k].d) <= eps && unicos[k].tag && !p.tag)) unicos[k] = p; // el más ajustado; si empatan, el plano de verdad
  }
  /** @type {CFace[]} */
  const faces = [];
  for (const pl of unicos) {
    let poly = cuadradoEn(pl, 50 * scale);
    for (const q of unicos) {
      if (q === pl) continue;
      poly = clip(poly, q.n, q.d, eps);
      if (poly.length < 3) break;
    }
    if (poly.length >= 3 && polyArea(poly) > eps * scale) faces.push({ poly, plane: pl });
  }
  if (faces.length < 4) return null;
  /** @type {Vec3[]} */
  const vertices = [];
  for (const f of faces) for (const v of f.poly) if (!vertices.some((w) => len(sub(v, w)) < 1e3 * eps)) vertices.push(v);
  const c = { planes: faces.map((f) => f.plane), faces, vertices, scale };
  return volume(c) > eps * scale * scale ? c : null;
}

/** El volumen de un convexo. @param {Convex} c */
export function volume(c) {
  let v = 0;
  for (const f of c.faces) v += (f.plane.d * polyArea(f.poly)) / 3;
  return v;
}

/** La intersección de dos convexos (null si no se tocan). @param {Convex} a @param {Convex} b */
export const intersect = (a, b) => fromPlanes([...a.planes, ...b.planes], Math.max(a.scale, b.scale));

/**
 * A menos B: los pedazos de A que caen afuera de B (convexos, sin solaparse). Las caras nuevas
 * son las de B, con su `tag`.
 * @param {Convex} a @param {Convex} b @returns {Convex[]}
 */
export function subtract(a, b) {
  if (!intersect(a, b)) return [a];
  const S = Math.max(a.scale, b.scale);
  /** @type {Convex[]} */
  const out = [];
  const acc = [...a.planes];
  for (const pl of b.planes) {
    const pedazo = fromPlanes([...acc, { n: mul(pl.n, -1), d: -pl.d, tag: pl.tag }], S);
    if (pedazo) out.push(pedazo);
    acc.push(pl);
  }
  return out;
}

/** Un convexo, llevado por un marco. @param {Convex} c @param {Frame} f @returns {Convex} */
export function transformConvex(c, f) {
  /** @type {Map<Plane, Plane>} */
  const nuevos = new Map();
  for (const p of c.planes) {
    const n = rotate(f.r, p.n);
    nuevos.set(p, { n, d: dot(n, apply(f, mul(p.n, p.d))), tag: p.tag });
  }
  return {
    planes: c.planes.map((p) => /** @type {Plane} */ (nuevos.get(p))),
    faces: c.faces.map((x) => ({ poly: x.poly.map((v) => apply(f, v)), plane: /** @type {Plane} */ (nuevos.get(x.plane)) })),
    vertices: c.vertices.map((v) => apply(f, v)),
    scale: c.scale,
  };
}

/** El mismo convexo, `t` más grande hacia cada lado (cada plano corrido hacia afuera). @param {Convex} c @param {number} t */
export const inflate = (c, t) => fromPlanes(c.planes.map((p) => ({ ...p, d: p.d + t })), c.scale);

/**
 * El prisma de un polígono convexo (antihorario, en el plano de `axis`) entre `desde` y `hasta`.
 * `tags[i]`: la superficie lisa a la que pertenece el lado i (o null).
 * @param {readonly [number, number][]} poly @param {0 | 1 | 2} axis @param {number} desde @param {number} hasta
 * @param {readonly (string | null)[]} tags @param {number} scale @param {string | null} [tapas]
 */
export function prismConvex(poly, axis, desde, hasta, tags, scale, tapas = null) {
  const [u, v] = [0, 1, 2].filter((k) => k !== axis);
  /** @param {number} a @param {number} b @param {number} w @returns {Vec3} */
  const en3 = (a, b, w) => { const p = /** @type {Vec3} */ ([0, 0, 0]); p[u] = a; p[v] = b; p[axis] = w; return p; };
  /** @type {Plane[]} */
  const planes = [{ n: en3(0, 0, 1), d: hasta, tag: tapas }, { n: en3(0, 0, -1), d: -desde, tag: tapas }];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const m = Math.hypot(q[1] - p[1], q[0] - p[0]);
    if (m < 1e-12 * scale) continue;
    const n = en3((q[1] - p[1]) / m, -(q[0] - p[0]) / m, 0);
    planes.push({ n, d: dot(n, en3(p[0], p[1], 0)), tag: tags[i] ?? null });
  }
  return fromPlanes(planes, scale);
}

/**
 * El tronco entre dos anillos paralelos (el mismo polígono convexo, escalado alrededor del eje):
 * un tramo de un torneado. Un anillo puede ser un punto (radio 0: una punta).
 * @param {readonly [number, number][]} ringA @param {number} yA @param {readonly [number, number][]} ringB @param {number} yB
 * @param {0 | 1 | 2} axis @param {string | null} tag la superficie lisa de los costados @param {string | null} tagTapas @param {number} scale
 */
export function frustumConvex(ringA, yA, ringB, yB, axis, tag, tagTapas, scale) {
  const [u, v] = [0, 1, 2].filter((k) => k !== axis);
  /** @param {[number, number]} p @param {number} w @returns {Vec3} */
  const en3 = (p, w) => { const r = /** @type {Vec3} */ ([0, 0, 0]); r[u] = p[0]; r[v] = p[1]; r[axis] = w; return r; };
  const [lo, hi] = yA < yB ? [yA, yB] : [yB, yA];
  const e = en3([0, 0], 1);
  /** @type {Plane[]} */
  const planes = [{ n: e, d: hi, tag: tagTapas }, { n: mul(e, -1), d: -lo, tag: tagTapas }];
  const n = Math.max(ringA.length, ringB.length);
  const eje = en3([0, 0], (lo + hi) / 2);
  for (let i = 0; i < n; i++) {
    const a0 = en3(ringA[i % ringA.length], yA), a1 = en3(ringA[(i + 1) % ringA.length], yA);
    const b0 = en3(ringB[i % ringB.length], yB), b1 = en3(ringB[(i + 1) % ringB.length], yB);
    const t = len(sub(a1, a0)) > len(sub(b1, b0)) ? [a0, a1, b0] : [b0, b1, a0];
    let nn = cross(sub(t[1], t[0]), sub(t[2], t[0]));
    if (len(nn) < 1e-15 * scale * scale) continue;
    nn = unit(nn);
    if (dot(nn, sub(t[0], eje)) < 0) nn = mul(nn, -1);
    planes.push({ n: nn, d: dot(nn, t[0]), tag });
  }
  return fromPlanes(planes, scale);
}

// ---------- contacto y penetración entre dos convexos ----------

/** @param {Convex} c @returns {Vec3[]} las direcciones de sus aristas, sin repetir */
function direcciones(c) {
  /** @type {Vec3[]} */
  const out = [];
  for (const f of c.faces) {
    for (let i = 0; i < f.poly.length; i++) {
      const d = sub(f.poly[(i + 1) % f.poly.length], f.poly[i]);
      const m = len(d);
      if (m < 1e-12 * c.scale) continue;
      const u = mul(d, 1 / m);
      if (!out.some((w) => Math.abs(dot(w, u)) > 1 - 1e-9)) out.push(u);
    }
  }
  return out;
}

/**
 * Cuánto se meten uno en otro, en el eje en que menos se meten (ejes separadores: las normales
 * de las caras y los productos de las aristas). Negativo: están separados por al menos eso.
 * @param {Convex} a @param {Convex} b
 */
export function depth(a, b) {
  /** @type {Vec3[]} */
  const ejes = [];
  const agrega = (/** @type {Vec3} */ L) => { if (!ejes.some((w) => Math.abs(dot(w, L)) > 1 - 1e-9)) ejes.push(L); };
  for (const p of [...a.planes, ...b.planes]) agrega(p.n);
  for (const x of direcciones(a)) for (const y of direcciones(b)) {
    const c = cross(x, y);
    const m = len(c);
    if (m > 1e-6) agrega(mul(c, 1 / m));
  }
  let min = Infinity;
  for (const L of ejes) {
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const v of a.vertices) { const s = dot(v, L); a0 = Math.min(a0, s); a1 = Math.max(a1, s); }
    for (const v of b.vertices) { const s = dot(v, L); b0 = Math.min(b0, s); b1 = Math.max(b1, s); }
    min = Math.min(min, Math.min(a1 - b0, b1 - a0));
    if (min < -1e3 * a.scale) break;
  }
  return min;
}

/**
 * La línea del medio de una zona flaca (una franja, una astilla): el segmento sobre su
 * dirección principal, por su centro, de punta a punta. Es el contacto de una arista que apoya,
 * o de una superficie lisa (un cilindro acostado).
 * @param {readonly Vec3[]} pts @returns {[Vec3, Vec3]}
 */
function lineaDelMedio(pts) {
  const c = centroid(pts);
  // la dirección en que más se estiran los puntos (la del autovalor mayor de su covarianza)
  const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of pts) {
    const d = sub(p, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[3 * i + j] += d[i] * d[j];
  }
  let ext = [pts[0], pts[0]], dmax = 0;
  for (const p of pts) for (const q of pts) { const d = len(sub(p, q)); if (d > dmax) { dmax = d; ext = [p, q]; } }
  if (dmax === 0) return [pts[0], pts[0]];
  let dir = mul(sub(ext[1], ext[0]), 1 / dmax);
  for (let k = 0; k < 64; k++) {
    const n = /** @type {Vec3} */ ([0, 1, 2].map((i) => M[3 * i] * dir[0] + M[3 * i + 1] * dir[1] + M[3 * i + 2] * dir[2]));
    const m = len(n);
    if (m < 1e-300) break;
    dir = mul(n, 1 / m);
  }
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) { const s = dot(sub(p, c), dir); lo = Math.min(lo, s); hi = Math.max(hi, s); }
  return [add(c, mul(dir, lo)), add(c, mul(dir, hi))];
}

/**
 * Dónde se tocan dos convexos que no se meten uno en otro: caras enfrentadas en el mismo plano
 * (el polígono donde se solapan), o una arista o un punto. Una "cara" contra una superficie
 * lisa es la línea donde apoya.
 * @param {Convex} a @param {Convex} b @param {number} tol
 * @returns {{ kind: 'face' | 'edge' | 'point', points: Vec3[], area: number, normal: Vec3, planeA: Plane | null, planeB: Plane | null }[]}
 */
export function contacts(a, b, tol) {
  /** @type {ReturnType<typeof contacts>} */
  const out = [];
  const eps = 1e-9 * Math.max(a.scale, b.scale);
  const sliver = Math.max(1e-12, (tol / 200) ** 2);
  for (const fa of a.faces) {
    for (const fb of b.faces) {
      if (dot(fa.plane.n, fb.plane.n) > -1 + 1e-9) continue;
      const gap = -fb.plane.d - fa.plane.d;
      if (Math.abs(gap) > tol) continue;
      let poly = fa.poly;
      const nb = fb.plane.n;
      for (let k = 0; k < fb.poly.length && poly.length >= 3; k++) {
        const q0 = fb.poly[k], q1 = fb.poly[(k + 1) % fb.poly.length];
        const m = cross(sub(q1, q0), nb);
        const ml = len(m);
        if (ml < eps) continue;
        const mu = mul(m, 1 / ml);
        poly = clip(poly, mu, dot(mu, q0), eps);
      }
      if (poly.length < 3) continue;
      const ar = polyArea(poly);
      if (ar < sliver) continue;
      const medio = mul(fa.plane.n, gap / 2);
      const pts = poly.map((q) => add(q, medio));
      if (fa.plane.tag || fb.plane.tag) out.push({ kind: 'edge', points: lineaDelMedio(pts), area: 0, normal: fa.plane.n, planeA: fa.plane, planeB: fb.plane });
      else out.push({ kind: 'face', points: pts, area: ar, normal: fa.plane.n, planeA: fa.plane, planeB: fb.plane });
    }
  }
  if (out.length) return out;
  // sin caras: una arista o un punto. Lo que queda de cada uno adentro del otro agrandado, y de
  // eso el tramo que comparten (así no importa cuál de los dos se agranda)
  const ga = inflate(a, tol), gb = inflate(b, tol);
  const r1 = gb && intersect(a, gb), r2 = ga && intersect(b, ga);
  if (!r1 || !r2) return out;
  const todos = [...r1.vertices, ...r2.vertices];
  const [p0, p1] = lineaDelMedio(todos);
  const largo = len(sub(p1, p0));
  const dir = largo > eps ? mul(sub(p1, p0), 1 / largo) : /** @type {Vec3} */ ([1, 0, 0]);
  const tramo = (/** @type {Vec3[]} */ vs) => { let lo = Infinity, hi = -Infinity; for (const v of vs) { const t = dot(sub(v, p0), dir); lo = Math.min(lo, t); hi = Math.max(hi, t); } return [lo, hi]; };
  const [lo1, hi1] = tramo(r1.vertices), [lo2, hi2] = tramo(r2.vertices);
  const lo = Math.max(lo1, lo2), hi = Math.max(lo, Math.min(hi1, hi2));
  const c = centroid(todos);
  const base = sub(c, mul(dir, dot(sub(c, p0), dir)));
  const linea = /** @type {[Vec3, Vec3]} */ ([add(base, mul(dir, lo)), add(base, mul(dir, hi))]);
  const ca = centroid(a.vertices), cb = centroid(b.vertices);
  const haciaB = sub(cb, ca);
  const n = len(haciaB) > eps ? mul(haciaB, 1 / len(haciaB)) : /** @type {Vec3} */ ([0, 1, 0]);
  if (hi - lo <= 6 * tol) out.push({ kind: 'point', points: [add(base, mul(dir, (lo + hi) / 2))], area: 0, normal: n, planeA: null, planeB: null });
  else out.push({ kind: 'edge', points: linea, area: 0, normal: n, planeA: null, planeB: null });
  return out;
}

/**
 * Las caras de un conjunto de convexos que no se solapan, sin las caras de adentro (las que dos
 * pedazos vecinos comparten). Cada pedazo de cara que queda es convexo.
 * @param {readonly Convex[]} partes @returns {{ poly: Vec3[], plane: Plane }[]}
 */
export function boundaryFaces(partes) {
  /** @type {{ poly: Vec3[], plane: Plane }[]} */
  const out = [];
  partes.forEach((p, i) => {
    const eps = 1e-9 * p.scale;
    for (const f of p.faces) {
      let pedazos = [f.poly];
      partes.forEach((q, j) => {
        if (i === j) return;
        for (const g of q.faces) {
          if (dot(g.plane.n, f.plane.n) > -1 + 1e-9 || Math.abs(g.plane.d + f.plane.d) > 1e3 * eps) continue;
          // lo de f que G tapa es de adentro: se resta, lado por lado de G
          const ng = g.plane.n;
          /** @type {Vec3[][]} */
          const quedan = [];
          for (const P of pedazos) {
            let resto = P;
            for (let k = 0; k < g.poly.length && resto.length >= 3; k++) {
              const q0 = g.poly[k], q1 = g.poly[(k + 1) % g.poly.length];
              const m = cross(sub(q1, q0), ng);
              const ml = len(m);
              if (ml < eps) continue;
              const mu = mul(m, 1 / ml), c = dot(mu, q0);
              const afuera = clip(resto, mul(mu, -1), -c, eps);
              if (afuera.length >= 3 && polyArea(afuera) > eps * p.scale) quedan.push(afuera);
              resto = clip(resto, mu, c, eps);
            }
          }
          pedazos = quedan;
          if (!pedazos.length) break;
        }
      });
      for (const poly of pedazos) out.push({ poly, plane: f.plane });
    }
  });
  return out;
}
