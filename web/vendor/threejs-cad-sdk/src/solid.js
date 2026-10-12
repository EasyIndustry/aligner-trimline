// La forma de una pieza: su bruto y, encima, sus operaciones.
//
// La pieza ES su bruto: una caja de sus medidas, o un perfil o un torneado que las llena (ver
// sections.js). Es lo que se compra y se corta, lo que da `dims`, la caja y el despiece. Encima
// lleva una lista ordenada de operaciones, que son datos puros y se guardan con el documento.
// La forma que resulta es un CÁLCULO: no se guarda, se deriva cuando se pide y se cachea
// mientras la definición no cambie.
//
// Las operaciones sobreviven a estirar la pieza porque sus posiciones van normalizadas (de 0 a
// 1 sobre el bruto); lo que no se estira (el diámetro de un agujero) va en la unidad del
// documento.
//
//   { kind: 'cut', axis, outline }   la pieza se queda con lo que cae adentro del contorno,
//                                    que la atraviesa a lo largo de `axis` (0, 1, 2 = x, y, z
//                                    locales). `outline`: puntos [u, v] de 0 a 1 sobre los
//                                    otros dos ejes, en orden (axis 0 → y, z; 1 → x, z; 2 → x, y).
//   { kind: 'hole', axis, side, at, diameter, depth? }
//                                    un agujero que entra por la cara `side` (1 o -1) de `axis`,
//                                    en `at` = [u, v] de 0 a 1 sobre esa cara; sin `depth`, pasante.
//   { kind: 'trim', against, mode? } la pieza pierde el volumen de la pieza `against` donde se
//                                    cruzan: el de su caja (mode 'box', por defecto) o el de su
//                                    forma (mode 'shape', sin sus propios recortes, para que dos
//                                    piezas que se recortan una a otra no den vueltas). Depende de
//                                    dónde está la otra RESPECTO de esta: mover el ensamble que
//                                    contiene a las dos no lo cambia.
//
// Dos maneras de calcular:
//   - la MALLA (lo que se dibuja): sin operaciones, la del bruto; con un solo corte en una caja,
//     la extrusión del contorno. Para combinar sólidos en 3D se usa el kernel que inyecte la app
//     (`createWorkshop({ kernel: { intersect, subtract } })`, three-bvh-csg, manifold…) y, si no
//     hay, la del SDK: la forma partida en convexos (convex.js), sin las caras de adentro.
//   - los CONVEXOS (para el contacto exacto): la forma como unión de pedazos convexos que no se
//     solapan. Es exacta para cualquier combinación de operaciones y no necesita kernel.
//
// Puro: no importa three ni DOM.
import { Mesh, Transform } from './geometry.js';
import { triangulate, convexPartition, signedArea } from './polygon.js';
import { prismConvex, frustumConvex, intersect, subtract, boundaryFaces, transformConvex } from './convex.js';
import { resolveSection, cerrarTorneado, ellipse, CIRCLE_SIDES } from './sections.js';

/** @typedef {import('./frame.js').Vec3} Vec3 */
/** @typedef {[number, number]} Vec2 */
/** @typedef {import('./convex.js').Convex} Convex */
/** @typedef {import('./sections.js').Loop} Loop */
/** @typedef {import('./sections.js').SectionFn} SectionFn */
/** @typedef {import('./sections.js').Shape} Shape */
/** @typedef {import('./sections.js').LatheShape} LatheShape */
/** @typedef {{ kind: 'cut', axis: 0 | 1 | 2, outline: Vec2[] }} CutOperation */
/** @typedef {{ kind: 'hole', axis: 0 | 1 | 2, side: 1 | -1, at: Vec2, diameter: number, depth?: number }} HoleOperation */
/** @typedef {{ kind: 'trim', against: string, mode: 'box' | 'shape' }} TrimOperation */
/** @typedef {CutOperation | HoleOperation | TrimOperation} OperationSpec */
/**
 * Para un recorte: la definición de la otra pieza y el marco que lleva de su espacio al de esta
 * (o null si la otra ya no existe).
 * @typedef {(op: TrimOperation) => { def: Definition, rel: import('./frame.js').Frame } | null} Recortes
 */
/** Una operación guardada: la de arriba, con su id dentro de la pieza. @typedef {OperationSpec & { id: string }} Operation */
/**
 * Lo que combina sólidos en 3D. Recibe y devuelve mallas en el marco local de la pieza; puede
 * devolver una `Mesh` o cualquier `{ positions, indices }`.
 * @typedef {{ intersect: (a: Mesh, b: Mesh) => { positions: ArrayLike<number>, indices: ArrayLike<number> },
 *             subtract: (a: Mesh, b: Mesh) => { positions: ArrayLike<number>, indices: ArrayLike<number> } }} Kernel
 */
/** Lo que define la forma de una pieza. @typedef {{ id: string, size: Vec3, shape: Shape | null, operations?: readonly Operation[] }} Definition */
/** @typedef {{ outer: Vec3[], holes: Vec3[][], surface: string, smooth: boolean }} CaraPlana */

/** Las operaciones que el SDK sabe hacer. */
export const OPERATION_KINDS = Object.freeze(['cut', 'hole', 'trim']);

/** Cuánto (en proporción del largo de la pieza) sobresale una herramienta, para que no haya caras coplanares. */
const SOBRANTE = 0.01;

/** Los otros dos ejes, en orden: el plano del contorno. @param {0 | 1 | 2} axis @returns {[0 | 1 | 2, 0 | 1 | 2]} */
const plano = (axis) => /** @type {[0 | 1 | 2, 0 | 1 | 2]} */ ([0, 1, 2].filter((k) => k !== axis));

// ---------- validar ----------

/** @param {unknown} n @param {string} que */
const num = (n, que) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new TypeError(`${que} inválido: ${String(n)} (va un número)`);
  return n;
};
/** @param {unknown} a */
const eje = (a) => {
  if (a !== 0 && a !== 1 && a !== 2) throw new TypeError(`eje inválido: ${String(a)} (va 0, 1 o 2: x, y o z de la pieza)`);
  return /** @type {0 | 1 | 2} */ (a);
};
/** @param {unknown} p @param {string} que @returns {Vec2} */
const punto01 = (p, que) => {
  if (!Array.isArray(p) || p.length !== 2) throw new TypeError(`${que} inválido: ${JSON.stringify(p)} (va [u, v])`);
  const [u, v] = [num(p[0], que), num(p[1], que)];
  if (u < 0 || u > 1 || v < 0 || v > 1) throw new RangeError(`${que} inválido: ${JSON.stringify(p)} (va normalizado: de 0 a 1 sobre el bruto)`);
  return [u, v];
};

/** ¿Se cortan los segmentos ab y cd (sin contar las puntas que comparten)? @param {Vec2} a @param {Vec2} b @param {Vec2} c @param {Vec2} d */
function secantes(a, b, c, d) {
  /** @param {Vec2} p @param {Vec2} q @param {Vec2} r */
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/**
 * Revisa una operación y la devuelve limpia (solo sus campos). Falla con un mensaje que dice
 * qué está mal.
 * @param {unknown} op @returns {OperationSpec}
 */
export function checkOperation(op) {
  if (!op || typeof op !== 'object') throw new TypeError(`operación inválida: va un objeto con kind (${OPERATION_KINDS.join(', ')})`);
  const o = /** @type {Record<string, unknown>} */ (op);
  if (o.kind === 'cut') {
    const axis = eje(o.axis);
    if (!Array.isArray(o.outline) || o.outline.length < 3) throw new TypeError('contorno inválido: van al menos 3 puntos [u, v]');
    const outline = o.outline.map((p, i) => punto01(p, `punto ${i} del contorno`));
    if (Math.abs(signedArea(outline)) < 1e-9) throw new RangeError('contorno inválido: no encierra área');
    const n = outline.length;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (secantes(outline[i], outline[(i + 1) % n], outline[j], outline[(j + 1) % n])) throw new RangeError('contorno inválido: se cruza consigo mismo');
    }
    return { kind: 'cut', axis, outline };
  }
  if (o.kind === 'hole') {
    const axis = eje(o.axis);
    if (o.side !== 1 && o.side !== -1) throw new TypeError(`lado inválido: ${String(o.side)} (va 1 o -1: la cara por donde entra)`);
    const at = punto01(o.at, 'at');
    const diameter = num(o.diameter, 'diámetro');
    if (diameter <= 0) throw new RangeError(`diámetro inválido: ${diameter} (va mayor que 0)`);
    /** @type {HoleOperation} */
    const out = { kind: 'hole', axis, side: o.side, at, diameter };
    if (o.depth !== undefined) {
      const depth = num(o.depth, 'profundidad');
      if (depth <= 0) throw new RangeError(`profundidad inválida: ${depth} (va mayor que 0; sin depth, el agujero es pasante)`);
      out.depth = depth;
    }
    return out;
  }
  if (o.kind === 'trim') {
    if (typeof o.against !== 'string' || !o.against) throw new TypeError('recorte inválido: va against, el id de la otra pieza');
    const mode = o.mode ?? 'box';
    if (mode !== 'box' && mode !== 'shape') throw new TypeError(`recorte inválido: mode ${String(mode)} (va 'box' o 'shape')`);
    return { kind: 'trim', against: o.against, mode };
  }
  throw new TypeError(`operación desconocida: ${String(o.kind)} (van ${OPERATION_KINDS.join(', ')})`);
}

/** @param {unknown} k @returns {Kernel} */
export function checkKernel(k) {
  const o = /** @type {Record<string, unknown>} */ (k);
  if (!o || typeof o.intersect !== 'function' || typeof o.subtract !== 'function') {
    throw new TypeError('kernel inválido: va un objeto con intersect(a, b) y subtract(a, b), que reciben y devuelven mallas');
  }
  return /** @type {Kernel} */ (k);
}

// ---------- mallas ----------

/** La normal de un polígono plano (Newell). @param {readonly Vec3[]} poly @returns {Vec3} */
function normalDe(poly) {
  const n = /** @type {Vec3} */ ([0, 0, 0]);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const m = Math.hypot(...n) || 1;
  return [n[0] / m, n[1] / m, n[2] / m];
}

/**
 * Arma una malla con caras planas (polígonos, con agujeros), cada una de una superficie.
 * @param {readonly CaraPlana[]} caras
 */
function mallaDeCaras(caras) {
  /** @type {number[]} */ const pos = [];
  /** @type {number[]} */ const ix = [];
  /** @type {number[]} */ const sf = [];
  /** @type {boolean[]} */ const lisa = [];
  /** @type {Map<string, number>} */ const ids = new Map();
  for (const c of caras) {
    let s = ids.get(c.surface);
    if (s === undefined) { s = ids.size; ids.set(c.surface, s); lisa.push(c.smooth); }
    // se proyecta sobre el plano de coordenadas más parecido, conservando el sentido
    const n = normalDe(c.outer);
    const k = /** @type {0 | 1 | 2} */ ([0, 1, 2].reduce((m, i) => (Math.abs(n[i]) > Math.abs(n[m]) ? i : m), 0));
    const [u, v] = plano(k);
    const izquierdo = k === 1; // (x, z, y) es un sistema izquierdo
    const flip = (n[k] < 0) !== izquierdo;
    /** @param {Vec3} p @returns {Vec2} */
    const a2 = (p) => (flip ? [p[v], p[u]] : [p[u], p[v]]);
    const todos = [c.outer, ...c.holes];
    const base = pos.length / 3;
    for (const l of todos) for (const p of l) pos.push(...p);
    // triangulate reordena: se le pasan los lazos y se traducen sus índices a los nuestros
    const t = triangulate(c.outer.map(a2), c.holes.map((h) => h.map(a2)));
    /** @type {number[]} */
    const mapa = [];
    let off = 0;
    t.loops.forEach((lz, li) => {
      const orig = todos[li];
      const invertido = li === 0 ? signedArea(c.outer.map(a2)) < 0 : signedArea(orig.map(a2)) > 0;
      lz.forEach((idx, j) => { mapa[idx] = base + off + (invertido ? orig.length - 1 - j : j); });
      off += orig.length;
    });
    for (const [a, b, cc] of t.triangles) { ix.push(mapa[a], mapa[b], mapa[cc]); sf.push(s); }
  }
  const m = new Mesh({ positions: pos, indices: ix, surfaces: sf, smooth: lisa });
  return m.volume >= 0 ? m : darVuelta(m);
}

/** La misma malla con los triángulos al revés. @param {Mesh} m */
function darVuelta(m) {
  /** @type {number[]} */
  const ix = [];
  for (let k = 0; k < m.indices.length; k += 3) ix.push(m.indices[k], m.indices[k + 2], m.indices[k + 1]);
  return new Mesh({ positions: m.positions, indices: ix, surfaces: m.surfaces ?? undefined, smooth: m.smooth ?? undefined });
}

/** @param {0 | 1 | 2} axis @returns {(q: Vec2, w: number) => Vec3} */
const en3De = (axis) => {
  const [u, v] = plano(axis);
  return (q, w) => {
    const p = /** @type {Vec3} */ ([0, 0, 0]);
    p[u] = q[0];
    p[v] = q[1];
    p[axis] = w;
    return p;
  };
};

/**
 * El prisma de una sección (contorno y agujeros, en el plano de `axis`) entre `desde` y
 * `hasta` a lo largo de `axis`. Las tapas son caras planas; cada lado de un contorno, una cara
 * plana, salvo los de un contorno liso, que son una sola superficie curva.
 * @param {{ outer: Loop, holes?: Loop[] }} seccion @param {0 | 1 | 2} axis @param {number} desde @param {number} hasta
 * @param {string} [nombre] para nombrar las superficies
 */
export function prism(seccion, axis, desde, hasta, nombre = 'p') {
  const en3 = en3De(axis);
  const loops = [seccion.outer, ...(seccion.holes ?? [])];
  const o = signedArea(seccion.outer.points) >= 0 ? seccion.outer.points : [...seccion.outer.points].reverse();
  const hs = (seccion.holes ?? []).map((h) => (signedArea(h.points) <= 0 ? h.points : [...h.points].reverse()));
  // con (u, v, axis) izquierdo, "antihorario en el plano" mira hacia -axis: las tapas se dan vuelta
  const izq = axis === 1;
  const arriba = (/** @type {Vec2[]} */ l) => (izq ? [...l].reverse() : l);
  const abajo = (/** @type {Vec2[]} */ l) => (izq ? l : [...l].reverse());
  /** @type {CaraPlana[]} */
  const caras = [
    { outer: arriba(o).map((q) => en3(q, hasta)), holes: hs.map((h) => arriba(h).map((q) => en3(q, hasta))), surface: `${nombre}:tapa+`, smooth: false },
    { outer: abajo(o).map((q) => en3(q, desde)), holes: hs.map((h) => abajo(h).map((q) => en3(q, desde))), surface: `${nombre}:tapa-`, smooth: false },
  ];
  [o, ...hs].forEach((pts, li) => {
    const liso = !!loops[li].smooth;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const quad = [en3(p, desde), en3(q, desde), en3(q, hasta), en3(p, hasta)];
      caras.push({ outer: izq ? quad.reverse() : quad, holes: [], surface: liso ? `${nombre}:lazo${li}` : `${nombre}:lazo${li}:${i}`, smooth: liso });
    }
  });
  return mallaDeCaras(caras);
}

/** La caja de unas medidas, centrada en el origen. @param {Vec3} size */
export function boxMesh(size) {
  const [hx, hy] = [size[0] / 2, size[1] / 2];
  return prism({ outer: { points: [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]] } }, 2, -size[2] / 2, size[2] / 2, 'caja');
}

/** Los anillos de un torneado: un polígono por punto del contorno (cerrado por el eje). @param {Definition & { shape: LatheShape }} def */
function anillosTorneado(def) {
  const { axis, contour } = def.shape;
  const [u, v] = plano(axis);
  const L = def.size[axis];
  return cerrarTorneado(contour).map(([r, y]) => ({ r, y: (y - 0.5) * L, ring: ellipse((r * def.size[u]) / 2, (r * def.size[v]) / 2) }));
}

/**
 * La malla de un torneado: cada tramo del contorno es una banda curva (o un disco o un anillo
 * plano, si el tramo es horizontal). El contorno, cerrado por el eje, dice de qué lado está el
 * sólido: la normal de afuera de cada tramo, en (r, y), da hacia dónde mira su cara.
 * @param {Definition & { shape: LatheShape }} def
 */
function latheMesh(def) {
  const axis = def.shape.axis;
  const en3 = en3De(axis);
  const A = anillosTorneado(def);
  const s = signedArea(A.map((a) => /** @type {Vec2} */ ([a.r, a.y]))) >= 0 ? 1 : -1;
  /** @type {CaraPlana[]} */
  const caras = [];
  /** @param {CaraPlana} c @param {number} nr @param {number} ny */
  const mirando = (c, nr, ny) => {
    const n = normalDe(c.outer);
    const cen = c.outer.reduce((m, p) => /** @type {Vec3} */ ([m[0] + p[0], m[1] + p[1], m[2] + p[2]]), /** @type {Vec3} */ ([0, 0, 0]));
    cen[axis] = 0;
    const lr = Math.hypot(...cen) || 1;
    const quiero = /** @type {Vec3} */ (cen.map((v) => (v / lr) * nr));
    quiero[axis] += ny;
    const ok = n[0] * quiero[0] + n[1] * quiero[1] + n[2] * quiero[2] >= 0;
    return ok ? c : { ...c, outer: [...c.outer].reverse(), holes: c.holes.map((h) => [...h].reverse()) };
  };
  for (let i = 0; i + 1 < A.length; i++) {
    const a = A[i], b = A[i + 1];
    if (a.r === 0 && b.r === 0) continue;
    const nr = s * (b.y - a.y), ny = -s * (b.r - a.r); // la normal de afuera del tramo, en (r, y)
    if (a.y === b.y) {
      const [chico, grande] = a.r < b.r ? [a, b] : [b, a];
      const hueco = chico.r > 0 ? [[...chico.ring].reverse().map((q) => en3(q, a.y))] : [];
      caras.push(mirando({ outer: grande.ring.map((q) => en3(q, a.y)), holes: hueco, surface: `torno:${i}`, smooth: false }, 0, ny));
      continue;
    }
    for (let k = 0; k < CIRCLE_SIDES; k++) {
      const k2 = (k + 1) % CIRCLE_SIDES;
      const quad = [en3(a.ring[k], a.y), en3(a.ring[k2], a.y), en3(b.ring[k2], b.y), en3(b.ring[k], b.y)];
      const unicos = quad.filter((p, j) => quad.findIndex((r) => r[0] === p[0] && r[1] === p[1] && r[2] === p[2]) === j);
      if (unicos.length >= 3) caras.push(mirando({ outer: unicos, holes: [], surface: `torno:${i}`, smooth: true }, nr, ny));
    }
  }
  return mallaDeCaras(caras);
}

/**
 * La malla del bruto: la caja, o el perfil o el torneado que la llenan.
 * @param {Definition} def @param {Readonly<Record<string, SectionFn>>} sections
 */
export function stockMesh(def, sections) {
  if (!def.shape) return boxMesh(def.size);
  if (def.shape.kind === 'profile') {
    const s = resolveSection(def.shape, def.size, sections);
    const h = def.size[def.shape.axis] / 2;
    return prism(s, def.shape.axis, -h, h, 'perfil');
  }
  return latheMesh(/** @type {Definition & { shape: LatheShape }} */ (def));
}

/** Un punto normalizado [u, v] llevado al plano de `axis` de una pieza de medidas `size`. @param {Vec2} p @param {0 | 1 | 2} axis @param {Vec3} size @returns {Vec2} */
const desnormalizar = (p, axis, size) => {
  const [u, v] = plano(axis);
  return [(p[0] - 0.5) * size[u], (p[1] - 0.5) * size[v]];
};

/**
 * El prisma de un corte, a lo largo de toda la pieza. `sobrante`: cuánto pasa de cada lado (0:
 * justo el largo de la pieza).
 * @param {Vec3} size @param {CutOperation} op @param {number} [sobrante]
 */
export function cutTool(size, op, sobrante = SOBRANTE * size[op.axis]) {
  const h = size[op.axis] / 2;
  return prism({ outer: { points: op.outline.map((p) => desnormalizar(p, op.axis, size)) } }, op.axis, -h - sobrante, h + sobrante, 'corte');
}

/** Dónde empieza y dónde termina el cilindro de un agujero, a lo largo de su eje. @param {Vec3} size @param {HoleOperation} op */
function tramoAgujero(size, op) {
  const h = size[op.axis] / 2, m = SOBRANTE * size[op.axis];
  const cara = op.side * h;
  const fondo = op.depth === undefined ? -op.side * (h + m) : cara - op.side * op.depth;
  const afuera = cara + op.side * m;
  return [Math.min(fondo, afuera), Math.max(fondo, afuera)];
}

/** El círculo de un agujero, en el plano de su cara. @param {Vec3} size @param {HoleOperation} op @returns {Vec2[]} */
function circuloAgujero(size, op) {
  const [cu, cv] = desnormalizar(op.at, op.axis, size);
  return ellipse(op.diameter / 2, op.diameter / 2).map(([x, y]) => /** @type {Vec2} */ ([cu + x, cv + y]));
}

/** El cilindro de un agujero: entra por su cara, hasta `depth` o de lado a lado. @param {Vec3} size @param {HoleOperation} op */
export function holeTool(size, op) {
  const [a, b] = tramoAgujero(size, op);
  return prism({ outer: { points: circuloAgujero(size, op), smooth: true } }, op.axis, a, b, 'agujero');
}

// ---------- la forma como unión de convexos ----------

/** La escala de una pieza: de ella salen las tolerancias de los convexos. @param {readonly number[]} size */
const escalaDe = (size) => 2 * Math.max(...size);

/**
 * Los pedazos convexos de una sección extruida. Los lados que son borde de un contorno liso
 * llevan el nombre de su superficie curva.
 * @param {{ outer: Loop, holes?: Loop[] }} seccion @param {0 | 1 | 2} axis @param {number} desde @param {number} hasta
 * @param {number} S @param {string} nombre @returns {Convex[]}
 */
function prismasConvexos(seccion, axis, desde, hasta, S, nombre) {
  const loops = [seccion.outer, ...(seccion.holes ?? [])];
  const { points, parts, loops: idx } = convexPartition(seccion.outer.points, (seccion.holes ?? []).map((h) => h.points));
  /** @type {Map<string, string>} */
  const lisos = new Map();
  idx.forEach((l, li) => {
    if (!loops[li].smooth) return;
    for (let i = 0; i < l.length; i++) {
      const a = l[i], b = l[(i + 1) % l.length];
      lisos.set(`${a}|${b}`, `${nombre}:lazo${li}`).set(`${b}|${a}`, `${nombre}:lazo${li}`);
    }
  });
  /** @type {Convex[]} */
  const out = [];
  for (const r of parts) {
    const c = prismConvex(r.map((i) => points[i]), axis, desde, hasta, r.map((a, i) => lisos.get(`${a}|${r[(i + 1) % r.length]}`) ?? null), S);
    if (c) out.push(c);
  }
  return out;
}

/**
 * La forma de una pieza (en su marco local) como unión de convexos que no se solapan: exacta
 * para cualquier combinación de operaciones, sin kernel.
 * @param {Definition} def @param {Readonly<Record<string, SectionFn>>} sections @param {Recortes} [recortes]
 * @returns {Convex[]}
 */
export function convexPartsOf(def, sections, recortes = () => null) {
  const S = escalaDe(def.size);
  /** @type {Convex[]} */
  let partes;
  if (!def.shape) {
    const [hx, hy] = [def.size[0] / 2, def.size[1] / 2];
    partes = prismasConvexos({ outer: { points: [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]] } }, 2, -def.size[2] / 2, def.size[2] / 2, S, 'caja');
  } else if (def.shape.kind === 'profile') {
    const h = def.size[def.shape.axis] / 2;
    partes = prismasConvexos(resolveSection(def.shape, def.size, sections), def.shape.axis, -h, h, S, 'perfil');
  } else {
    const A = anillosTorneado(/** @type {Definition & { shape: LatheShape }} */ (def));
    partes = [];
    for (let i = 0; i + 1 < A.length; i++) {
      const a = A[i], b = A[i + 1];
      if (a.y === b.y || (a.r === 0 && b.r === 0)) continue;
      const c = frustumConvex(a.ring, a.y, b.ring, b.y, def.shape.axis, `torno:${i}`, null, S);
      if (c) partes.push(c);
    }
  }
  for (const op of def.operations ?? []) {
    if (op.kind === 'cut') {
      const h = def.size[op.axis] / 2, m = SOBRANTE * def.size[op.axis];
      const herramientas = prismasConvexos({ outer: { points: op.outline.map((p) => desnormalizar(p, op.axis, def.size)) } }, op.axis, -h - m, h + m, S, `corte:${op.id}`);
      /** @type {Convex[]} */
      const nuevas = [];
      for (const p of partes) for (const t of herramientas) { const c = intersect(p, t); if (c) nuevas.push(c); }
      partes = nuevas;
    } else if (op.kind === 'hole') {
      const [a, b] = tramoAgujero(def.size, op);
      const circulo = circuloAgujero(def.size, op);
      const cil = prismConvex(circulo, op.axis, a, b, circulo.map(() => `agujero:${op.id}`), S);
      if (cil) partes = partes.flatMap((p) => subtract(p, cil));
    } else {
      const otra = recortes(op);
      if (!otra) continue;
      const cortadores = (op.mode === 'shape' ? convexPartsOf(sinRecortes(otra.def), sections) : convexPartsOf({ ...otra.def, shape: null, operations: [] }, sections))
        .map((k) => transformConvex(k, otra.rel));
      for (const k of cortadores) partes = partes.flatMap((p) => subtract(p, k));
    }
  }
  return partes;
}

/** La misma definición, sin sus recortes. @param {Definition} def @returns {Definition} */
const sinRecortes = (def) => ({ ...def, operations: (def.operations ?? []).filter((o) => o.kind !== 'trim') });

/**
 * La malla de una unión de convexos: sus caras de afuera, con sus superficies (las caras de un
 * mismo plano son una; las lisas, la suya).
 * @param {readonly Convex[]} partes
 */
export function meshOfConvexParts(partes) {
  return mallaDeCaras(boundaryFaces(partes).map((f) => {
    const n = f.plane.n;
    const surface = f.plane.tag ?? `plano:${n.map((v) => Math.round(v * 1e6)).join(',')}:${Math.round(f.plane.d * 1e6)}`;
    return { outer: f.poly, holes: [], surface, smooth: !!f.plane.tag };
  }));
}

/**
 * La forma de una pieza, en su marco local: el bruto con sus operaciones.
 * @param {Definition} def
 * @param {{ kernel?: Kernel | null, sections: Readonly<Record<string, SectionFn>>, recortes?: Recortes }} opts
 * @returns {Mesh}
 */
export function solidOf(def, { kernel = null, sections, recortes = () => null }) {
  const ops = def.operations ?? [];
  if (!ops.length) return stockMesh(def, sections);
  if (!def.shape && ops.length === 1 && ops[0].kind === 'cut') return cutTool(def.size, ops[0], 0); // una caja con un solo corte: la extrusión del contorno
  if (kernel) {
    let s = stockMesh(def, sections);
    for (const op of ops) {
      if (op.kind === 'cut') s = Mesh.from(kernel.intersect(s, cutTool(def.size, op)));
      else if (op.kind === 'hole') s = Mesh.from(kernel.subtract(s, holeTool(def.size, op)));
      else {
        const otra = recortes(op);
        if (!otra) continue;
        const cortador = op.mode === 'shape' ? solidOf(sinRecortes(otra.def), { kernel, sections }) : boxMesh(otra.def.size);
        s = Mesh.from(kernel.subtract(s, cortador.transform(new Transform(otra.rel))));
      }
    }
    return s;
  }
  return meshOfConvexParts(convexPartsOf(def, sections, recortes));
}
