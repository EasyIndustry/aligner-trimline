// Los rasgos de una forma: sus vértices, aristas y caras de verdad, sacados de su malla.
//
// Una malla son triángulos; una forma tiene caras (planas o curvas), aristas (donde se juntan
// dos caras) y vértices (donde se juntan tres o más). Eso sale de las superficies de la malla
// (`mesh.surfaces`): una arista es el borde entre dos superficies distintas, y es CURVA si
// alguna de las dos aproxima una curva (un cilindro): sus tramos no se ofrecen como aristas. Si
// la malla no trae superficies (la de un kernel), se deducen: los triángulos en un mismo plano
// son una cara, y las caras vecinas casi paralelas son una superficie curva.
//
// Puro: no importa three ni DOM.

/** @typedef {import('./frame.js').Vec3} Vec3 */
/** @typedef {import('./geometry.js').Mesh} Mesh */
/** @typedef {{ vertices: Vec3[], edges: [Vec3, Vec3][], faces: { outer: Vec3[], holes: Vec3[][], normal: Vec3 }[] }} Features */

/** @param {Vec3} a @param {Vec3} b @returns {Vec3} */ const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** @param {Vec3} a @param {Vec3} b */ const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** @param {Vec3} a @param {Vec3} b @returns {Vec3} */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** @param {Vec3} a */ const len = (a) => Math.hypot(a[0], a[1], a[2]);

/** Cuánto pueden diferir dos caras vecinas para ser la misma superficie curva (en grados). */
const CURVA = 20;

/**
 * @param {Mesh} mesh @returns {Features}
 */
export function featuresOf(mesh) {
  const P = mesh.positions;
  let escala = 0;
  for (const v of P) escala = Math.max(escala, Math.abs(v));
  escala = escala || 1;
  const q = 1e-7 * escala;

  // ---------- soldar: un vértice por punto ----------
  /** @type {Vec3[]} */ const W = [];
  /** @type {Map<string, number>} */ const porClave = new Map();
  /** @param {number} i */
  const soldado = (i) => {
    const p = /** @type {Vec3} */ ([P[3 * i], P[3 * i + 1], P[3 * i + 2]]);
    const k = p.map((v) => Math.round(v / q)).join(',');
    let w = porClave.get(k);
    if (w === undefined) { w = W.length; W.push(p); porClave.set(k, w); }
    return w;
  };
  /** @type {{ v: [number, number, number], n: Vec3, s: number }[]} */
  const tris = [];
  for (let t = 0; t < mesh.indices.length / 3; t++) {
    const v = /** @type {[number, number, number]} */ ([soldado(mesh.indices[3 * t]), soldado(mesh.indices[3 * t + 1]), soldado(mesh.indices[3 * t + 2])]);
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
    const n = cross(sub(W[v[1]], W[v[0]]), sub(W[v[2]], W[v[0]]));
    const m = len(n);
    if (m < 1e-12 * escala * escala) continue;
    tris.push({ v, n: [n[0] / m, n[1] / m, n[2] / m], s: mesh.surfaces ? mesh.surfaces[t] : -1 });
  }

  // ---------- superficies ----------
  /** @type {boolean[]} */
  let lisa = mesh.smooth ? [...mesh.smooth] : [];
  if (!mesh.surfaces) lisa = deducirSuperficies(tris, W, escala);

  // ---------- aristas: los lados de los triángulos, partidos en los vértices que caen encima ----------
  /** @type {Map<string, { a: number, b: number, sup: Set<number>, usos: number }>} */
  const lados = new Map();
  /** @type {Map<number, [number, number][]>} los lados dirigidos de cada superficie */
  const dirigidos = new Map();
  const clave = (/** @type {number} */ a, /** @type {number} */ b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const cadena = partir(t.v[k], t.v[(k + 1) % 3], W, q);
      for (let j = 0; j + 1 < cadena.length; j++) {
        const [a, b] = [cadena[j], cadena[j + 1]];
        const c = clave(a, b);
        let l = lados.get(c);
        if (!l) { l = { a, b, sup: new Set(), usos: 0 }; lados.set(c, l); }
        l.sup.add(t.s);
        l.usos++;
        if (!dirigidos.has(t.s)) dirigidos.set(t.s, []);
        /** @type {[number, number][]} */ (dirigidos.get(t.s)).push([a, b]);
      }
    }
  }
  /** @type {{ a: number, b: number, sup: Set<number>, curva: boolean }[]} */
  const vivas = [];
  for (const l of lados.values()) {
    if (l.sup.size < 2 && l.usos > 1) continue; // adentro de una sola superficie
    vivas.push({ a: l.a, b: l.b, sup: l.sup, curva: [...l.sup].some((s) => lisa[s]) });
  }

  // ---------- vértices: donde se juntan tres superficies o más ----------
  /** @type {Map<number, Set<number>>} */
  const supEn = new Map();
  for (const e of vivas) for (const p of [e.a, e.b]) {
    if (!supEn.has(p)) supEn.set(p, new Set());
    for (const s of e.sup) /** @type {Set<number>} */ (supEn.get(p)).add(s);
  }
  const esVertice = new Set([...supEn].filter(([, s]) => s.size >= 3).map(([p]) => p));

  // ---------- aristas rectas, juntando los tramos alineados ----------
  let rectas = vivas.filter((e) => !e.curva).map((e) => ({ a: e.a, b: e.b, firma: [...e.sup].sort().join(',') }));
  for (let junto = true; junto;) {
    junto = false;
    /** @type {Map<number, number[]>} */
    const en = new Map();
    rectas.forEach((e, i) => { for (const p of [e.a, e.b]) { if (!en.has(p)) en.set(p, []); /** @type {number[]} */ (en.get(p)).push(i); } });
    for (const [p, ids] of en) {
      if (esVertice.has(p) || ids.length !== 2) continue;
      const [e1, e2] = [rectas[ids[0]], rectas[ids[1]]];
      if (e1.firma !== e2.firma) continue;
      const o1 = e1.a === p ? e1.b : e1.a, o2 = e2.a === p ? e2.b : e2.a;
      const d1 = sub(W[o1], W[p]), d2 = sub(W[o2], W[p]);
      if (dot(d1, d2) > -(1 - 1e-9) * len(d1) * len(d2)) continue; // no siguen derecho
      rectas = rectas.filter((_, i) => i !== ids[0] && i !== ids[1]);
      rectas.push({ a: o1, b: o2, firma: e1.firma });
      junto = true;
      break;
    }
  }

  // ---------- caras planas: los bordes de cada superficie plana, en lazos ----------
  /** @type {Features['faces']} */
  const faces = [];
  for (const [s, segs] of dirigidos) {
    if (lisa[s]) continue;
    const normal = tris.find((t) => t.s === s)?.n;
    if (!normal) continue;
    /** @type {Map<string, number>} */
    const cuenta = new Map();
    for (const [a, b] of segs) cuenta.set(`${a}>${b}`, (cuenta.get(`${a}>${b}`) ?? 0) + 1);
    const borde = segs.filter(([a, b]) => !cuenta.has(`${b}>${a}`));
    const lazos = encadenar(borde).map((l) => simplificar(l.map((i) => W[i])));
    const conArea = lazos.filter((l) => l.length >= 3).map((l) => ({ l, a: dot(areaVec(l), normal) }));
    const afuera = conArea.filter((x) => x.a > 0);
    const huecos = conArea.filter((x) => x.a < 0);
    for (const o of afuera) {
      const mios = huecos.filter((h) => dentro(h.l[0], o.l, normal));
      faces.push({ outer: o.l, holes: mios.map((h) => h.l), normal });
    }
  }
  return {
    vertices: [...esVertice].map((i) => W[i]),
    edges: rectas.map((e) => /** @type {[Vec3, Vec3]} */ ([W[e.a], W[e.b]])),
    faces,
  };
}

/**
 * Sin superficies dadas: los triángulos de un mismo plano son una superficie; superficies
 * vecinas casi paralelas (menos de CURVA grados) son una sola, curva. Reescribe `t.s`.
 * @param {{ v: [number, number, number], n: Vec3, s: number }[]} tris @param {Vec3[]} W @param {number} escala @returns {boolean[]}
 */
function deducirSuperficies(tris, W, escala) {
  /** @type {Map<string, number>} */
  const planos = new Map();
  for (const t of tris) {
    const d = dot(t.n, W[t.v[0]]);
    const k = [...t.n.map((v) => Math.round(v * 1e6)), Math.round(d / (1e-6 * escala))].join(',');
    let s = planos.get(k);
    if (s === undefined) { s = planos.size; planos.set(k, s); }
    t.s = s;
  }
  const padre = Array.from({ length: planos.size }, (_, i) => i);
  const raiz = (/** @type {number} */ i) => { while (padre[i] !== i) i = padre[i] = padre[padre[i]]; return i; };
  /** @type {Map<number, Vec3>} */
  const normalDe = new Map(tris.map((t) => [t.s, t.n]));
  /** @type {Map<string, number[]>} */
  const porLado = new Map();
  for (const t of tris) for (let k = 0; k < 3; k++) {
    const a = t.v[k], b = t.v[(k + 1) % 3];
    const c = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!porLado.has(c)) porLado.set(c, []);
    /** @type {number[]} */ (porLado.get(c)).push(t.s);
  }
  const cosMax = Math.cos((CURVA * Math.PI) / 180);
  /** @type {Set<number>} */
  const unidas = new Set();
  for (const ss of porLado.values()) {
    for (let i = 0; i < ss.length; i++) for (let j = i + 1; j < ss.length; j++) {
      const [x, y] = [ss[i], ss[j]];
      if (x === y) continue;
      if (dot(/** @type {Vec3} */ (normalDe.get(x)), /** @type {Vec3} */ (normalDe.get(y))) < cosMax) continue;
      padre[raiz(x)] = raiz(y);
      unidas.add(x).add(y);
    }
  }
  const lisa = Array.from({ length: planos.size }, () => false);
  for (const t of tris) {
    const r = raiz(t.s);
    if (unidas.has(t.s)) lisa[r] = true;
    t.s = r;
  }
  return lisa;
}

/** El lado a→b, partido en los vértices que caen encima (las uniones en T). @param {number} a @param {number} b @param {Vec3[]} W @param {number} q */
function partir(a, b, W, q) {
  const A = W[a], d = sub(W[b], A), L2 = dot(d, d);
  /** @type {[number, number][]} */
  const medio = [];
  for (let i = 0; i < W.length; i++) {
    if (i === a || i === b) continue;
    const t = dot(sub(W[i], A), d) / L2;
    if (t <= 1e-9 || t >= 1 - 1e-9) continue;
    const r = sub(W[i], [A[0] + d[0] * t, A[1] + d[1] * t, A[2] + d[2] * t]);
    if (len(r) < 10 * q) medio.push([t, i]);
  }
  return [a, ...medio.sort((x, y) => x[0] - y[0]).map(([, i]) => i), b];
}

/** Junta lados dirigidos en lazos cerrados. @param {[number, number][]} lados @returns {number[][]} */
function encadenar(lados) {
  /** @type {Map<number, number[]>} */
  const desde = new Map();
  for (const [a, b] of lados) { if (!desde.has(a)) desde.set(a, []); /** @type {number[]} */ (desde.get(a)).push(b); }
  /** @type {number[][]} */
  const lazos = [];
  for (const [inicio] of lados) {
    if (!desde.get(inicio)?.length) continue;
    const lazo = [inicio];
    let p = /** @type {number} */ (/** @type {number[]} */ (desde.get(inicio)).pop());
    let guarda = lados.length + 1;
    while (p !== inicio && guarda-- > 0) {
      lazo.push(p);
      const sig = desde.get(p);
      if (!sig?.length) break;
      p = /** @type {number} */ (sig.pop());
    }
    if (p === inicio) lazos.push(lazo);
  }
  return lazos;
}

/** Saca los puntos que no doblan (alineados con sus vecinos). @param {Vec3[]} l */
function simplificar(l) {
  let out = [...l];
  for (let cambio = true; cambio && out.length > 3;) {
    cambio = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i + out.length - 1) % out.length], b = out[i], c = out[(i + 1) % out.length];
      const d1 = sub(b, a), d2 = sub(c, b);
      if (len(cross(d1, d2)) <= 1e-9 * len(d1) * len(d2)) { out = out.filter((_, k) => k !== i); cambio = true; break; }
    }
  }
  return out;
}

/** @param {Vec3[]} poly @returns {Vec3} */
function areaVec(poly) {
  /** @type {Vec3} */
  let s = [0, 0, 0];
  for (let i = 0; i < poly.length; i++) { const c = cross(poly[i], poly[(i + 1) % poly.length]); s = [s[0] + c[0], s[1] + c[1], s[2] + c[2]]; }
  return s;
}

/** ¿El punto cae adentro del polígono plano de normal `n`? @param {Vec3} p @param {Vec3[]} poly @param {Vec3} n */
function dentro(p, poly, n) {
  const k = [0, 1, 2].reduce((m, i) => (Math.abs(n[i]) > Math.abs(n[m]) ? i : m), 0);
  const [u, v] = [0, 1, 2].filter((i) => i !== k);
  let adentro = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi, xj, yj] = [poly[i][u], poly[i][v], poly[j][u], poly[j][v]];
    if (yi > p[v] !== yj > p[v] && p[u] < ((xj - xi) * (p[v] - yi)) / (yj - yi) + xi) adentro = !adentro;
  }
  return adentro;
}
