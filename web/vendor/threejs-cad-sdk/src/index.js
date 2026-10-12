// SDK del taller: la API para el que desarrolla encima. La interfaz no toca el modelo:
// llama a esto.
//
//   const taller = createWorkshop();
//   const a = taller.addPiece({ name: 'Larguero', size: [200, 4, 10] });
//   a.rotate(45, 'z');
//   a.vertices[0].x;            // en el mundo
//   a.local.vertices;           // en el marco de la pieza
//   a.dims;                     // { length: 200, width: 10, thickness: 4 } — gire como gire
//   a.help();                   // todo lo que tiene una pieza
//
// Dos clases de cosas, como en Rhino:
//   - VALORES (Point3d, Vector3d, Line, BoundingBox, Face, Transform; ver geometry.js):
//     inmutables, sin identidad.
//   - PARTES del documento (Piece, Assembly): tienen id y viven en el modelo. Lo que se
//     consulta de ellas son valores, de solo lectura; se cambian por métodos explícitos.
//
// Una parte es lo que se transforma, se duplica y se mete en un ensamble (Composite): la
// pieza es una hoja, con todo lo fabricable; el ensamble es un conjunto de partes con una
// transformación propia, y su geometría es la de sus partes. Una instancia es la misma pieza
// o el mismo ensamble colocado otra vez: se ve y se consulta como lo que copia (`source` dice
// de quién es copia), y editar la fuente la cambia a ella también.
//
// Una feature nueva entra primero al modelo (model.js), con su prueba en Node, y recién
// después se expone acá — con su línea en la tabla de help(), que una prueba exige.
import { Model } from './model.js';
import { Point3d, Vector3d, Line, BoundingBox, Face, Transform, Contact, Intersection, Mesh, vec3 } from './geometry.js';
import { obbOf, satDepth, intersectBoxes, contactsOf, candidatePairs } from './contact.js';
import { arrayTransforms } from './array.js';
import { UNITS, convertLength } from './units.js';
import { TOLERANCE_PRESETS, GRAB_RATIO, tolerancesFor } from './config.js';
import { closestFeature, rayMesh, rayBox, FEATURE_KINDS } from './grab.js';
import { snapMove, pushOutMove, dropMove, guides } from './placement.js';
import { cutPlanes, stretchPlan } from './stretch.js';
import { RELATION_KINDS, JOINT_TYPES, jointMotion, clampTo, hingeCandidates, slideCandidates, anchorDelta, distribute, crossing } from './relations.js';
import { solidOf, convexPartsOf, checkKernel, OPERATION_KINDS } from './solid.js';
import { SECTIONS, checkShape, resolveSection } from './sections.js';
import { featuresOf } from './features.js';
import { transformConvex, depth as hondura, contacts as contactosConvexos, intersect as cruce, volume as volumen } from './convex.js';
import { apply, invert, compose, rotate as rotar, transpose3, frame as marcoDe } from './frame.js';
import { help } from './help.js';

export { Point3d, Vector3d, Line, BoundingBox, Face, Transform, Contact, Intersection, Mesh, OPERATION_KINDS, SECTIONS, arrayTransforms, UNITS, convertLength, TOLERANCE_PRESETS, GRAB_RATIO, tolerancesFor, RELATION_KINDS, JOINT_TYPES };

/** @typedef {import('./model.js').Space} Space */
/** @typedef {import('./geometry.js').PointLike} PointLike */
/** @typedef {import('./geometry.js').VectorLike} VectorLike */
/** @typedef {import('./geometry.js').AxisLike} AxisLike */
/** @typedef {import('./help.js').Member} Member */
/** @typedef {import('./array.js').ArraySpec} ArraySpec */
/** @typedef {import('./units.js').Unit} Unit */
/** @typedef {import('./config.js').Tolerances} Tolerances */
/** @typedef {import('./solid.js').Kernel} Kernel */
/** @typedef {import('./solid.js').OperationSpec} OperationSpec */
/** @typedef {import('./solid.js').Operation} Operation */
/** @typedef {import('./solid.js').Definition} Definition */
/** @typedef {import('./sections.js').SectionFn} SectionFn */
/** @typedef {import('./features.js').Features} Features */
/** @typedef {import('./convex.js').Convex} Convex */

/** @typedef {import('./model.js').RelationDef} RelationDef */
/** @typedef {{ model: Model, part: (id: string) => Part, relation: (id: string) => Relation, forget: (ids: string[]) => void, tolerances: () => Readonly<Tolerances>, checkSection: (shape: unknown, size?: [number, number, number]) => unknown,
 *             solid: (id: string) => Mesh, features: (id: string) => Features, convex: (id: string) => Convex[], sections: Readonly<Record<string, SectionFn>> }} Ctx */
/** El documento al que pertenece cada parte (o relación), sin colgárselo a la vista. @type {WeakMap<Part | Relation, Ctx>} */
const ctxOf = new WeakMap();
/** @param {Part | Relation} p */
const ctx = (p) => /** @type {Ctx} */ (ctxOf.get(p));
const AXES = /** @type {const} */ (['x', 'y', 'z']);

const AX_NAME = /** @type {const} */ (['x', 'y', 'z']);
/** Por qué queda roto un vínculo cuya pieza es fija. */
const AVISO_FIJA = 'la pieza es fija: el vínculo la movería';
/** @param {{ axis: 0 | 1 | 2, side: 1 | -1 } | null} f */
const caraLocal = (f) => (f ? { localAxis: AX_NAME[f.axis], localSide: f.side } : null);
/** @param {Model} m @param {string} id */
const piezasDe = (m, id) => m.piecesOf(id).map((p) => p.id);

/** Una pieza que es una caja lisa: sin forma de bruto y sin operaciones. @param {{ shape?: unknown, operations?: readonly unknown[] }} p */
const esCaja = (p) => !p.shape && !p.operations?.length;
/** ¿Tiene recortes? Entonces su contacto se mira con su forma real: el recorte existe para sacar el choque. @param {{ operations?: readonly { kind: string }[] }} p */
const recortada = (p) => !!p.operations?.some((o) => o.kind === 'trim');
/** ¿Exacto para este par? Lo pedido, o, si no se dijo, cuando alguna tiene recortes. @param {Model} m @param {string} x @param {string} y @param {boolean | undefined} exact */
const exactoPara = (m, x, y, exact) => {
  const [px, py] = [m.piece(x), m.piece(y)];
  if (esCaja(px) && esCaja(py)) return false;
  return exact ?? (recortada(px) || recortada(py));
};

/** Los pedazos convexos de una pieza, en el mundo. @param {Ctx} c @param {string} id */
const convexosEnElMundo = (c, id) => c.convex(id).map((k) => transformConvex(k, c.model.worldFrame(id)));

/** ¿Se cruzan las cajas de dos convexos, agrandadas por tol? @param {Convex} a @param {Convex} b @param {number} tol */
function cajasSeCruzan(a, b, tol) {
  for (let k = 0; k < 3; k++) {
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const v of a.vertices) { a0 = Math.min(a0, v[k]); a1 = Math.max(a1, v[k]); }
    for (const v of b.vertices) { b0 = Math.min(b0, v[k]); b1 = Math.max(b1, v[k]); }
    if (a0 > b1 + tol || b0 > a1 + tol) return false;
  }
  return true;
}

/**
 * La cara de la pieza (en su marco) que corresponde a un plano del mundo, si mira hacia uno de
 * sus ejes. @param {Model} m @param {string} id @param {{ n: [number, number, number] } | null} pl
 */
function caraDePlano(m, id, pl) {
  if (!pl) return null;
  const r = m.worldFrame(id).r;
  const n = [r[0] * pl.n[0] + r[3] * pl.n[1] + r[6] * pl.n[2], r[1] * pl.n[0] + r[4] * pl.n[1] + r[7] * pl.n[2], r[2] * pl.n[0] + r[5] * pl.n[1] + r[8] * pl.n[2]];
  const k = n.findIndex((v) => Math.abs(v) > 1 - 1e-9);
  return k < 0 ? null : { localAxis: AX_NAME[k], localSide: /** @type {1 | -1} */ (Math.sign(n[k])) };
}

/**
 * Los contactos entre las piezas de dos grupos (cada par una vez). Un par que se mete uno
 * en otro (más de `pen`) no cuenta como contacto: eso es una intersección. Con `exact`, cada
 * pieza que no es una caja lisa se toma con su forma real (sus convexos); si no se dice, se hace
 * para los pares donde alguna tiene recortes.
 * @param {Ctx} c @param {string[]} as @param {string[]} bs @param {number} tol @param {number} pen @param {boolean} [exact]
 */
function contactos(c, as, bs, tol, pen, exact) {
  const m = c.model;
  /** @type {Contact[]} */
  const out = [];
  for (const [x, y] of candidatePairs(m, as, bs, tol)) {
    if (exactoPara(m, x, y, exact)) {
      out.push(...contactosExactos(c, x, y, tol, pen));
      continue;
    }
    const A = obbOf(m, x), B = obbOf(m, y);
    const depth = satDepth(A, B);
    if (depth < -tol || depth > pen) continue;
    for (const k of contactsOf(A, B, tol)) {
      out.push(new Contact({ kind: k.kind, a: x, b: y, points: k.points, area: k.area, normal: k.normal, faceA: caraLocal(k.faceA), faceB: caraLocal(k.faceB) }));
    }
  }
  return Object.freeze(out);
}

/** @param {Ctx} c @param {string} x @param {string} y @param {number} tol @param {number} pen @returns {Contact[]} */
function contactosExactos(c, x, y, tol, pen) {
  const A = convexosEnElMundo(c, x), B = convexosEnElMundo(c, y);
  /** @type {[Convex, Convex][]} */
  const pares = [];
  for (const a of A) for (const b of B) {
    if (!cajasSeCruzan(a, b, tol)) continue;
    const d = hondura(a, b);
    if (d > pen) return []; // se meten: es una intersección, no un contacto
    if (d >= -tol) pares.push([a, b]);
  }
  const todos = pares.flatMap(([a, b]) => contactosConvexos(a, b, tol));
  // un pedazo vecino puede dar, sobre la misma junta, una arista o un punto que ya está en otro contacto
  const caras = todos.filter((k) => k.kind === 'face');
  const cerca = (/** @type {number[]} */ p, /** @type {number[]} */ q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) <= tol;
  /** @type {typeof todos} */
  const unicos = [];
  for (const k of todos) {
    if (k.kind !== 'face' && caras.some((f) => k.points.every((p) => f.points.some((q) => cerca(p, q)) || dentroDeCara(p, f.points, f.normal, tol)))) continue;
    if (unicos.some((u) => u.kind === k.kind && u.points.length === k.points.length && u.points.every((p) => k.points.some((q) => cerca(p, q))))) continue;
    unicos.push(k);
  }
  return unicos.map((k) => new Contact({
    kind: k.kind, a: x, b: y, points: k.points, area: k.area, normal: k.normal,
    faceA: caraDePlano(c.model, x, k.planeA), faceB: caraDePlano(c.model, y, k.planeB),
  }));
}

/** ¿El punto cae sobre el polígono plano (a tol de su plano)? @param {number[]} p @param {number[][]} poly @param {number[]} n @param {number} tol */
function dentroDeCara(p, poly, n, tol) {
  const d = (p[0] - poly[0][0]) * n[0] + (p[1] - poly[0][1]) * n[1] + (p[2] - poly[0][2]) * n[2];
  if (Math.abs(d) > tol) return false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const e = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const cx = [e[1] * w[2] - e[2] * w[1], e[2] * w[0] - e[0] * w[2], e[0] * w[1] - e[1] * w[0]];
    if (cx[0] * n[0] + cx[1] * n[1] + cx[2] * n[2] < -tol * Math.hypot(...e)) return false;
  }
  return true;
}

/**
 * Las intersecciones entre las piezas de dos grupos. Con `exact`, con la forma real.
 * @param {Ctx} c @param {string[]} as @param {string[]} bs @param {number} tol @param {boolean} [exact]
 */
function intersecciones(c, as, bs, tol, exact) {
  const m = c.model;
  /** @type {Intersection[]} */
  const out = [];
  for (const [x, y] of candidatePairs(m, as, bs, 0)) {
    if (exactoPara(m, x, y, exact)) {
      const A = convexosEnElMundo(c, x), B = convexosEnElMundo(c, y);
      let depth = -Infinity, volume = 0;
      /** @type {number[][]} */ const vertices = [];
      /** @type {number[][][]} */ const faces = [];
      for (const a of A) for (const b of B) {
        if (!cajasSeCruzan(a, b, 0)) continue;
        const d = hondura(a, b);
        if (d <= tol) continue;
        const r = cruce(a, b);
        if (!r) continue;
        depth = Math.max(depth, d);
        volume += volumen(r);
        vertices.push(...r.vertices);
        faces.push(...r.faces.map((f) => f.poly));
      }
      if (volume > 0) out.push(new Intersection({ a: x, b: y, volume, depth, vertices, faces }));
      continue;
    }
    const A = obbOf(m, x), B = obbOf(m, y);
    const depth = satDepth(A, B);
    if (depth <= tol) continue;
    const r = intersectBoxes(A, B);
    if (r) out.push(new Intersection({ a: x, b: y, volume: r.volume, depth, vertices: r.vertices, faces: r.faces }));
  }
  return Object.freeze(out);
}

/**
 * Los rasgos de una pieza, en su marco: los de su caja, o los de su forma real.
 * @param {Ctx} c @param {string} id @returns {import('./grab.js').Rasgos}
 */
function rasgosDe(c, id) {
  const m = c.model, p = m.piece(id);
  if (esCaja(p)) return { vertices: m.cornersLocal(p), edges: m.edges(id, 'local'), faces: m.faces(id, 'local').map((f) => ({ outer: f.corners, holes: [], normal: f.normal })) };
  return c.features(id);
}

/**
 * Lo que devuelve `closest`: qué se agarró (un vértice, una arista o una cara de una pieza) y el
 * punto llevado a él. `key` lo identifica: dos resultados con la misma `key` son el mismo rasgo.
 * @typedef {{ kind: 'vertex' | 'edge' | 'face', piece: string, point: Point3d, edge: Line | null, face: Face | null, key: string }} Grab
 */

/**
 * ¿Dos agarres son el mismo rasgo de la misma pieza? Sirve para no redibujar mientras el
 * cursor sigue sobre lo mismo.
 * @param {Grab | null} a @param {Grab | null} b
 */
export function sameFeature(a, b) {
  return !!a && !!b && a.key === b.key;
}

/** Lo que hace de clave cuando una pieza no tiene forma de bruto u operaciones (un WeakMap no acepta null). */
const SIN_FORMA = Object.freeze({});
const SIN_OPERACIONES = /** @type {readonly Operation[]} */ (Object.freeze([]));

/** @param {unknown} x @returns {string} */
const idDe = (x) => {
  if (typeof x === 'string') return x;
  if (x instanceof Part) return x.id;
  throw new TypeError('va otra parte (o su id)');
};

/**
 * Lo que tiene toda parte: identidad, colocación, geometría consultable y los verbos.
 * No se construye a mano: sale de `taller.addPiece`, `taller.assemble` o `taller.part(id)`.
 */
export class Part {
  /** @param {Ctx} c @param {string} id */
  constructor(c, id) {
    ctxOf.set(this, c);
    /** @readonly */ this.id = id;
    Object.freeze(this);
  }

  get kind() { return ctx(this).model.get(this.id).kind; }
  get name() { return ctx(this).model.get(this.id).name; }
  /** El ensamble que la contiene, o null. @returns {Part | null} */
  get parent() { const p = ctx(this).model.get(this.id).parent; return p ? ctx(this).part(p) : null; }
  /**
   * De qué parte es copia: la fuente, si es una instancia, o la parte que copia, si es de
   * adentro de una. Null si es una original.
   * @returns {Part | null}
   */
  get source() { const s = ctx(this).model.get(this.id).source; return s ? ctx(this).part(s) : null; }
  /** Las instancias que se colocaron de esta parte. @returns {readonly Part[]} */
  get instances() { return Object.freeze(ctx(this).model.instancesOf(this.id).map((i) => ctx(this).part(i))); }
  /** Su colocación en el mundo: el Transform que lleva de su marco local al mundo. */
  get placement() { return new Transform(ctx(this).model.worldFrame(this.id)); }
  /** Sus ejes locales x, y, z, vistos desde el mundo. */
  get axes() {
    const r = ctx(this).model.worldFrame(this.id).r;
    return Object.freeze({ x: new Vector3d(r[0], r[3], r[6]), y: new Vector3d(r[1], r[4], r[7]), z: new Vector3d(r[2], r[5], r[8]) });
  }

  // ---------- geometría, en el mundo ----------
  get vertices() { return this.#vertices('world'); }
  get edges() { return this.#edges('world'); }
  get faces() { return this.#faces('world'); }
  get boundingBox() { return this.#box('world'); }
  /** La misma geometría, en el marco local de la parte. */
  get local() {
    const self = this;
    return Object.freeze({
      get vertices() { return self.#vertices('local'); },
      get edges() { return self.#edges('local'); },
      get faces() { return self.#faces('local'); },
      get boundingBox() { return self.#box('local'); },
    });
  }

  // Una pieza que es una caja lisa da los de su caja; una con perfil, torneado u operaciones,
  // los de su forma real (los que salen de su malla): vértices donde se juntan tres caras o más,
  // aristas rectas (las de una superficie curva no se ofrecen) y caras planas, con sus agujeros.

  /** @param {Space} s */
  #vertices(s) {
    const c = ctx(this), m = c.model, ps = m.piecesOf(this.id);
    if (ps.every(esCaja)) return Object.freeze(m.positions(this.id, s).map((v) => new Point3d(...v)));
    return Object.freeze(ps.flatMap((p) => {
      const f = m.toSpace(p.id, s, this.id);
      return (esCaja(p) ? m.cornersLocal(p) : c.features(p.id).vertices).map((v) => new Point3d(...apply(f, v)));
    }));
  }
  /** @param {Space} s */
  #edges(s) {
    const c = ctx(this), m = c.model, ps = m.piecesOf(this.id);
    if (ps.every(esCaja)) return Object.freeze(m.edges(this.id, s).map(([a, b]) => new Line(a, b)));
    return Object.freeze(ps.flatMap((p) => {
      const f = m.toSpace(p.id, s, this.id);
      return (esCaja(p) ? m.edges(p.id, 'local') : c.features(p.id).edges).map(([a, b]) => new Line(apply(f, a), apply(f, b)));
    }));
  }
  /** @param {Space} s */
  #faces(s) {
    const c = ctx(this), m = c.model, ps = m.piecesOf(this.id);
    /** @param {ReturnType<Model['faces']>[number]} f */
    const deCaja = (f) => new Face({ piece: f.piece, localAxis: AXES[f.axis], localSide: f.side, normal: f.normal, center: f.center, vertices: f.corners });
    if (ps.every(esCaja)) return Object.freeze(m.faces(this.id, s).map(deCaja));
    return Object.freeze(ps.flatMap((p) => {
      const t = new Transform(m.toSpace(p.id, s, this.id));
      if (esCaja(p)) return m.faces(p.id, 'local').map(deCaja).map((f) => f.transform(t));
      return c.features(p.id).faces.map((f) => {
        const k = f.normal.findIndex((v) => Math.abs(v) > 1 - 1e-9);
        const n = f.outer.length;
        const center = /** @type {[number, number, number]} */ ([0, 1, 2].map((i) => f.outer.reduce((acc, v) => acc + v[i], 0) / n));
        return new Face({
          piece: p.id, localAxis: k < 0 ? null : AXES[k], localSide: k < 0 ? null : /** @type {1 | -1} */ (Math.sign(f.normal[k])),
          normal: f.normal, center, vertices: f.outer, holes: f.holes,
        }).transform(t);
      });
    }));
  }
  /** @param {Space} s */
  #box(s) { const b = ctx(this).model.box(this.id, s); return new BoundingBox(b.min, b.max); }

  // ---------- verbos: todos son una transformación ----------

  /** El verbo del que salen los demás. Solo cambia la colocación. @param {Transform} t */
  transform(t) { ctx(this).model.transform(this.id, Transform.check(t).frame); return this; }
  /**
   * Trasladar: por un vector, o de un punto a otro (como mover de a dos clics).
   * @param {VectorLike | PointLike} a @param {PointLike} [b]
   */
  move(a, b) { return this.transform(Transform.translation(a, b)); }
  /**
   * Girar en grados. El eje es 'x' | 'y' | 'z' del mundo o un vector (p. ej. una dirección
   * propia: `pieza.directions.length`). Gira por el centro de su caja si no se dice otro.
   * @param {number} degrees @param {AxisLike} [axis] @param {PointLike} [center]
   */
  rotate(degrees, axis = 'z', center) {
    return this.transform(Transform.rotation(degrees, axis, center ?? this.boundingBox.center));
  }
  /** Copia exacta en el mismo lugar, con todo lo que tiene adentro. @returns {Part} */
  duplicate() { return ctx(this).part(ctx(this).model.duplicate(this.id)); }
  /**
   * Suelta una instancia: pasa a ser una parte de verdad, copia de lo que era su fuente, que
   * ya no la sigue. Conserva su id y su lugar.
   */
  detach() {
    const c = ctx(this);
    const antes = c.model.subtree(this.id);
    c.model.detach(this.id);
    c.forget(antes.filter((id) => id !== this.id));
    return this;
  }
  /** @param {string} name */
  rename(name) { ctx(this).model.rename(this.id, name); return this; }
  /**
   * ¿Está anclada al mundo? Una parte fija no la mueve el asentador de relaciones (un vínculo
   * contra ella no se crea, y uno que ya existe queda roto en vez de moverla). Un ensamble fijo
   * fija todo lo de adentro. `move` y `transform` no lo miran: eso lo decide quien los llama.
   */
  get fixed() { return ctx(this).model.isFixed(this.id); }
  /** Anclarla al mundo, o soltarla. Una pieza que está en un ensamble fijo sigue fija hasta soltar el ensamble. @param {boolean} fixed */
  setFixed(fixed) { ctx(this).model.setFixed(this.id, fixed); return this; }
  /** La borra del documento, con todo lo que cuelga de ella. */
  remove() {
    const c = ctx(this);
    const ids = c.model.subtree(this.id);
    c.model.remove(this.id);
    c.forget(ids);
  }
  // ---------- contacto con otras partes ----------
  // Entre las piezas de esta parte y las de la otra. Una parte contra sí misma da lo que
  // pasa adentro: e.contactsWith(e) son las uniones entre las piezas de un ensamble.

  // `tolerance`, si se pasa, va en la unidad del documento; si no, la del taller (`taller.tolerances`).

  // `exact: true`: con la forma real de cada pieza (perfil, torneado, operaciones), no con su caja.
  // Si no se dice, es exacto para los pares donde alguna pieza tiene recortes; `exact: false`
  // fuerza las cajas.

  /** ¿Se toca con la otra (a `tolerance` o menos), sin meterse? @param {Part | string} other @param {{ tolerance?: number, exact?: boolean }} [opts] */
  touches(other, { tolerance, exact } = {}) { return this.contactsWith(other, { tolerance, exact }).length > 0; }
  /** ¿Se mete en la otra más de `tolerance`? @param {Part | string} other @param {{ tolerance?: number, exact?: boolean }} [opts] */
  intersects(other, { tolerance, exact } = {}) { return this.intersectionsWith(other, { tolerance, exact }).length > 0; }
  /** Dónde se toca con la otra. @param {Part | string} other @param {{ tolerance?: number, exact?: boolean }} [opts] */
  contactsWith(other, { tolerance, exact } = {}) {
    const c = ctx(this), m = c.model;
    const t = c.tolerances();
    return contactos(c, piezasDe(m, this.id), piezasDe(m, idDe(other)), tolerance ?? t.touch, t.penetration, exact);
  }
  /** Lo que comparte de volumen con la otra. @param {Part | string} other @param {{ tolerance?: number, exact?: boolean }} [opts] */
  intersectionsWith(other, { tolerance, exact } = {}) {
    const c = ctx(this), m = c.model;
    return intersecciones(c, piezasDe(m, this.id), piezasDe(m, idDe(other)), tolerance ?? c.tolerances().penetration, exact);
  }

  /**
   * El vértice, la arista o la cara (de sus piezas) más cercana a un punto, con el punto llevado
   * a ella; null si no hay ninguna a la distancia del agarre. Se prefiere un vértice a una arista
   * y una arista a una cara. La franja de cada eje de una pieza es `tolerance` (la del taller si
   * no se dice), pero no más que GRAB_RATIO del largo de ese eje.
   * `kinds`: los tipos que se piden (`['vertex', 'edge', 'face']` por defecto); los otros ni se
   * miran, así que apuntar a una esquina sin pedir vértices devuelve su arista o su cara.
   * @param {PointLike} point @param {{ tolerance?: number, space?: Space, kinds?: ('vertex' | 'edge' | 'face')[] }} [opts] `space`: en qué marco va el punto y sale el resultado
   * @returns {Grab | null}
   */
  closest(point, { tolerance, space = 'world', kinds } = {}) {
    if (kinds !== undefined && (!Array.isArray(kinds) || !kinds.length || kinds.some((k) => !FEATURE_KINDS.includes(k)))) {
      throw new TypeError(`kinds inválido: ${JSON.stringify(kinds)} (va una lista con 'vertex', 'edge' y/o 'face')`);
    }
    const c = ctx(this), m = c.model;
    const T = tolerance ?? c.tolerances().grab;
    const propio = m.worldFrame(this.id);
    const pw = space === 'local' ? apply(propio, vec3(point, 'punto')) : vec3(point, 'punto');
    /** @type {{ h: NonNullable<ReturnType<typeof closestFeature>>, id: string, W: import('./frame.js').Frame, rango: number } | null} */
    let mejor = null;
    for (const p of m.piecesOf(this.id)) {
      const W = m.worldFrame(p.id);
      const tol = /** @type {[number, number, number]} */ (p.size.map((x) => Math.min(T, GRAB_RATIO * x)));
      const h = closestFeature(apply(invert(W), pw), rasgosDe(c, p.id), tol, kinds);
      if (!h) continue;
      const rango = h.kind === 'vertex' ? 0 : h.kind === 'edge' ? 1 : 2;
      if (!mejor || rango < mejor.rango || (rango === mejor.rango && h.d < mejor.h.d)) mejor = { h, id: p.id, W, rango };
    }
    if (!mejor) return null;
    const { h, id, W } = mejor;
    const F = space === 'local' ? compose(invert(propio), W) : W;
    const r6 = (/** @type {number[]} */ v) => v.map((x) => Math.round(x * 1e6) / 1e6).join(',');
    /** @type {Grab} */
    let out;
    if (h.kind === 'vertex') out = { kind: 'vertex', piece: id, point: new Point3d(...apply(F, h.point)), edge: null, face: null, key: `${id}:v:${r6(h.point)}` };
    else if (h.kind === 'edge') {
      const [a, b] = h.edge;
      const k = [r6(a), r6(b)].sort().join('|');
      out = { kind: 'edge', piece: id, point: new Point3d(...apply(F, h.point)), edge: new Line(apply(F, a), apply(F, b)), face: null, key: `${id}:e:${k}` };
    } else {
      const f = h.face, n = f.normal, k = n.findIndex((v) => Math.abs(v) > 1 - 1e-9);
      const center = /** @type {[number, number, number]} */ ([0, 1, 2].map((i) => f.outer.reduce((acc, v) => acc + v[i], 0) / f.outer.length));
      const face = new Face({
        piece: id, localAxis: k < 0 ? null : AXES[k], localSide: k < 0 ? null : /** @type {1 | -1} */ (Math.sign(n[k])),
        normal: n, center, vertices: f.outer, holes: f.holes,
      }).transform(new Transform(F));
      out = { kind: 'face', piece: id, point: new Point3d(...apply(F, h.point)), edge: null, face, key: `${id}:f:${r6(n)}:${r6(center)}` };
    }
    return Object.freeze(out);
  }

  toString() { return `${this.kind === 'piece' ? 'Piece' : 'Assembly'} ${this.id} «${this.name}»`; }

  /** @type {Member[]} */
  static members = [
    ['id', 'su identificador (P-1, E-1…)'],
    ['kind', "'piece' o 'assembly'"],
    ['name', 'su nombre'],
    ['parent', 'el ensamble que la contiene, o null'],
    ['source', 'de quién es copia, si es una instancia (o de adentro de una); si no, null'],
    ['instances', 'las instancias que se colocaron de ella'],
    ['placement', 'su colocación en el mundo (Transform)'],
    ['axes', 'sus ejes locales x, y, z vistos desde el mundo (Vector3d)'],
    ['vertices', 'sus vértices en el mundo (Point3d), los de su forma real. vertices[0].x se lee, no se escribe'],
    ['edges', 'sus aristas rectas en el mundo (Line); las de una superficie curva no se ofrecen'],
    ['faces', 'sus caras planas en el mundo (Face), con sus agujeros'],
    ['boundingBox', 'la caja que la encierra, alineada al mundo'],
    ['local', 'lo mismo en su propio marco: local.vertices, local.edges, local.faces, local.boundingBox (y local.solid, en una pieza)'],
    ['transform(t)', 'aplicarle un Transform: el verbo del que salen los demás'],
    ['move(v) / move(from, to)', 'trasladar por un vector, o de un punto a otro'],
    ["rotate(degrees, axis?, center?)", "girar en grados; eje 'x' | 'y' | 'z' o un vector; por el centro de su caja"],
    ['duplicate()', 'copia exacta en el mismo lugar, con todo lo de adentro (independiente: no sigue a la original)'],
    ['detach()', 'soltar una instancia: pasa a ser una parte de verdad, que ya no sigue a su fuente'],
    ['rename(name)', 'cambiarle el nombre'],
    ['fixed', '¿está anclada al mundo (ella o el ensamble que la tiene)? el asentador de relaciones no la mueve; move() y transform() no lo miran'],
    ['setFixed(fixed)', 'anclarla al mundo o soltarla; un ensamble fijo fija todo lo de adentro'],
    ['remove()', 'borrarla, con todo lo que cuelga de ella'],
    ['touches(other, { tolerance?, exact? })', '¿se toca con la otra sin meterse? (a tolerances.touch o menos). exact: con la forma real, no la caja'],
    ['intersects(other, { tolerance?, exact? })', '¿se mete en la otra? (más de tolerances.penetration)'],
    ['contactsWith(other, { tolerance?, exact? })', 'dónde se toca con la otra (Contact). Con ella misma: sus uniones internas'],
    ['intersectionsWith(other, { tolerance?, exact? })', 'lo que comparte de volumen con la otra (Intersection)'],
    ['closest(point, { tolerance?, space?, kinds? })', "el vértice, la arista o la cara más cercana: { kind, piece, point, edge, face, key }, o null"],
    ['toString()', 'para leer'],
    ['help()', 'esta tabla'],
  ];
}

export class Piece extends Part {
  /** Sus medidas en su marco local, sobre x, y, z (en la unidad del documento). */
  get size() {
    const s = ctx(this).model.piece(this.id).size;
    return Object.freeze({ x: s[0], y: s[1], z: s[2] });
  }
  /** Largo, ancho y espesor: salen de su definición, así que girarla no los cambia nunca. */
  get dims() { return Object.freeze({ ...ctx(this).model.dims(this.id) }); }
  /** Hacia dónde corren su largo, su ancho y su espesor, en el mundo. Para girar sobre su propio largo: rotate(90, p.directions.length). */
  get directions() {
    const a = ctx(this).model.piece(this.id).axes;
    const ax = this.axes;
    return Object.freeze({ length: ax[AXES[a.length]], width: ax[AXES[a.width]], thickness: ax[AXES[a.thickness]] });
  }
  get material() { return ctx(this).model.piece(this.id).material; }
  /** La forma de su bruto (perfil, torneado), o null si es una caja. */
  get shape() {
    const s = ctx(this).model.piece(this.id).shape;
    return s ? Object.freeze(JSON.parse(JSON.stringify(s))) : null;
  }
  /** Su bruto: lo que se compra y se corta. Las operaciones no lo cambian. */
  get stock() { return Object.freeze({ size: this.size, shape: this.shape }); }
  /** Lo que se le hace al bruto, en orden (cortes, agujeros), con su id. @returns {readonly Operation[]} */
  get operations() { return /** @type {readonly Operation[]} */ (ctx(this).model.piece(this.id).operations ?? []); }
  /**
   * La forma que resulta, en el mundo: el bruto con sus operaciones. Se calcula, no se guarda.
   * @returns {Mesh}
   */
  get solid() { return this.#solid().transform(this.placement); }
  /**
   * Lo mismo que Part.local, más la forma que resulta (`local.solid`) en el marco de la pieza.
   * @returns {Readonly<{ vertices: readonly Point3d[], edges: readonly Line[], faces: readonly Face[], boundingBox: BoundingBox, solid: Mesh }>}
   */
  get local() {
    const base = super.local, self = this;
    return Object.freeze({
      get vertices() { return base.vertices; },
      get edges() { return base.edges; },
      get faces() { return base.faces; },
      get boundingBox() { return base.boundingBox; },
      /** @returns {Mesh} */
      get solid() { return self.#solid(); },
    });
  }
  /** @returns {Mesh} */
  #solid() { return ctx(this).solid(this.id); }
  /** Cambiar sus medidas, en su marco local. No cambia cuál eje es el largo. Las operaciones se reaplican. @param {PointLike} size */
  resize(size) {
    const c = ctx(this), v = vec3(size, 'medidas');
    c.checkSection(c.model.piece(this.id).shape, v); // que la sección siga entrando
    c.model.resize(this.id, v);
    return this;
  }
  /** @param {string} material */
  setMaterial(material) { ctx(this).model.setMaterial(this.id, material); return this; }
  /**
   * Cambia la forma del bruto: { kind: 'profile', axis, section, params? }, { kind: 'lathe',
   * axis, contour } o null (una caja). Las medidas y las operaciones quedan.
   * @param {unknown} shape
   */
  setShape(shape) { const c = ctx(this); c.model.setShape(this.id, c.checkSection(shape, c.model.piece(this.id).size)); return this; }
  /** Agrega una operación al final (ver OPERATION_KINDS). Su id queda en `operations`. @param {OperationSpec} op */
  addOperation(op) { ctx(this).model.addOperation(this.id, op); return this; }
  /** Reemplaza una operación, en su lugar. @param {string} id @param {OperationSpec} op */
  updateOperation(id, op) { ctx(this).model.updateOperation(this.id, id, op); return this; }
  /** Saca una operación: la forma vuelve a la de antes de ella. @param {string} id */
  removeOperation(id) { ctx(this).model.removeOperation(this.id, id); return this; }
  /**
   * Cuánto material atraviesa la recta que pasa por `point` en la dirección `direction` (en el
   * mundo): el tramo de su forma real que contiene al punto, o que empieza o termina en él. En
   * una pieza maciza es su sombra sobre esa dirección; en un caño, la pared. null si no la toca.
   * @param {PointLike} point @param {VectorLike} direction
   */
  thicknessAt(point, direction) {
    const W = ctx(this).model.worldFrame(this.id);
    const d = vec3(direction, 'dirección'), L = Math.hypot(...d);
    if (!L) throw new Error('la dirección no puede ser nula');
    const dl = rotar(transpose3(W.r), /** @type {[number, number, number]} */ (d.map((x) => x / L)));
    return crossing(this.#solid(), apply(invert(W), vec3(point, 'punto')), dl);
  }

  /** @param {{ print?: boolean }} [opts] */
  static help(opts) { return help('Piece — una pieza: lo que se corta', [...Piece.members, ...Part.members], opts); }
  /** @param {{ print?: boolean }} [opts] */
  help(opts) { return Piece.help(opts); }

  /** @type {Member[]} */
  static members = [
    ['size', 'sus medidas en su marco local: { x, y, z }'],
    ['dims', '{ length, width, thickness }: largo, ancho y espesor — gire como gire'],
    ['directions', 'hacia dónde corren su largo, ancho y espesor en el mundo (Vector3d)'],
    ['material', 'su material'],
    ['shape', "la forma de su bruto: { kind: 'profile', axis, section, params? }, { kind: 'lathe', axis, contour } o null (una caja)"],
    ['stock', 'su bruto, lo que se compra: { size, shape }; las operaciones no lo cambian'],
    ['operations', "lo que se le hace al bruto, en orden: { id, kind: 'cut' | 'hole', … }"],
    ['solid', 'la forma que resulta (Mesh), en el mundo: se calcula, no se guarda'],
    ['resize(size)', 'cambiar sus medidas en su marco local; las operaciones se reaplican'],
    ['setMaterial(m)', 'cambiarle el material'],
    ['setShape(shape)', 'cambiarle la forma del bruto (perfil, torneado; null: una caja)'],
    ['addOperation(op)', "agregar una operación: { kind: 'cut', axis, outline } o { kind: 'hole', axis, side, at, diameter, depth? }"],
    ['updateOperation(id, op)', 'reemplazar una operación, en su lugar'],
    ['removeOperation(id)', 'sacar una operación: la forma vuelve a la de antes'],
    ['thicknessAt(point, direction)', 'cuánto material atraviesa la recta por point en esa dirección (la pared, si es un caño), o null'],
    ['static help()', 'esta tabla, sin crear una pieza'],
  ];
}

/**
 * Las unidades de un conjunto de partes para estirarlo sobre su eje k: cada pieza (o instancia,
 * que va entera), con lo que ocupa en el marco `marco` (el del ensamble, o el del mundo).
 * @param {Ctx} c @param {string[]} raices @param {Frame} marco @param {0 | 1 | 2} k @param {Set<string>} fijas
 * @returns {import('./stretch.js').Unidad[]}
 */
function unidadesDe(c, raices, marco, k, fijas) {
  const m = c.model;
  const inv = invert(marco);
  const vistas = new Set();
  const [u, v] = [0, 1, 2].filter((i) => i !== k);
  /** @type {import('./stretch.js').Unidad[]} */
  const out = [];
  /** @param {string} id */
  const visitar = (id) => {
    if (vistas.has(id)) return;
    vistas.add(id);
    const rec = m.own(id);
    if (rec.kind === 'assembly') { rec.children.forEach(visitar); return; }
    const pts = rec.kind === 'piece'
      ? m.cornersLocal(rec).map((p) => apply(compose(inv, m.worldFrame(id)), p))
      : m.positions(id, 'world').map((p) => apply(inv, p));
    const rango = (/** @type {number} */ i) => /** @type {[number, number]} */ ([Math.min(...pts.map((p) => p[i])), Math.max(...pts.map((p) => p[i]))]);
    const [lo, hi] = rango(k);
    /** @type {0 | 1 | 2 | null} */
    let eje = null;
    if (rec.kind === 'piece') {
      const r = compose(inv, m.worldFrame(id)).r;
      const j = [0, 1, 2].find((jj) => Math.abs(r[3 * k + jj]) > 1 - 1e-9);
      eje = j === undefined ? null : /** @type {0 | 1 | 2} */ (j);
    }
    out.push({ id, lo, hi, resto: [rango(u), rango(v)], eje, fija: fijas.has(id) ? 'locked' : rec.kind === 'instance' ? 'instance' : null });
  };
  raices.forEach(visitar);
  return out;
}

/** El eje de estirado, como número. @param {unknown} axis @param {string} de de quién es el marco @returns {0 | 1 | 2} */
function ejeEstirar(axis, de) {
  const k = typeof axis === 'number' ? axis : ({ x: 0, y: 1, z: 2 })[/** @type {string} */ (axis)];
  if (k !== 0 && k !== 1 && k !== 2) throw new TypeError(`eje inválido: ${String(axis)} (va 'x', 'y', 'z' ${de})`);
  return /** @type {0 | 1 | 2} */ (k);
}

/** @typedef {import('./frame.js').Frame} Frame */
/** @typedef {{ axis: AxisLike | 0 | 1 | 2, plane?: number, side?: 1 | -1, delta?: number, locked?: (Part | string)[], minLength?: number }} StretchOpts */

/**
 * Lo que haría estirar `raices` por un plano, en el marco `marco`. Sin tocar nada.
 * @param {Ctx} c @param {string[]} raices @param {Frame} marco @param {string} de de quién es el marco
 * @param {StretchOpts} opts
 */
function planDeEstirar(c, raices, marco, de, { axis, plane, side = 1, delta = 0, locked = [], minLength }) {
  const k = ejeEstirar(axis, de);
  if (side !== 1 && side !== -1) throw new TypeError(`side inválido: ${String(side)} (va 1 o -1)`);
  if (typeof delta !== 'number' || !Number.isFinite(delta)) throw new TypeError(`delta inválido: ${String(delta)}`);
  const us = unidadesDe(c, raices, marco, k, fijasDe(c, locked));
  const p = plane ?? cutPlanes(us)[0]?.plane;
  if (p === undefined) throw new Error(`no hay dónde cortar sobre ${'xyz'[k]}`);
  const { pasos, min } = stretchPlan(us, { plane: p, side, minLength: minLength ?? c.tolerances().minLength });
  const aplicado = Math.max(delta, min);
  return Object.freeze({
    axis: k, plane: p, side, delta: aplicado, requested: delta, min, limited: aplicado !== delta,
    pieces: Object.freeze(pasos.map((x) => Object.freeze({ part: c.part(x.id), action: x.action, ...(x.axis === undefined ? {} : { axis: x.axis }), ...(x.reason ? { reason: x.reason } : {}) }))),
  });
}

/** @param {Ctx} c @param {(Part | string)[]} locked */
function fijasDe(c, locked) {
  return new Set(locked.flatMap((x) => [idDe(x), ...c.model.piecesOf(idDe(x)).map((p) => p.id)]));
}

/**
 * Hace lo que dice el plan, en un solo paso de deshacer. `dir`: hacia dónde corre el eje de
 * estirado, en el mundo.
 * @param {Ctx} c @param {ReturnType<typeof planDeEstirar>} plan @param {[number, number, number]} dir
 */
function estirarPlan(c, plan, dir) {
  const m = c.model;
  const corre = (/** @type {number} */ d) => /** @type {[number, number, number]} */ (dir.map((x) => x * d));
  m.transaction(() => {
    for (const x of plan.pieces) {
      if (x.action === 'move') m.move(x.part.id, corre(plan.side * plan.delta));
      else if (x.action === 'stretch' && x.axis !== undefined) {
        const pieza = /** @type {Piece} */ (x.part);
        const s = /** @type {[number, number, number]} */ ([pieza.size.x, pieza.size.y, pieza.size.z]);
        s[x.axis] += plan.delta;
        pieza.resize(s);
        m.move(x.part.id, corre((plan.side * plan.delta) / 2));
      }
    }
  });
}

export class Assembly extends Part {
  /** Las partes que tiene adentro, en el primer nivel. @returns {readonly Part[]} */
  get children() {
    const p = ctx(this).model.get(this.id);
    return Object.freeze(p.kind === 'assembly' ? p.children.map((c) => ctx(this).part(c)) : []);
  }
  /** Todas las piezas que tiene adentro, a cualquier profundidad. */
  get pieces() { return Object.freeze(ctx(this).model.piecesOf(this.id).map((p) => /** @type {Piece} */ (ctx(this).part(p.id)))); }
  // ---------- estirar por un plano ----------
  // Todo en el marco del ensamble, sobre uno de sus ejes ('x', 'y', 'z' o 0, 1, 2).

  /** @param {AxisLike | 0 | 1 | 2} axis @returns {0 | 1 | 2} */
  #eje(axis) { return ejeEstirar(axis, 'del ensamble'); }
  /** Lo que se estira: sus hijos, en su marco. */
  #unidades() {
    const m = ctx(this).model;
    return { raices: [...m.ownAssembly(this.id).children], marco: m.worldFrame(this.id) };
  }

  /**
   * Los planos donde se puede cortar para estirar, sobre un eje del ensamble: el medio de cada
   * hueco entre bordes, el más ancho primero (entre patas, entre estantes) y, si empatan, el
   * más centrado. `plane` va en el marco del ensamble.
   * @param {AxisLike | 0 | 1 | 2} axis @param {{ locked?: (Part | string)[] }} [opts]
   */
  stretchPlanes(axis, { locked = [] } = {}) {
    const { raices, marco } = this.#unidades();
    return Object.freeze(cutPlanes(unidadesDe(ctx(this), raices, marco, this.#eje(axis), fijasDe(ctx(this), locked))).map((p) => Object.freeze(p)));
  }

  /**
   * Lo que haría estirar (sin hacerlo): qué se estira, qué se mueve y qué se queda, y hasta dónde
   * se puede achicar. `side`: el lado que se arrastra (1: hacia +axis). `delta`: cuánto crece
   * (negativo: se achica; se limita a `min`). `plane`: el mejor de stretchPlanes si no se dice.
   * `locked`: lo que nunca se estira (se mueve o se queda entero).
   * @param {StretchOpts} opts
   */
  stretchPlan(opts) {
    const { raices, marco } = this.#unidades();
    try { return planDeEstirar(ctx(this), raices, marco, 'del ensamble', opts); }
    catch (e) { if (e instanceof Error && e.message.startsWith('no hay dónde')) e.message = `${this.id}: ${e.message}`; throw e; }
  }

  /**
   * Estira (o achica) el ensamble por un plano: hace lo de stretchPlan, en un solo paso de
   * deshacer, y lo devuelve. Las piezas estiradas cambian su medida a lo largo del eje y sus
   * operaciones se reaplican (van normalizadas).
   * @param {StretchOpts} opts
   */
  stretch(opts) {
    const plan = this.stretchPlan(opts);
    const e = /** @type {[number, number, number]} */ ([0, 0, 0]);
    e[plan.axis] = 1;
    estirarPlan(ctx(this), plan, rotar(ctx(this).model.worldFrame(this.id).r, e));
    return plan;
  }

  /** Lo deshace: sus partes quedan sueltas (o en el ensamble de arriba), en el mismo lugar. */
  explode() {
    const c = ctx(this);
    const kids = c.model.disassemble(this.id);
    c.forget([this.id]);
    return Object.freeze(kids.map((k) => c.part(k)));
  }

  /** @param {{ print?: boolean }} [opts] */
  static help(opts) { return help('Assembly — un conjunto de partes con colocación propia', [...Assembly.members, ...Part.members], opts); }
  /** @param {{ print?: boolean }} [opts] */
  help(opts) { return Assembly.help(opts); }

  /** @type {Member[]} */
  static members = [
    ['children', 'las partes de adentro, primer nivel'],
    ['pieces', 'todas las piezas de adentro, a cualquier profundidad'],
    ['explode()', 'deshacerlo: sus partes quedan en el mismo lugar'],
    ['stretchPlanes(axis, { locked? })', 'dónde se puede cortar para estirar sobre un eje del ensamble: { plane, gap }, el hueco más ancho primero'],
    ['stretchPlan({ axis, plane?, side?, delta?, locked?, minLength? })', 'lo que haría estirar, sin hacerlo: qué se estira, se mueve o se queda, y el límite'],
    ['stretch({ axis, plane?, side?, delta?, locked?, minLength? })', 'estirar (o achicar) por un plano, en un solo paso de deshacer'],
    ['static help()', 'esta tabla, sin crear un ensamble'],
  ];
}


// ---------- relaciones ----------
// Una relación vive en el documento entre partes guardadas: se deshace, se guarda, y se limpia
// sola si se borra una de sus partes. Las de adentro de la fuente de una instancia se ven en la
// instancia con ids de camino (I-1/R-2): se leen, pero se cambian en la fuente.

/** Los ejes como letra o número. @param {unknown} a @returns {0 | 1 | 2} */
function ejeDe(a) {
  const k = typeof a === 'number' ? a : ({ x: 0, y: 1, z: 2 })[/** @type {string} */ (a)];
  if (k !== 0 && k !== 1 && k !== 2) throw new TypeError(`eje inválido: ${String(a)} (va 'x', 'y', 'z' de la pieza, o 0, 1, 2)`);
  return /** @type {0 | 1 | 2} */ (k);
}

/** Una cara de una pieza, pedida como Face (de `pieza.faces`) o como { axis, side } en su marco. @param {unknown} f @returns {{ axis: 0 | 1 | 2, side: 1 | -1, piece: string | null }} */
function caraPedida(f) {
  if (f instanceof Face) {
    if (!f.localAxis || !f.localSide) throw new Error('esa cara no mira hacia un eje de la pieza: va una cara plana alineada a sus ejes');
    return { axis: ejeDe(f.localAxis), side: f.localSide, piece: f.piece };
  }
  const o = /** @type {Record<string, unknown>} */ (f ?? {});
  const axis = ejeDe(o.axis ?? o.localAxis);
  const side = o.side ?? o.localSide;
  if (side !== 1 && side !== -1) throw new TypeError(`lado inválido: ${String(side)} (va 1 o -1)`);
  return { axis, side, piece: null };
}

/** @param {unknown} m @returns {Record<string, any> | null} */
const metaDe = (m) => {
  if (m === undefined || m === null) return null;
  if (typeof m !== 'object' || Array.isArray(m)) throw new TypeError('meta va como un objeto (lo que la app quiera guardar con la relación)');
  return JSON.parse(JSON.stringify(m));
};

/** @template T @param {T} o @returns {T} */
const congelado = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) congelado(v); }
  return o;
};

/**
 * Lo común a toda relación: de qué tipo es, entre qué partes, si vale y lo que la app guardó.
 * No se construye a mano: sale de `taller.addJoint`, `addFixing`, `addLink` o `taller.relation(id)`.
 */
export class Relation {
  /** @param {Ctx} c @param {string} id */
  constructor(c, id) {
    ctxOf.set(this, c);
    /** @readonly */ this.id = id;
    Object.freeze(this);
  }
  /** @returns {RelationDef} */
  get record() { return ctx(this).model.relation(this.id); }
  /** 'joint', 'fixing', 'link' (o el tipo que haya guardado la app). */
  get kind() { return this.record.kind; }
  /** Las partes que relaciona. @returns {readonly Part[]} */
  get parts() { return Object.freeze(this.record.parts.map((p) => ctx(this).part(p))); }
  /** null si vale; si no, por qué. */
  get broken() { return this.record.broken; }
  /** Lo que la app guardó con ella (el SDK no lo lee). */
  get meta() { return this.record.meta; }
  /** ¿Es de adentro de una instancia? Entonces se lee, pero se cambia en la fuente. */
  get isVirtual() { return this.id.includes('/'); }
  /** Cambia lo que la app guarda con ella. @param {Record<string, any> | null} meta */
  setMeta(meta) { ctx(this).model.updateRelation(this.id, { meta: metaDe(meta) }); return this; }
  /** La borra (con las operaciones que son de ella, como los agujeros de una unión). */
  remove() { ctx(this).model.removeRelation(this.id); }
  toString() { const r = this.record; return `${r.kind} ${this.id} entre ${r.parts.join(', ')}${r.broken ? ` (rota: ${r.broken})` : ''}`; }

  /** @param {{ print?: boolean }} [opts] */
  static help(opts) { return help('Relation — una relación entre partes', Relation.members, opts); }
  /** @param {{ print?: boolean }} [opts] */
  help(opts) { return /** @type {typeof Relation} */ (this.constructor).help(opts); }

  /** @type {Member[]} */
  static members = [
    ['id', 'su identificador (R-1…; I-1/R-2 si es de adentro de una instancia)'],
    ['record', 'lo guardado, tal cual: { id, kind, parts, data, ops, broken, meta }'],
    ['kind', "'joint', 'fixing' o 'link'"],
    ['parts', 'las partes que relaciona'],
    ['broken', 'null si vale; si no, por qué'],
    ['meta', 'lo que la app guardó con ella (el SDK no lo lee)'],
    ['isVirtual', '¿es de adentro de una instancia? (se lee; se cambia en la fuente)'],
    ['setMeta(meta)', 'cambiar lo que la app guarda con ella'],
    ['remove()', 'borrarla, con las operaciones que son de ella'],
    ['toString()', 'para leer'],
    ['help()', 'esta tabla'],
    ['static help()', 'esta tabla, sin crear una relación'],
  ];
}

/**
 * Una junta: la parte móvil gira sobre un eje (revolute: una bisagra) o corre a lo largo de una
 * dirección (prismatic: una corredera) respecto de la base. El eje vive en el marco de la base,
 * así que sigue al mueble como esté. El documento guarda la junta cerrada; abrirla es `at(value)`,
 * que no cambia nada.
 */
export class Joint extends Relation {
  /** 'revolute' o 'prismatic'. @returns {'revolute' | 'prismatic'} */
  get type() { return this.record.data.type; }
  get moving() { return ctx(this).part(this.record.parts[0]); }
  get base() { return ctx(this).part(this.record.parts[1]); }
  /** El eje en el mundo: una Line desde un punto del eje, de largo 1 en su dirección. */
  get axis() {
    const { origin, direction } = this.#ejeMundo();
    return new Line(origin, origin.map((x, k) => x + direction[k]));
  }
  /** { min, max } (grados o unidades del documento), o null si no tiene. */
  get limits() { const l = this.record.data.limits; return l ? Object.freeze({ min: l[0], max: l[1] }) : null; }
  #ejeMundo() {
    const m = ctx(this).model, d = this.record.data, W = m.worldFrame(this.record.parts[1]);
    return { origin: apply(W, d.origin), direction: rotar(W.r, d.direction) };
  }
  /** @param {{ min: number, max: number } | [number, number] | null} limits */
  setLimits(limits) {
    const r = this.record;
    ctx(this).model.updateRelation(this.id, { data: { ...r.data, limits: limitesDe(limits) } });
    return this;
  }
  /**
   * La junta abierta en `value` (grados si gira, unidades del documento si corre), limitado a sus
   * límites: el Transform que se le aplica a la parte móvil y la colocación de cada pieza suya en
   * el mundo. No cambia el modelo: es para animar.
   * @param {number} value
   */
  at(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`valor inválido: ${String(value)}`);
    const c = ctx(this), m = c.model, r = this.record;
    const v = clampTo(value, r.data.limits);
    const { origin, direction } = this.#ejeMundo();
    const T = jointMotion(r.data.type, origin, direction, v);
    /** @type {Record<string, Transform>} */
    const placements = {};
    for (const p of m.piecesOf(r.parts[0])) placements[p.id] = new Transform(compose(T, m.worldFrame(p.id)));
    return Object.freeze({ value: v, limited: v !== value, transform: new Transform(T), placement: new Transform(compose(T, m.worldFrame(r.parts[0]))), placements: Object.freeze(placements) });
  }

  /** @param {{ print?: boolean }} [opts] */
  static help(opts) { return help('Joint — una junta: bisagra (revolute) o corredera (prismatic)', [...Joint.members, ...Relation.members], opts); }

  /** @type {Member[]} */
  static members = [
    ['type', "'revolute' (gira) o 'prismatic' (corre)"],
    ['moving', 'la parte que se mueve'],
    ['base', 'la parte respecto de la cual se mueve (el eje vive en su marco)'],
    ['axis', 'el eje en el mundo (Line de largo 1 en su dirección)'],
    ['limits', '{ min, max } en grados o unidades del documento, o null'],
    ['setLimits(limits)', 'cambiarle los límites ({ min, max }, [min, max] o null)'],
    ['at(value)', 'abierta en value, sin cambiar nada: { value, limited, transform, placement, placements: { [id de pieza]: Transform } }'],
  ];
}

/**
 * Una unión (fijación) entre dos piezas que se tocan cara con cara: `a` es por donde entra (la
 * cabeza queda en su cara de afuera) y `b`, donde agarra. Sus puntos van normalizados sobre el
 * parche de contacto, así que siguen en su lugar al estirar o girar. Si las piezas se separan, se
 * marca rota (o se borra, según `policy`). Sus agujeros son operaciones de las dos piezas.
 */
export class Fixing extends Relation {
  get a() { return /** @type {Piece} */ (ctx(this).part(this.record.parts[0])); }
  get b() { return /** @type {Piece} */ (ctx(this).part(this.record.parts[1])); }
  /** 'break' (queda rota si se separan) o 'remove' (se borra). */
  get policy() { return this.record.data.policy; }
  /** Cuántos puntos reparte sola, o null si van puestos a mano. */
  get count() { return this.record.data.count; }
  /** Los agujeros que hace en cada pieza: { a: { diameter, depth? } | null, b: … }. */
  get holes() { return congelado(JSON.parse(JSON.stringify(this.record.data.holes))); }
  /** Dónde está ahora: el parche de contacto, la dirección de entrada y sus puntos. null si las piezas no se tocan. */
  get placement() { return ubicarUnion(ctx(this), this.record); }
  /** Hacia dónde entra, de a hacia b (Vector3d), o null si no se tocan. */
  get direction() { return this.placement?.direction ?? null; }
  /**
   * Sus puntos: { uv (normalizado sobre el parche), point (en el mundo), thickness: { a, b } (lo
   * que atraviesa de cada pieza en la dirección de entrada) }. Vacío si no se tocan.
   */
  get points() {
    const u = this.placement;
    if (!u) return Object.freeze([]);
    const c = ctx(this), [pa, pb] = this.record.parts;
    const A = /** @type {Piece} */ (c.part(pa)), B = /** @type {Piece} */ (c.part(pb));
    return Object.freeze(u.points.map((p) => Object.freeze({
      uv: p.uv, point: p.point,
      thickness: Object.freeze({ a: A.thicknessAt(p.point, u.direction), b: B.thicknessAt(p.point, u.direction) }),
    })));
  }
  /**
   * Cambia sus puntos, su reparto, sus agujeros o su política. Lo que no se pasa queda.
   * @param {{ points?: [number, number][], count?: number, holes?: { a?: { diameter: number, depth?: number } | null, b?: { diameter: number, depth?: number } | null }, policy?: 'break' | 'remove' }} cambios
   */
  update(cambios) {
    const r = ctx(this).model.ownRelation(this.id);
    ctx(this).model.updateRelation(this.id, { data: datosDeUnion({ ...r.data, ...cambiosDeUnion(cambios) }) });
    return this;
  }

  /** @param {{ print?: boolean }} [opts] */
  static help(opts) { return help('Fixing — una unión entre dos piezas que se tocan', [...Fixing.members, ...Relation.members], opts); }

  /** @type {Member[]} */
  static members = [
    ['a', 'la pieza por donde entra (la cabeza queda en su cara de afuera)'],
    ['b', 'la pieza donde agarra'],
    ['policy', "'break' (si se separan queda rota) o 'remove' (se borra)"],
    ['count', 'cuántos puntos reparte sola, o null si van puestos a mano'],
    ['holes', 'los agujeros en cada pieza: { a: { diameter, depth? } | null, b: … }'],
    ['placement', 'dónde está ahora: { patch, faceA, faceB, direction, points }, o null si no se tocan'],
    ['direction', 'hacia dónde entra, de a hacia b (Vector3d), o null'],
    ['points', 'sus puntos: { uv, point, thickness: { a, b } }'],
    ['update({ points?, count?, holes?, policy? })', 'cambiar sus puntos, su reparto, sus agujeros o su política'],
  ];
}

/**
 * Un vínculo: una punta de la pieza `moving` anclada a una cara de la pieza `base`, a `gap` de
 * ella (hacia afuera de la base; 0: al ras; negativo: se mete). Con una punta anclada sobre un eje,
 * la pieza se mueve; con las dos, se estira entre las dos caras. Se resuelve solo después de cada
 * cambio, en cascada y en el mismo paso de deshacer.
 */
export class Link extends Relation {
  get base() { return /** @type {Piece} */ (ctx(this).part(this.record.parts[0])); }
  get moving() { return /** @type {Piece} */ (ctx(this).part(this.record.parts[1])); }
  /** La cara de la base, en su marco: { localAxis, localSide }. */
  get face() { const f = this.record.data.face; return Object.freeze({ localAxis: AXES[f[0]], localSide: f[1] }); }
  /** La punta anclada de la móvil, en su marco: { localAxis, localSide }. */
  get end() { const f = this.record.data.end; return Object.freeze({ localAxis: AXES[f[0]], localSide: f[1] }); }
  /** La separación, hacia afuera de la base. */
  get gap() { return this.record.data.gap; }
  /** @param {number} gap */
  setGap(gap) {
    if (typeof gap !== 'number' || !Number.isFinite(gap)) throw new TypeError(`separación inválida: ${String(gap)}`);
    const r = ctx(this).model.ownRelation(this.id);
    ctx(this).model.updateRelation(this.id, { data: { ...r.data, gap } });
    return this;
  }

  /** @param {{ print?: boolean }} [opts] */
  static help(opts) { return help('Link — la punta de una pieza anclada a la cara de otra', [...Link.members, ...Relation.members], opts); }

  /** @type {Member[]} */
  static members = [
    ['base', 'la pieza de la cara (la que manda)'],
    ['moving', 'la pieza anclada (la que sigue)'],
    ['face', 'la cara de la base: { localAxis, localSide }'],
    ['end', 'la punta anclada de la móvil: { localAxis, localSide }'],
    ['gap', 'la separación, hacia afuera de la base (0: al ras; negativo: se mete)'],
    ['setGap(gap)', 'cambiar la separación'],
  ];
}

/** @param {unknown} l @returns {[number, number] | null} */
function limitesDe(l) {
  if (l === null || l === undefined) return null;
  const par = Array.isArray(l) ? l : [/** @type {any} */ (l).min, /** @type {any} */ (l).max];
  if (par.length !== 2 || !par.every((x) => typeof x === 'number' && !Number.isNaN(x)) || par[0] > par[1]) {
    throw new TypeError(`límites inválidos: ${JSON.stringify(l)} (van { min, max } con min ≤ max, o null)`);
  }
  return [par[0], par[1]];
}

/** @param {unknown} h @returns {{ diameter: number, depth?: number } | null} */
function agujeroDe(h) {
  if (h === null || h === undefined) return null;
  const o = /** @type {Record<string, unknown>} */ (h);
  if (typeof o.diameter !== 'number' || !(o.diameter > 0)) throw new TypeError(`agujero inválido: ${JSON.stringify(h)} (va { diameter, depth? }, en la unidad del documento)`);
  if (o.depth !== undefined && (typeof o.depth !== 'number' || !(o.depth > 0))) throw new TypeError(`profundidad inválida: ${String(o.depth)} (sin depth, el agujero es pasante)`);
  return o.depth === undefined ? { diameter: o.diameter } : { diameter: o.diameter, depth: o.depth };
}

/** Lo que se puede cambiar de una unión, revisado. @param {Record<string, any>} c */
function cambiosDeUnion(c) {
  /** @type {Record<string, any>} */
  const out = {};
  if (c.points !== undefined) { out.points = c.points; out.count = null; }
  if (c.count !== undefined) { out.count = c.count; out.points = null; }
  if (c.holes !== undefined) out.holes = c.holes;
  if (c.policy !== undefined) out.policy = c.policy;
  return out;
}

/** Los datos de una unión, revisados. @param {Record<string, any>} d */
function datosDeUnion(d) {
  const policy = d.policy ?? 'break';
  if (policy !== 'break' && policy !== 'remove') throw new TypeError(`política inválida: ${String(policy)} (va 'break' o 'remove')`);
  /** @type {[number, number][] | null} */
  let points = null;
  let count = null;
  if (d.points) {
    if (!Array.isArray(d.points) || !d.points.length) throw new TypeError('points va como una lista de [u, v] normalizados');
    points = d.points.map((/** @type {unknown} */ p, /** @type {number} */ i) => {
      if (!Array.isArray(p) || p.length !== 2 || !p.every((x) => typeof x === 'number' && x >= 0 && x <= 1)) throw new RangeError(`punto ${i} inválido: ${JSON.stringify(p)} (va [u, v], de 0 a 1 sobre el parche)`);
      return /** @type {[number, number]} */ ([p[0], p[1]]);
    });
  } else {
    count = d.count ?? 1;
    if (!Number.isInteger(count) || count < 1) throw new TypeError(`count inválido: ${String(count)} (va un entero de 1 o más)`);
  }
  const h = d.holes ?? {};
  return { points, count, holes: { a: agujeroDe(h.a), b: agujeroDe(h.b) }, policy };
}

/**
 * Dónde está ahora una unión: el contacto de cara entre sus piezas (el más grande), el parche en
 * el marco de `a`, la dirección de entrada y sus puntos en el mundo. null si no se tocan.
 * @param {Ctx} c @param {RelationDef} r
 */
function ubicarUnion(c, r) {
  const m = c.model, [a, b] = r.parts;
  const t = c.tolerances();
  const ks = contactos(c, [a], [b], t.touch, t.penetration).filter((k) => k.kind === 'face' && k.faceA && k.faceB);
  if (!ks.length) return null;
  const k = ks.reduce((x, y) => (y.area > x.area ? y : x));
  const [fa, fb] = k.a === a ? [k.faceA, k.faceB] : [k.faceB, k.faceA];
  const caraA = { axis: ejeDe(/** @type {any} */ (fa).localAxis), side: /** @type {1 | -1} */ (/** @type {any} */ (fa).localSide) };
  const caraB = { axis: ejeDe(/** @type {any} */ (fb).localAxis), side: /** @type {1 | -1} */ (/** @type {any} */ (fb).localSide) };
  const WA = m.worldFrame(a), invA = invert(WA), sizeA = m.piece(a).size;
  const [u, v] = /** @type {(0 | 1 | 2)[]} */ ([0, 1, 2].filter((i) => i !== caraA.axis));
  const loc = k.points.map((p) => apply(invA, /** @type {[number, number, number]} */ (p.toArray())));
  const lo = [Math.min(...loc.map((q) => q[u])), Math.min(...loc.map((q) => q[v]))];
  const hi = [Math.max(...loc.map((q) => q[u])), Math.max(...loc.map((q) => q[v]))];
  /** @type {[number, number][]} */
  const uvs = r.data.points ?? distribute(r.data.count, hi[0] - lo[0], hi[1] - lo[1]);
  /** @type {[number, number, number]} */ const n = [0, 0, 0];
  n[caraA.axis] = caraA.side;
  const direction = new Vector3d(...rotar(WA.r, n));
  const points = uvs.map((/** @type {[number, number]} */ uv) => {
    /** @type {[number, number, number]} */ const q = [0, 0, 0];
    q[caraA.axis] = (caraA.side * sizeA[caraA.axis]) / 2;
    q[u] = lo[0] + uv[0] * (hi[0] - lo[0]);
    q[v] = lo[1] + uv[1] * (hi[1] - lo[1]);
    return Object.freeze({ uv: Object.freeze([...uv]), point: new Point3d(...apply(WA, q)) });
  });
  return Object.freeze({
    patch: Object.freeze({ min: Object.freeze(lo), max: Object.freeze(hi), axes: Object.freeze([AXES[u], AXES[v]]) }),
    faceA: Object.freeze({ localAxis: AXES[caraA.axis], localSide: caraA.side }), faceB: Object.freeze({ localAxis: AXES[caraB.axis], localSide: caraB.side }),
    direction, points: Object.freeze(points), caraA, caraB,
  });
}

/** Dónde cae un punto del mundo sobre la cara `axis` de una pieza, normalizado (lo que va en `at`). @param {Model} m @param {string} id @param {0 | 1 | 2} axis @param {Point3d} p */
function enLaCara(m, id, axis, p) {
  const q = apply(invert(m.worldFrame(id)), /** @type {[number, number, number]} */ (p.toArray()));
  const size = m.piece(id).size;
  const a01 = (/** @type {number} */ x) => Math.min(1, Math.max(0, Math.round(x * 1e12) / 1e12));
  return /** @type {[number, number]} */ ([0, 1, 2].filter((i) => i !== axis).map((i) => a01((q[i] + size[i] / 2) / size[i])));
}

/**
 * Un documento: el árbol de partes y la puerta de entrada a todo lo demás.
 *
 * `units`: la unidad de todas las medidas (mm, cm, m, in o ft; cm si no se dice). Es un dato
 * del documento: se guarda con él, y un documento cargado trae la suya.
 * `tolerances`: pisa las tolerancias que sugiere config.js para esa unidad, en esa unidad.
 * `historyLimit`: cuántos pasos se pueden deshacer (100 si no se dice; 0: sin historial).
 * `kernel`: lo que combina sólidos en 3D ({ intersect, subtract }, sobre mallas), para dibujar
 * piezas con varias operaciones con una malla limpia. Lo pone la app (three-bvh-csg, manifold…);
 * sin él, el SDK la arma de la forma partida en convexos.
 * `sections`: secciones de perfil propias de la app, `{ nombre: (params, ancho, alto) => sección }`,
 * además de las genéricas de SECTIONS.
 * También se puede pasar un `Model` ya armado en lugar de las opciones.
 * @param {Model | { units?: Unit, tolerances?: Partial<Tolerances>, historyLimit?: number, kernel?: Kernel, sections?: Record<string, SectionFn> }} [init]
 */
export function createWorkshop(init = {}) {
  const model = init instanceof Model ? init : new Model({ units: init.units, historyLimit: init.historyLimit });
  const override = init instanceof Model ? {} : init.tolerances ?? {};
  const kernel = init instanceof Model || init.kernel === undefined ? null : checkKernel(init.kernel);
  const propias = init instanceof Model ? {} : init.sections ?? {};
  for (const [k, f] of Object.entries(propias)) if (typeof f !== 'function') throw new TypeError(`sección ${k} inválida: va una función (params, ancho, alto) => { outer, holes? }`);
  /** @type {Readonly<Record<string, SectionFn>>} */
  const sections = Object.freeze({ ...SECTIONS, ...propias });
  /**
   * Lo que se deriva de la forma de cada pieza (su malla, sus rasgos, sus convexos), mientras no
   * cambie lo que la define: sus medidas, la forma de su bruto y sus operaciones. Lo guardado es
   * inmutable y esas partes se comparten entre un registro y el que lo reemplaza, así que mover
   * o renombrar no lo recalcula, y deshacer vuelve a encontrar lo de antes.
   * @type {{ solid: WeakMap<object, any>, features: WeakMap<object, any>, convex: WeakMap<object, any> }}
   */
  const formas = { solid: new WeakMap(), features: new WeakMap(), convex: new WeakMap() };
  /**
   * `firma`: lo que, además de la definición, cambia el resultado (los recortes: dónde está la
   * otra pieza respecto de esta, y su forma). Se guardan las últimas firmas de cada definición.
   * @template T @param {keyof typeof formas} que @param {Definition} def @param {() => T} calcular @param {string} [firma]
   * @returns {T}
   */
  const porDefinicion = (que, def, calcular, firma = '') => {
    const claves = [def.size, def.shape ?? SIN_FORMA, def.operations ?? SIN_OPERACIONES];
    /** @type {WeakMap<object, any>} */
    let nivel = formas[que];
    for (const k of claves.slice(0, -1)) {
      if (!nivel.has(k)) nivel.set(k, new WeakMap());
      nivel = nivel.get(k);
    }
    const ultima = claves[claves.length - 1];
    if (!nivel.has(ultima)) nivel.set(ultima, new Map());
    /** @type {Map<string, T>} */
    const porFirma = nivel.get(ultima);
    if (porFirma.has(firma)) return /** @type {T} */ (porFirma.get(firma));
    const v = calcular();
    porFirma.set(firma, v);
    if (porFirma.size > 32) porFirma.delete(/** @type {string} */ (porFirma.keys().next().value));
    return v;
  };
  /** Un número por objeto, para meter su identidad en una firma. @type {WeakMap<object, number>} */
  const numeros = new WeakMap();
  let siguiente = 0;
  const numero = (/** @type {object} */ o) => {
    let n = numeros.get(o);
    if (n === undefined) { n = ++siguiente; numeros.set(o, n); }
    return n;
  };
  /**
   * La pieza contra la que recorta un recorte, vista desde `id`: si `id` es de adentro de una
   * instancia, la de la misma instancia (`I-1/P-2` para el `P-2` de la fuente).
   * @param {string} id @param {string} contra @returns {string | null}
   */
  const resolverContra = (id, contra) => {
    const segs = id.split('/');
    for (let k = segs.length - 1; k >= 0; k--) {
      const cand = [...segs.slice(0, k), contra].join('/');
      try { model.piece(cand); return cand; } catch { /* sigue con un prefijo más corto */ }
    }
    return null;
  };
  /** @param {string} id @returns {import('./solid.js').Recortes} */
  const recortesDe = (id) => (op) => {
    const otra = resolverContra(id, op.against);
    if (!otra) return null;
    return { def: model.definition(otra), rel: compose(invert(model.worldFrame(id)), model.worldFrame(otra)) };
  };
  /** Lo que, aparte de su definición, cambia la forma de una pieza con recortes. @param {string} id @param {Definition} def */
  const firmaDe = (id, def) => {
    const trims = (def.operations ?? []).filter((o) => o.kind === 'trim');
    if (!trims.length) return '';
    const r = recortesDe(id);
    return trims.map((op) => {
      const o = r(/** @type {import('./solid.js').TrimOperation} */ (op));
      if (!o) return 'x';
      const marco = [...o.rel.r, ...o.rel.t].map((v) => Math.round(v * 1e9)).join(',');
      const forma = op.mode === 'shape' ? `${numero(o.def.shape ?? SIN_FORMA)},${numero(o.def.operations ?? SIN_OPERACIONES)}` : '';
      return `${numero(o.def.size)}:${forma}:${marco}`;
    }).join('|');
  };
  /**
   * Revisa la forma de un bruto y, si es un perfil, que su sección exista y se pueda armar con
   * esas medidas (una pared más gruesa que la mitad del lado falla acá, no al dibujar).
   * @param {unknown} shape @param {[number, number, number]} [size]
   */
  const checkSection = (shape, size) => {
    const sh = checkShape(shape);
    if (sh?.kind === 'profile' && size) resolveSection(sh, size, sections);
    return sh;
  };
  tolerancesFor(model.units, override); // que un valor inválido falle al crear, no en la primera pregunta
  /** @type {Map<string, Part>} */
  const cache = new Map();
  /** @type {Map<string, Relation>} */
  const relCache = new Map();
  /** @type {Ctx} */
  const c = {
    model,
    tolerances: () => tolerancesFor(model.units, override),
    sections,
    checkSection,
    solid(id) {
      const def = model.definition(id);
      return porDefinicion('solid', def, () => solidOf(def, { kernel, sections, recortes: recortesDe(id) }), firmaDe(id, def));
    },
    features(id) {
      const def = model.definition(id);
      return porDefinicion('features', def, () => featuresOf(c.solid(id)), firmaDe(id, def));
    },
    convex(id) {
      const def = model.definition(id);
      return porDefinicion('convex', def, () => convexPartsOf(def, sections, recortesDe(id)), firmaDe(id, def));
    },
    part(id) {
      const kind = model.get(id).kind; // que falle acá, con un mensaje claro, si no existe
      let h = cache.get(id);
      if (!h || h.kind !== kind) {
        h = kind === 'piece' ? new Piece(c, id) : new Assembly(c, id);
        cache.set(id, h);
      }
      return h;
    },
    relation(id) {
      const kind = model.relation(id).kind;
      let h = relCache.get(id);
      if (!h || h.kind !== kind) {
        h = kind === 'joint' ? new Joint(c, id) : kind === 'fixing' ? new Fixing(c, id) : kind === 'link' ? new Link(c, id) : new Relation(c, id);
        relCache.set(id, h);
      }
      return h;
    },
    forget(ids) { for (const id of ids) cache.delete(id); },
  };

  // ---------- poner en orden las relaciones, después de cada cambio ----------

  /** Una cara de una pieza en el mundo: su normal y su centro. @param {string} id @param {0 | 1 | 2} axis @param {1 | -1} side */
  const caraEnElMundo = (id, axis, side) => {
    const W = model.worldFrame(id), size = model.piece(id).size;
    /** @type {[number, number, number]} */ const n = [0, 0, 0];
    n[axis] = side;
    /** @type {[number, number, number]} */ const q = [0, 0, 0];
    q[axis] = (side * size[axis]) / 2;
    return { n: rotar(W.r, n), p: apply(W, q) };
  };
  const PARALELO = 1 - 1e-6;
  /** @param {readonly number[]} a @param {readonly number[]} b */
  const pt = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  /** Los vínculos guardados, la base antes que lo que depende de ella. */
  const vinculosEnOrden = () => {
    const ls = [...model.relations.values()].filter((r) => r.kind === 'link');
    /** @type {Map<string, RelationDef[]>} pieza móvil → sus vínculos */
    const porMovil = new Map();
    for (const l of ls) {
      if (!porMovil.has(l.parts[1])) porMovil.set(l.parts[1], []);
      /** @type {RelationDef[]} */ (porMovil.get(l.parts[1])).push(l);
    }
    /** @type {string[]} */
    const orden = [];
    /** @type {Set<string>} */
    const visto = new Set();
    /** @param {string} id */
    const visitar = (id) => {
      if (visto.has(id)) return;
      visto.add(id);
      for (const l of porMovil.get(id) ?? []) visitar(l.parts[0]);
      if (porMovil.has(id)) orden.push(id);
    };
    for (const id of porMovil.keys()) visitar(id);
    return orden.map((id) => /** @type {[string, RelationDef[]]} */ ([id, /** @type {RelationDef[]} */ (porMovil.get(id))]));
  };

  /**
   * Lleva cada pieza anclada a donde dicen sus vínculos: con una punta anclada sobre un eje se
   * mueve; con las dos, se estira entre las caras. En cascada: la base antes que lo que sigue.
   */
  const resolverVinculos = () => {
    const eps = 1e-9 * escalaDoc();
    for (const [B, ls] of vinculosEnOrden()) {
      if (!model.parts.has(B) || model.parts.get(B)?.kind !== 'piece') continue;
      /** @type {Map<number, RelationDef[]>} */
      const porEje = new Map();
      for (const l of ls) {
        const k = l.data.end[0];
        if (!porEje.has(k)) porEje.set(k, []);
        /** @type {RelationDef[]} */ (porEje.get(k)).push(l);
      }
      const fija = model.isFixed(B);
      /** Una pieza fija no se mueve: el vínculo que la movería queda roto, con su motivo. @param {RelationDef[]} anclas */
      const frena = (anclas) => {
        for (const l of anclas) if (model.relations.get(l.id)?.broken !== AVISO_FIJA) model.updateRelation(l.id, { broken: AVISO_FIJA });
      };
      for (const [k, anclas] of porEje) {
        const W = model.worldFrame(B), size = model.piece(B).size;
        /** @type {[number, number, number]} */ const d = [W.r[k], W.r[3 + k], W.r[6 + k]];
        /** @type {Map<number, number>} lado de la punta → cuánto correrla */
        const deltas = new Map();
        for (const l of anclas) {
          const A = l.parts[0];
          if (model.parts.get(A)?.kind !== 'piece') continue;
          const f = caraEnElMundo(A, l.data.face[0], l.data.face[1]);
          if (Math.abs(pt(f.n, d)) < PARALELO) {
            if (!l.broken) model.updateRelation(l.id, { broken: 'la cara y la punta ya no son paralelas' });
            continue;
          }
          if (l.broken) model.updateRelation(l.id, { broken: null });
          const s = l.data.end[1];
          const x0 = /** @type {[number, number, number]} */ (W.t.map((x, i) => x + (d[i] * s * size[k]) / 2));
          deltas.set(s, anchorDelta(f.n, pt(f.n, f.p) + l.data.gap, x0, d));
        }
        const mas = deltas.get(1), menos = deltas.get(-1);
        const corre = (/** @type {number} */ x) => /** @type {[number, number, number]} */ (d.map((v) => v * x));
        if (mas !== undefined && menos !== undefined) {
          const L = size[k] + mas - menos;
          if (fija) { if (Math.abs(mas - menos) > eps || Math.abs(mas + menos) > eps) frena(anclas); continue; }
          if (Math.abs(mas - menos) > eps) {
            if (L < c.tolerances().minLength) throw new Error(`los vínculos de ${B} la dejarían de ${L} sobre ${AXES[k]}: menos que el mínimo (${c.tolerances().minLength})`);
            const s2 = /** @type {[number, number, number]} */ ([...size]);
            s2[k] = L;
            checkSection(model.piece(B).shape, s2);
            model.resize(B, s2);
          }
          if (Math.abs(mas + menos) > eps) model.move(B, corre((mas + menos) / 2));
        } else {
          const delta = mas ?? menos;
          if (delta !== undefined && Math.abs(delta) > eps) { if (fija) frena(anclas); else model.move(B, corre(delta)); }
        }
      }
    }
  };

  /** Lo último que se vio de cada unión, para no recalcular lo que no cambió. @type {Map<string, string>} */
  const firmasDeUniones = new Map();
  /** @param {RelationDef} r */
  const firmaDeUnion = (r) => JSON.stringify([r.data, r.ops, r.broken, ...r.parts.map((p) => {
    const q = model.parts.get(p);
    return q?.kind === 'piece' ? [model.worldFrame(p), q.size, q.shape] : null;
  })]);

  /**
   * Revisa las uniones: si sus piezas se siguen tocando, pone sus puntos y sus agujeros donde van
   * ahora; si no, la marca rota o la borra, según su política.
   */
  const mantenerUniones = () => {
    for (const r of [...model.relations.values()]) {
      if (r.kind !== 'fixing' || !model.relations.has(r.id)) continue;
      if (!r.parts.every((p) => model.parts.get(p)?.kind === 'piece')) continue;
      const firma = firmaDeUnion(r);
      if (firmasDeUniones.get(r.id) === firma) continue;
      const u = ubicarUnion(c, r);
      if (!u) {
        if (r.data.policy === 'remove') model.removeRelation(r.id);
        else if (!r.broken) model.updateRelation(r.id, { broken: 'las piezas ya no se tocan' });
        const r2 = model.relations.get(r.id);
        if (r2) firmasDeUniones.set(r.id, firmaDeUnion(r2));
        continue;
      }
      const [a, b] = r.parts;
      /** @type {[string, import('./solid.js').HoleOperation][]} */
      const quiero = [];
      if (r.data.holes.a) for (const p of u.points) quiero.push([a, { kind: 'hole', axis: u.caraA.axis, side: /** @type {1 | -1} */ (-u.caraA.side), at: enLaCara(model, a, u.caraA.axis, p.point), ...r.data.holes.a }]);
      if (r.data.holes.b) for (const p of u.points) quiero.push([b, { kind: 'hole', axis: u.caraB.axis, side: u.caraB.side, at: enLaCara(model, b, u.caraB.axis, p.point), ...r.data.holes.b }]);
      /** @type {[string, string][]} */
      const ops = [];
      const tiene = (/** @type {string} */ pieza, /** @type {string} */ op) => (model.piece(pieza).operations ?? []).find((o) => o.id === op);
      quiero.forEach(([pieza, spec], i) => {
        const ya = r.ops[i];
        const actual = ya && ya[0] === pieza ? tiene(pieza, ya[1]) : undefined;
        if (actual) {
          const { id: _, ...sinId } = actual;
          if (JSON.stringify(sinId) !== JSON.stringify(spec)) model.updateOperation(pieza, ya[1], spec);
          ops.push([pieza, ya[1]]);
        } else ops.push([pieza, model.addOperation(pieza, spec)]);
      });
      for (const [pieza, op] of r.ops.slice(quiero.length)) if (model.parts.has(pieza) && tiene(pieza, op)) model.removeOperation(pieza, op);
      for (const [i, [pieza, op]] of r.ops.slice(0, quiero.length).entries()) {
        if (ops[i][1] !== op || ops[i][0] !== pieza) if (model.parts.has(pieza) && tiene(pieza, op)) model.removeOperation(pieza, op);
      }
      if (r.broken || JSON.stringify(ops) !== JSON.stringify(r.ops)) model.updateRelation(r.id, { ops, broken: null });
      firmasDeUniones.set(r.id, firmaDeUnion(/** @type {RelationDef} */ (model.relations.get(r.id))));
    }
  };

  model.settler = (phase) => {
    resolverVinculos();
    if (phase === 'close') mantenerUniones();
  };
  /** @param {(Part | string)[]} list */
  const ids = (list) => list.map((x) => (typeof x === 'string' ? x : x.id));

  // ---------- colocación: proponer, no aplicar ----------

  /** @param {Part | string | (Part | string)[]} x @returns {string[]} los ids de las piezas que se mueven */
  const piezasQueSeMueven = (x) => [...new Set((Array.isArray(x) ? x : [x]).flatMap((p) => model.piecesOf(idDe(p)).map((q) => q.id)))];
  /** @param {(Part | string)[]} parts @returns {string[]} los ids de las partes a estirar */
  const aEstirar = (parts) => {
    if (!Array.isArray(parts) || !parts.length) throw new TypeError('stretch: falta `parts`, las partes a estirar');
    return [...new Set(parts.map(idDe))];
  };
  /** @param {string[]} mueven @param {(Part | string)[] | undefined} contra */
  const lasOtras = (mueven, contra) => {
    const fuera = new Set(mueven);
    const ids = contra ? contra.flatMap((p) => model.piecesOf(idDe(p)).map((q) => q.id)) : model.allPieces().map((p) => p.id);
    return [...new Set(ids)].filter((id) => !fuera.has(id)).map((id) => obbOf(model, id));
  };
  /** @param {AxisLike | undefined} up @returns {[number, number, number]} */
  const arriba = (up = 'y') => {
    const v = typeof up === 'string' ? (/** @type {Record<string, [number, number, number]>} */ ({ x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }))[up] : vec3(up, 'arriba');
    if (!v) throw new TypeError(`arriba inválido: ${String(up)} (va 'x', 'y', 'z' o un vector)`);
    const m = Math.hypot(...v);
    if (!m) throw new Error('arriba no puede ser nulo');
    return /** @type {[number, number, number]} */ (v.map((x) => x / m));
  };
  const escalaDoc = () => Math.max(1, ...model.allPieces().flatMap((p) => p.size));

  /**
   * Una instancia de una pieza o de un ensamble: la misma parte colocada otra vez. Editar la
   * fuente (medidas, forma, material, lo de adentro) se ve en todas sus instancias. Nace
   * encima de la fuente; `placement` la mueve y la gira, en el mundo.
   * @param {Part | string} part
   * @param {{ name?: string, parent?: Part | string | null, placement?: Transform }} [opts]
   *   parent: el ensamble donde queda (el de la fuente si no se dice; null: suelta).
   * @returns {Part}
   */
  function instantiate(part, { name, parent, placement } = {}) {
    const id = model.instantiate(idDe(part), {
      name,
      parent: parent === undefined || parent === null ? parent : idDe(parent),
      placement: placement ? Transform.check(placement).frame : undefined,
    });
    return c.part(id);
  }

  /** La caja de una parte en el marco de otra. @param {string} id @param {import('./frame.js').Frame} inv */
  const cajaEn = (id, inv) => {
    const pts = model.positions(id, 'world').map((q) => apply(inv, q));
    return {
      min: /** @type {[number, number, number]} */ ([0, 1, 2].map((k) => Math.min(...pts.map((q) => q[k])))),
      max: /** @type {[number, number, number]} */ ([0, 1, 2].map((k) => Math.max(...pts.map((q) => q[k])))),
    };
  };

  /**
   * ¿Se puede crear este vínculo? Lo que diría addLink, sin crearlo.
   * @param {{ base: Part | string, face: unknown, moving: Part | string }} spec
   * @returns {{ ok: true, end: { axis: 0 | 1 | 2, side: 1 | -1 }, face: { axis: 0 | 1 | 2, side: 1 | -1 } } | { ok: false, reason: 'invalid' | 'self' | 'not-parallel' | 'over-constrained' | 'cycle' | 'fixed', message: string }}
   */
  const revisarVinculo = ({ base, face, moving }) => {
    /** @param {'invalid' | 'self' | 'not-parallel' | 'over-constrained' | 'cycle' | 'fixed'} reason @param {string} message */
    const no = (reason, message) => /** @type {const} */ ({ ok: false, reason, message });
    let A, B, f;
    try {
      A = idDe(base); B = idDe(moving);
      model.ownPiece(A); model.ownPiece(B);
      f = caraPedida(face);
    } catch (e) {
      return no('invalid', /** @type {Error} */ (e).message);
    }
    if (f.piece && f.piece !== A) return no('invalid', `esa cara es de ${f.piece}, no de la base ${A}`);
    if (A === B) return no('self', `${A} no se puede anclar a sí misma`);
    if (model.isFixed(B)) return no('fixed', `${B} es fija: un vínculo la movería`);
    const { n } = caraEnElMundo(A, f.axis, f.side);
    const W = model.worldFrame(B);
    const k = /** @type {(0 | 1 | 2)[]} */ ([0, 1, 2]).find((i) => Math.abs(W.r[i] * n[0] + W.r[3 + i] * n[1] + W.r[6 + i] * n[2]) >= PARALELO);
    if (k === undefined) return no('not-parallel', `ninguna punta de ${B} es paralela a la cara ${f.side > 0 ? '+' : '-'}${AXES[f.axis]} de ${A}`);
    const side = /** @type {1 | -1} */ (-Math.sign(W.r[k] * n[0] + W.r[3 + k] * n[1] + W.r[6 + k] * n[2]));
    const ls = [...model.relations.values()].filter((r) => r.kind === 'link');
    const mismoEje = ls.filter((r) => r.parts[1] === B && r.data.end[0] === k);
    const misma = mismoEje.find((r) => r.data.end[1] === side);
    if (misma) return no('over-constrained', `esa punta de ${B} (${side > 0 ? '+' : '-'}${AXES[k]}) ya está anclada por ${misma.id}`);
    if (mismoEje.length >= 2) return no('over-constrained', `${B} ya tiene sus dos puntas ancladas sobre ${AXES[k]}`);
    // ¿la base depende (en cascada) de la móvil? Entonces sería un ciclo
    /** @param {string} x @param {string[]} cam @returns {string[] | null} */
    const camino = (x, cam) => {
      if (x === B) return cam;
      for (const r of ls) if (r.parts[1] === x) { const c2 = camino(r.parts[0], [...cam, r.parts[0]]); if (c2) return c2; }
      return null;
    };
    const ciclo = camino(A, [A]);
    if (ciclo) return no('cycle', `sería un ciclo: ${[B, ...ciclo].join(' → ')} (cada flecha: depende de)`);
    return { ok: true, end: { axis: k, side }, face: { axis: f.axis, side: f.side } };
  };

  /**
   * Las filas del despiece. Una fila por cada grupo de piezas idénticas: mismo bruto (caja,
   * perfil o torneado), mismo material y mismo largo × ancho × espesor (los de `dims`).
   * @param {{ groupBy?: 'identical' | 'none' | ((piece: Piece) => string) }} [opts]
   */
  const cutList = ({ groupBy = 'identical' } = {}) => {
    if (groupBy !== 'identical' && groupBy !== 'none' && typeof groupBy !== 'function') throw new TypeError(`groupBy inválido: ${String(groupBy)} (va 'identical', 'none' o una función)`);
    const fix = model.allRelations().filter((r) => r.kind === 'fixing');
    /** @type {Map<string, { stock: any, material: string, length: number, width: number, thickness: number, count: number, ids: string[], fixings: string[] }>} */
    const filas = new Map();
    const r9 = (/** @type {number} */ x) => Math.round(x * 1e9) / 1e9;
    for (const p of model.allPieces()) {
      const d = model.dims(p.id);
      const stock = p.shape ? JSON.parse(JSON.stringify(p.shape)) : { kind: 'box' };
      const extra = groupBy === 'none' ? p.id : typeof groupBy === 'function' ? String(groupBy(/** @type {Piece} */ (c.part(p.id)))) : '';
      const clave = JSON.stringify([stock, p.material, r9(d.length), r9(d.width), r9(d.thickness), extra]);
      let f = filas.get(clave);
      if (!f) { f = { stock, material: p.material, length: d.length, width: d.width, thickness: d.thickness, count: 0, ids: [], fixings: [] }; filas.set(clave, f); }
      f.count++;
      f.ids.push(p.id);
      for (const r of fix) if (r.parts.includes(p.id) && !f.fixings.includes(r.id)) f.fixings.push(r.id);
    }
    return congelado([...filas.values()]);
  };

  const workshop = {
    model,
    Point3d, Vector3d, Line, BoundingBox, Face, Transform, Contact, Intersection, Mesh,
    /**
     * Una pieza nueva.
     *   fixed: anclada al mundo desde el principio (ver `fixed` de las partes).
     * @param {{ name?: string, fixed?: boolean, size: PointLike, material?: string, shape?: object | null,
     *           center?: PointLike, placement?: Transform, axes?: { length: 0|1|2, width: 0|1|2, thickness: 0|1|2 } }} spec
     *   size: largo de cada eje local, en la unidad del documento. center: dónde queda su centro (el origen si no se dice).
     *   placement: la orienta al crearla, en vez de crearla derecha y girarla después (p. ej.
     *   `Transform.fromEuler([rx, ry, rz])`, para importar un diseño que guarda Euler).
     *   axes: cuál eje local es el largo, el ancho y el espesor; por tamaño si no se dice.
     */
    addPiece({ name, size, material, shape, center = [0, 0, 0], placement, axes, fixed = false }) {
      const id = model.addPiece({
        name, size: vec3(size, 'medidas'), material, shape: checkSection(shape, vec3(size, 'medidas')), at: vec3(center, 'centro'),
        r: placement ? Transform.check(placement).frame.r : undefined,
        axes,
      });
      if (fixed) model.setFixed(id, true);
      return /** @type {Piece} */ (c.part(id));
    },
    /**
     * Junta partes hermanas en un ensamble nuevo. Si alguna ya es un ensamble, queda
     * adentro: se anida, no se aplasta.
     * @param {(Part | string)[]} parts @param {{ name?: string }} [opts]
     */
    assemble(parts, opts) { return /** @type {Assembly} */ (c.part(model.assemble(ids(parts), opts))); },
    instantiate,
    /**
     * Repite una parte en línea, en área o alrededor de un eje (ver `arrayTransforms`).
     * `count` cuenta a la original: con 4 se crean 3 instancias, que siguen a la fuente.
     * Es un solo paso de deshacer.
     * @param {Part | string} part @param {ArraySpec} spec
     * @returns {readonly Part[]} las instancias nuevas
     */
    array(part, spec) {
      const p = c.part(idDe(part));
      const ts = arrayTransforms(spec, { origin: p.boundingBox.center });
      return model.transaction(() => Object.freeze(ts.slice(1).map((t) => instantiate(p, { placement: t }))));
    },
    /**
     * La primera pieza que corta un rayo (contra su forma real) y dónde: { part, point,
     * distance, normal }, o null. Sin three: para pruebas, para el servidor, o para elegir
     * sin escena. `exclude`: partes que no cuentan (la que se está arrastrando).
     * @param {{ origin: PointLike, direction: VectorLike }} ray @param {{ exclude?: (Part | string)[] }} [opts]
     */
    pick(ray, { exclude = [] } = {}) {
      const o = vec3(ray?.origin, 'origen del rayo');
      const d0 = vec3(ray?.direction, 'dirección del rayo');
      const L = Math.hypot(...d0);
      if (!L) throw new Error('la dirección del rayo no puede ser nula');
      const d = /** @type {[number, number, number]} */ (d0.map((v) => v / L));
      const fuera = new Set(exclude.flatMap((x) => model.piecesOf(idDe(x)).map((p) => p.id)));
      /** @type {{ id: string, t: number, n: [number, number, number] } | null} */
      let mejor = null;
      for (const p of model.allPieces()) {
        if (fuera.has(p.id)) continue;
        const W = model.worldFrame(p.id), inv = invert(W);
        const ol = apply(inv, o), dl = rotar(transpose3(W.r), d);
        const entra = rayBox(ol, dl, /** @type {[number, number, number]} */ (p.size.map((x) => x / 2)));
        if (entra === null || (mejor && entra > mejor.t)) continue;
        const h = rayMesh(ol, dl, c.solid(p.id));
        if (h && (!mejor || h.t < mejor.t)) mejor = { id: p.id, t: h.t, n: rotar(W.r, h.normal) };
      }
      if (!mejor) return null;
      const { id, t, n } = mejor;
      return Object.freeze({ part: c.part(id), point: new Point3d(o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t), distance: t, normal: new Vector3d(...n) });
    },
    /**
     * Imán: la traslación que pega las caras de lo que se mueve a las de otras piezas que estén
     * a `distance` o menos (enfrentadas: se tocan; del mismo lado: al ras), y qué la causó. No
     * aplica nada. `grid`: en los ejes del mundo que el imán no tocó, la esquina cae en la grilla.
     * @param {Part | string | (Part | string)[]} parts
     * Con `axis` ('x', 'y', 'z' del mundo o un vector), solo corre a lo largo de esa dirección:
     * pega la cara que queda a menos recorrido y no mueve nada en las otras (para el arrastre por
     * un eje de un gizmo).
     * @param {{ against?: (Part | string)[], distance?: number, grid?: number | null, axis?: AxisLike }} [opts]
     */
    snap(parts, { against, distance, grid = null, axis } = {}) {
      const mueven = piezasQueSeMueven(parts);
      const r = snapMove(mueven.map((id) => obbOf(model, id)), lasOtras(mueven, against), { distance: distance ?? c.tolerances().snap, grid, axis: axis === undefined ? null : arriba(axis) });
      if (!r) return null;
      return Object.freeze({
        transform: Transform.translation(r.t),
        snaps: Object.freeze(r.snaps.map((x) => Object.freeze({ normal: new Vector3d(...x.normal), delta: x.delta, other: c.part(x.other), kind: x.kind }))),
      });
    },
    /**
     * Los planos donde se puede cortar para estirar `parts` (partes hermanas cualquiera, no hace
     * falta un ensamble) sobre un eje del mundo: el medio de cada hueco entre bordes, el más
     * ancho primero.
     * @param {{ parts: (Part | string)[], axis: AxisLike | 0 | 1 | 2, locked?: (Part | string)[] }} opts
     */
    stretchPlanes({ parts, axis, locked = [] }) {
      return Object.freeze(cutPlanes(unidadesDe(c, aEstirar(parts), marcoDe(), ejeEstirar(axis, 'del mundo'), fijasDe(c, locked))).map((p) => Object.freeze(p)));
    },
    /**
     * Lo que haría estirar `parts` por un plano (sin hacerlo): como `Assembly.stretchPlan`, pero
     * sobre partes sueltas y con `axis` y `plane` en el mundo.
     * @param {StretchOpts & { parts: (Part | string)[] }} opts
     */
    stretchPlan({ parts, ...opts }) {
      return planDeEstirar(c, aEstirar(parts), marcoDe(), 'del mundo', opts);
    },
    /**
     * Estira (o achica) `parts` por un plano, en un solo paso de deshacer, y devuelve el plan.
     * @param {StretchOpts & { parts: (Part | string)[] }} opts
     */
    stretch(opts) {
      const plan = this.stretchPlan(opts);
      const e = /** @type {[number, number, number]} */ ([0, 0, 0]);
      e[plan.axis] = 1;
      estirarPlan(c, plan, e);
      return plan;
    },
    /**
     * Si lo que se mueve está metido en otras piezas, la traslación que lo saca por el lado de
     * menor penetración (queda tocando, sin meterse). Con `floor`, nunca por debajo del piso,
     * medido en la dirección `up` ('y' por defecto). null si no está metido en nada.
     * @param {Part | string | (Part | string)[]} parts
     * @param {{ against?: (Part | string)[], floor?: number | null, up?: AxisLike }} [opts]
     */
    pushOut(parts, { against, floor = null, up } = {}) {
      const mueven = piezasQueSeMueven(parts);
      const r = pushOutMove(mueven.map((id) => obbOf(model, id)), lasOtras(mueven, against), { up: arriba(up), floor, scale: escalaDoc() });
      return r && Object.freeze({ transform: Transform.translation(r.t), from: Object.freeze(r.from.map((id) => c.part(id))) });
    },
    /**
     * Apoyar: cuánto baja lo que se mueve (contra `up`) hasta tocar algo de abajo o el piso, y la
     * traslación. `on`: la pieza donde apoya, o null si es el piso. null si no hay nada abajo.
     * @param {Part | string | (Part | string)[]} parts
     * @param {{ against?: (Part | string)[], floor?: number | null, up?: AxisLike }} [opts]
     */
    drop(parts, { against, floor = null, up } = {}) {
      const mueven = piezasQueSeMueven(parts);
      const u = arriba(up);
      const r = dropMove(mueven.map((id) => obbOf(model, id)), lasOtras(mueven, against), { up: u, floor });
      return r && Object.freeze({ transform: Transform.translation(u.map((x) => -x * r.distance)), distance: r.distance, on: r.on ? c.part(r.on) : null });
    },
    /**
     * Los planos de otras piezas con los que lo que se mueve quedó alineado (a `tolerance` o
     * menos), los más cercanos primero y sin repetir: para dibujar las guías.
     * @param {Part | string | (Part | string)[]} parts
     * @param {{ against?: (Part | string)[], tolerance?: number }} [opts]
     */
    alignmentGuides(parts, { against, tolerance } = {}) {
      const mueven = piezasQueSeMueven(parts);
      return Object.freeze(guides(mueven.map((id) => obbOf(model, id)), lasOtras(mueven, against), { tolerance: tolerance ?? c.tolerances().touch })
        .map((g) => Object.freeze({ normal: new Vector3d(...g.normal), offset: g.offset, other: c.part(g.other), kind: g.kind, gap: g.gap })));
    },
    /**
     * Una junta entre dos partes: la móvil gira sobre `axis` (revolute) o corre a lo largo de él
     * (prismatic) respecto de la base. `axis`: una Line en el mundo (para una corredera alcanza su
     * dirección, o un vector). `limits`: { min, max } en grados o en unidades del documento; en una
     * corredera, si no se dicen, de 0 al largo de la móvil en esa dirección.
     * @param {{ type: 'revolute' | 'prismatic', moving: Part | string, base: Part | string, axis: Line | VectorLike, limits?: { min: number, max: number } | [number, number] | null, meta?: Record<string, any> }} spec
     * @returns {Joint}
     */
    addJoint({ type, moving, base, axis, limits, meta }) {
      if (!JOINT_TYPES.includes(type)) throw new TypeError(`tipo de junta inválido: ${String(type)} (van ${JOINT_TYPES.join(', ')})`);
      const M = idDe(moving), B = idDe(base);
      model.own(M); model.own(B);
      if (M === B) throw new Error(`${M} no puede moverse respecto de sí misma`);
      /** @type {[number, number, number]} */ let o, dir;
      if (axis instanceof Line) { o = /** @type {[number, number, number]} */ (axis.from.toArray()); dir = /** @type {[number, number, number]} */ (axis.direction.toArray()); }
      else if (type === 'prismatic') { o = [0, 0, 0]; dir = vec3(/** @type {VectorLike} */ (axis), 'dirección'); }
      else throw new TypeError('una junta que gira necesita su eje: una Line en el mundo');
      const L = Math.hypot(...dir);
      if (!L) throw new Error('el eje de la junta no puede tener largo 0');
      dir = /** @type {[number, number, number]} */ (dir.map((x) => x / L));
      const inv = invert(model.worldFrame(B));
      let lim = limitesDe(limits);
      if (limits === undefined && type === 'prismatic') {
        const pts = model.positions(M, 'world').map((q) => pt(q, dir));
        lim = [0, Math.max(...pts) - Math.min(...pts)];
      }
      const id = model.addRelation({
        kind: 'joint', parts: [M, B], meta: metaDe(meta),
        data: { type, origin: apply(inv, o), direction: rotar(inv.r, dir), limits: lim },
      });
      return /** @type {Joint} */ (c.relation(id));
    },
    /**
     * Los cantos donde puede ir una bisagra entre la móvil y la base, calculados en el marco de la
     * base (andan igual con el mueble girado): los de la cara de la móvil que mira a la base, con el
     * sentido que la abre hacia afuera; primero los más cerca de la base y los más largos. Cada uno
     * va directo a addJoint: { type, moving, base, axis, limits }.
     * @param {Part | string} moving @param {Part | string} base
     */
    hingeCandidates(moving, base) {
      const M = idDe(moving), B = idDe(base), W = model.worldFrame(B), inv = invert(W);
      return congelado(hingeCandidates(cajaEn(M, inv), cajaEn(B, inv)).map((h) => ({
        type: /** @type {const} */ ('revolute'), moving: c.part(M), base: c.part(B), limits: null, distance: h.distance,
        axis: new Line(apply(W, h.origin), apply(W, /** @type {[number, number, number]} */ (h.origin.map((x, k) => x + h.direction[k] * h.length)))),
      })));
    },
    /**
     * Las direcciones en que la móvil puede correr sin chocar con las piezas de la base (en el
     * marco de la base): primero las que menos tiene que andar para salir. Cada una va directo a
     * addJoint, con límites de 0 a su largo en esa dirección.
     * @param {Part | string} moving @param {Part | string} base
     */
    slideCandidates(moving, base) {
      const M = idDe(moving), B = idDe(base), W = model.worldFrame(B), inv = invert(W);
      const fuera = new Set(model.piecesOf(M).map((p) => p.id));
      const piezas = model.piecesOf(B).filter((p) => !fuera.has(p.id)).map((p) => cajaEn(p.id, inv));
      const m = cajaEn(M, inv);
      const centro = /** @type {[number, number, number]} */ ([0, 1, 2].map((k) => (m.min[k] + m.max[k]) / 2));
      return congelado(slideCandidates(m, piezas.length ? piezas : [cajaEn(B, inv)], c.tolerances().touch).map((x) => ({
        type: /** @type {const} */ ('prismatic'), moving: c.part(M), base: c.part(B), limits: { min: 0, max: x.travel }, gap: x.gap,
        axis: new Line(apply(W, centro), apply(W, /** @type {[number, number, number]} */ (centro.map((v, k) => v + x.direction[k] * x.travel)))),
      })));
    },
    /**
     * Una unión entre dos piezas que se tocan cara con cara: `a` es por donde entra y `b`, donde
     * agarra. Sus puntos van normalizados sobre el parche de contacto (`points`: [u, v] de 0 a 1),
     * o se reparten solos (`count`, 1 si no se dice nada). `holes`: el agujero que hace en cada
     * pieza ({ diameter, depth? }; sin depth, pasante), como operaciones de las piezas. `policy`:
     * qué pasa si se separan ('break': queda rota, por defecto; 'remove': se borra).
     * @param {{ a: Part | string, b: Part | string, points?: [number, number][], count?: number, holes?: { a?: { diameter: number, depth?: number } | null, b?: { diameter: number, depth?: number } | null }, policy?: 'break' | 'remove', meta?: Record<string, any> }} spec
     * @returns {Fixing}
     */
    addFixing({ a, b, points, count, holes, policy, meta }) {
      const A = idDe(a), B = idDe(b);
      model.ownPiece(A); model.ownPiece(B);
      if (A === B) throw new Error(`${A} no se puede unir consigo misma`);
      const data = datosDeUnion({ points, count, holes, policy });
      if (!ubicarUnion(c, /** @type {RelationDef} */ ({ id: '', kind: 'fixing', parts: [A, B], data, ops: [], broken: null, meta: null }))) {
        throw new Error(`${A} y ${B} no se tocan cara con cara: una unión va en el contacto entre dos caras`);
      }
      return /** @type {Fixing} */ (c.relation(model.addRelation({ kind: 'fixing', parts: [A, B], data, meta: metaDe(meta) })));
    },
    /**
     * Un vínculo: ancla la punta de `moving` que mira a la cara `face` de `base`, a `gap` de ella
     * (hacia afuera; si no se dice, la de ahora). Con una punta anclada sobre un eje, la pieza se
     * mueve con la base; con las dos, se estira entre las dos caras. Falla si sobre-restringe, si
     * hace un ciclo o si no hay una punta paralela a la cara (ver validateLink).
     * @param {{ base: Part | string, face: Face | { axis: AxisLike | 0 | 1 | 2, side: 1 | -1 }, moving: Part | string, gap?: number, meta?: Record<string, any> }} spec
     * @returns {Link}
     */
    addLink({ base, face, moving, gap, meta }) {
      const v = revisarVinculo({ base, face, moving });
      if (!v.ok) throw new Error(v.message);
      const A = idDe(base), B = idDe(moving);
      if (gap !== undefined && (typeof gap !== 'number' || !Number.isFinite(gap))) throw new TypeError(`separación inválida: ${String(gap)}`);
      const f = caraEnElMundo(A, v.face.axis, v.face.side);
      const W = model.worldFrame(B), k = v.end.axis;
      const x0 = W.t.map((x, i) => x + (W.r[3 * i + k] * v.end.side * model.piece(B).size[k]) / 2);
      const g = gap ?? Math.round((pt(f.n, x0) - pt(f.n, f.p)) * 1e9) / 1e9;
      const id = model.addRelation({ kind: 'link', parts: [A, B], meta: metaDe(meta), data: { face: [v.face.axis, v.face.side], end: [v.end.axis, v.end.side], gap: g } });
      return /** @type {Link} */ (c.relation(id));
    },
    /**
     * ¿Se puede crear este vínculo? { ok: true, end, face } o { ok: false, reason, message }. `end`
     * es la punta de `moving` que quedaría anclada y `face` la cara de la base, los dos como
     * { localAxis, localSide } (igual que `link.end` y `link.face` una vez creado). `reason` es
     * 'over-constrained', 'cycle', 'not-parallel', 'fixed', 'self' o 'invalid'.
     * @param {{ base: Part | string, face: unknown, moving: Part | string }} spec
     */
    validateLink(spec) {
      const v = revisarVinculo(spec);
      return Object.freeze(v.ok
        ? { ok: true, end: Object.freeze(caraLocal(v.end)), face: Object.freeze(caraLocal(v.face)) }
        : { ok: false, reason: v.reason, message: v.message });
    },
    /** Una relación por su id (también una de adentro de una instancia). @param {string} id */
    relation(id) { return c.relation(id); },
    /**
     * Las relaciones del documento (con las que se ven adentro de cada instancia). `kind`: solo de
     * ese tipo. `part`: solo las de esa parte.
     * @param {{ kind?: string, part?: Part | string }} [opts]
     */
    relations({ kind, part } = {}) {
      const p = part === undefined ? null : idDe(part);
      return Object.freeze(model.allRelations().filter((r) => (!kind || r.kind === kind) && (!p || r.parts.includes(p))).map((r) => c.relation(r.id)));
    },
    /**
     * El despiece: { stock, material, length, width, thickness, count, ids, fixings } por cada
     * grupo de piezas idénticas (con las de adentro de las instancias, que suman a la misma fila).
     * Cada pieza va por su bruto (lo que se compra), no por la forma que le dejan sus operaciones.
     * `groupBy`: 'identical' (por defecto), 'none' (una fila por pieza) o una función que, además,
     * separa las filas por lo que devuelva.
     */
    cutList,
    /** @param {string} id */
    part(id) { return c.part(id); },
    get parts() { return Object.freeze([...model.parts.keys()].map((id) => c.part(id))); },
    get roots() { return Object.freeze(model.roots().map((p) => c.part(p.id))); },
    /** La unidad de todas las medidas del documento. */
    get units() { return model.units; },
    /** Las tolerancias en uso, en la unidad del documento: las sugeridas para ella (config.js) y lo que se haya pisado. */
    get tolerances() { return c.tolerances(); },
    /** Todos los contactos entre piezas del documento. @param {{ tolerance?: number, exact?: boolean }} [opts] */
    contacts({ tolerance, exact } = {}) {
      const ps = model.allPieces().map((p) => p.id);
      const t = c.tolerances();
      return contactos(c, ps, ps, tolerance ?? t.touch, t.penetration, exact);
    },
    /** Todas las piezas que se meten unas en otras. @param {{ tolerance?: number, exact?: boolean }} [opts] */
    collisions({ tolerance, exact } = {}) {
      const ps = model.allPieces().map((p) => p.id);
      return intersecciones(c, ps, ps, tolerance ?? c.tolerances().penetration, exact);
    },
    tree() { return model.tree(); },
    /** @param {(ev: { type: string, ids: string[] }) => void} fn */
    on(fn) { return model.on(fn); },
    /** Vuelve al documento de antes del último paso (marcos, definiciones, ensambles, instancias). false si no había nada. */
    undo() { return model.undo(); },
    /** Vuelve a hacer lo último que se deshizo. false si no había nada. */
    redo() { return model.redo(); },
    get canUndo() { return model.canUndo; },
    get canRedo() { return model.canRedo; },
    /** Abre una transacción: lo que se haga hasta `commit()` es un solo paso de deshacer. Se anidan. */
    begin() { model.begin(); },
    /** Cierra la transacción abierta. */
    commit() { model.commit(); },
    /** Cancela la transacción abierta: el documento vuelve a como estaba en `begin()`. */
    rollback() { model.rollback(); },
    /**
     * Hace `fn` como un solo paso de deshacer. Si tira, el documento vuelve a como estaba.
     * @template T @param {() => T} fn @returns {T}
     */
    transaction(fn) { return model.transaction(fn); },
    /** Olvida lo que se puede deshacer y rehacer; el documento queda como está. */
    clearHistory() { model.clearHistory(); },
    toJSON() { return model.toJSON(); },
    /** @param {any} data */
    load(data) { cache.clear(); relCache.clear(); firmasDeUniones.clear(); model.load(data); },
    clear() { cache.clear(); relCache.clear(); firmasDeUniones.clear(); model.load({ units: model.units, counters: {}, parts: [] }); },
    /** @param {{ print?: boolean }} [opts] */
    help(opts) { return help('Workshop — el documento: crear, buscar y guardar partes', WORKSHOP_MEMBERS, opts); },
  };
  return workshop;
}

/** @type {Member[]} */
export const WORKSHOP_MEMBERS = [
  ['addPiece({ name?, size, material?, shape?, center?, placement?, axes?, fixed? })', 'una pieza nueva (fixed: anclada al mundo desde el principio): size en la unidad del documento sobre sus ejes locales; placement (Transform) la orienta al crearla; axes fuerza cuál eje es el largo, el ancho y el espesor'],
  ['assemble(parts, { name? })', 'un ensamble con esas partes hermanas; se anida, no se aplasta'],
  ['instantiate(part, { name?, parent?, placement? })', 'una instancia: la misma parte colocada otra vez; editar la fuente cambia todas'],
  ['array(part, spec)', "repetir una parte en línea, en área o alrededor de un eje: crea instancias (ver arrayTransforms)"],
  ['pick(ray, { exclude? })', 'la primera pieza que corta un rayo { origin, direction }, contra su forma real: { part, point, distance, normal }, o null'],
  ['stretchPlanes({ parts, axis, locked? })', 'dónde se puede cortar para estirar partes sueltas sobre un eje del mundo: { plane, gap }, el hueco más ancho primero'],
  ['stretchPlan({ parts, axis, plane?, side?, delta?, locked?, minLength? })', 'lo que haría estirar partes sueltas por un plano, sin hacerlo: qué se estira, se mueve o se queda, y el límite'],
  ['stretch({ parts, axis, plane?, side?, delta?, locked?, minLength? })', 'estirar (o achicar) partes sueltas por un plano del mundo, en un solo paso de deshacer'],
  ['snap(parts, { against?, distance?, grid?, axis? })', 'imán de planos de caja: { transform, snaps } que pega las caras de su caja a las de las cajas de otras piezas cercanas (no aplica nada, y no mira la forma real); con axis, solo corre a lo largo de ese eje'],
  ['pushOut(parts, { against?, floor?, up? })', 'si está metida en otras, { transform, from } que la saca por el lado de menor penetración'],
  ['drop(parts, { against?, floor?, up? })', 'apoyar: { transform, distance, on } hasta tocar lo de abajo o el piso'],
  ['alignmentGuides(parts, { against?, tolerance? })', 'los planos de otras piezas con los que quedó alineada, los más cercanos primero'],
  ['addJoint({ type, moving, base, axis, limits?, meta? })', "una junta: la móvil gira sobre axis ('revolute') o corre a lo largo de él ('prismatic'); se abre con joint.at(value)"],
  ['hingeCandidates(moving, base)', 'los cantos donde puede ir una bisagra, en el marco de la base; cada uno va directo a addJoint'],
  ['slideCandidates(moving, base)', 'las direcciones en que la móvil corre sin chocar con la base; cada una va directo a addJoint'],
  ['addFixing({ a, b, points?, count?, holes?, policy?, meta? })', 'una unión entre dos piezas que se tocan: puntos normalizados en el parche, agujeros en las dos'],
  ['addLink({ base, face, moving, gap?, meta? })', 'un vínculo: la punta de moving anclada a una cara de base; una punta mueve, dos estiran'],
  ['validateLink({ base, face, moving })', "¿se puede crear ese vínculo? { ok: true, end, face } (la punta que se ancla y la cara, como { localAxis, localSide }) o { ok: false, reason: 'over-constrained' | 'cycle' | 'not-parallel' | 'fixed' | …, message }"],
  ['relation(id)', 'una relación por su id (Joint, Fixing, Link)'],
  ['relations({ kind?, part? })', 'las relaciones del documento, con las de adentro de las instancias'],
  ['cutList({ groupBy? })', 'el despiece: { stock, material, length, width, thickness, count, ids, fixings } por grupo de piezas idénticas'],
  ['part(id)', 'una parte por su id'],
  ['parts', 'todas las partes'],
  ['roots', 'las partes de primer nivel (las que no están en un ensamble)'],
  ['units', "la unidad de todas las medidas del documento: 'mm', 'cm', 'm', 'in' o 'ft'"],
  ['tolerances', 'las tolerancias en uso, en esa unidad: { touch, penetration } (ver config.js)'],
  ['contacts({ tolerance?, exact? })', 'todos los contactos entre piezas (Contact); exact: con la forma real'],
  ['collisions({ tolerance?, exact? })', 'todas las piezas que se meten unas en otras (Intersection)'],
  ['tree()', 'el árbol de partes, como texto'],
  ['on(fn)', "enterarse de cada cambio ({ type, ids }); deshacer avisa con 'undo' y 'redo', cancelar con 'rollback', y las relaciones con 'relation', 'relation-broken' y 'relation-remove'; devuelve cómo desuscribirse"],
  ['undo()', 'volver al documento de antes del último paso; false si no había nada'],
  ['redo()', 'volver a hacer lo último que se deshizo; false si no había nada'],
  ['canUndo', '¿hay algo para deshacer?'],
  ['canRedo', '¿hay algo para rehacer?'],
  ['begin()', 'abrir una transacción: lo que se haga hasta commit() es un solo paso de deshacer (se anidan)'],
  ['commit()', 'cerrar la transacción abierta'],
  ['rollback()', 'cancelar la transacción abierta: el documento vuelve a como estaba en begin()'],
  ['transaction(fn)', 'hacer fn como un solo paso de deshacer; si tira, todo vuelve a como estaba'],
  ['clearHistory()', 'olvidar lo que se puede deshacer y rehacer'],
  ['toJSON()', 'todo el documento, para guardar'],
  ['load(data)', 'cargar un documento guardado (borra el historial)'],
  ['clear()', 'vaciar el documento (borra el historial; conserva la unidad)'],
  ['model', 'el modelo por dentro (para el visor y las pruebas)'],
  ['Point3d  Vector3d  Line  BoundingBox  Face  Transform  Contact  Intersection  Mesh', 'las clases de valores, a mano'],
  ['help()', 'esta tabla'],
];

/**
 * Lo que exporta el módulo (`import { … } from 'threejs-cad-sdk'`). Una prueba exige que cada
 * export esté acá y que cada entrada exista; de esta tabla y de las de cada clase sale la
 * referencia de la API (docs/).
 * @type {Member[]}
 */
export const MODULE_MEMBERS = [
  ['createWorkshop({ units?, tolerances?, historyLimit?, kernel?, sections? })', "un documento nuevo (el Workshop): la puerta de entrada a todo. units: 'mm' | 'cm' | 'm' | 'in' | 'ft' (cm); tolerances pisa las sugeridas; historyLimit, cuántos pasos se deshacen (100); kernel { intersect, subtract } para mallas más limpias; sections, perfiles propios. También acepta un Model ya armado"],
  ['Part  Piece  Assembly', 'las partes del documento: Part es lo común, Piece una pieza (lo que se corta), Assembly un conjunto de partes. No se construyen a mano: salen del Workshop'],
  ['Relation  Joint  Fixing  Link', 'las relaciones entre partes: Relation es lo común; Joint una junta (bisagra o corredera), Fixing una unión, Link un vínculo. Salen del Workshop'],
  ['Point3d  Vector3d  Line  BoundingBox  Face  Transform  Contact  Intersection  Mesh', 'las clases de valores: inmutables, sin identidad. Lo que se consulta de una parte'],
  ['sameFeature(a, b)', '¿dos resultados de closest() son el mismo rasgo de la misma pieza? (para no redibujar mientras el cursor sigue sobre lo mismo)'],
  ['arrayTransforms(spec, { origin? })', "las transformaciones de una matriz lineal, en área o polar ({ type: 'linear' | 'area' | 'polar', count, … }); la 0 es la identidad"],
  ['convertLength(value, from, to)', 'llevar una medida de una unidad a otra'],
  ['tolerancesFor(unit, overrides?)', 'las tolerancias sugeridas para una unidad, con lo que se pise: { touch, penetration, grab, snap, minLength }'],
  ['UNITS', 'las unidades que se pueden usar, con su sistema y cuántos mm miden'],
  ['TOLERANCE_PRESETS', 'las tolerancias sugeridas de cada sistema, en su unidad natural (las lleva a la del documento tolerancesFor)'],
  ['GRAB_RATIO', 'la franja del agarre en cada eje de una pieza no pasa de esta proporción de su largo'],
  ['OPERATION_KINDS', 'las operaciones que se le pueden hacer al bruto de una pieza'],
  ['SECTIONS', 'las secciones de perfil que trae el SDK: { nombre: (params, ancho, alto) => sección }'],
  ['RELATION_KINDS', 'los tipos de relación que el SDK pone en orden'],
  ['JOINT_TYPES', 'los tipos de junta'],
  ['WORKSHOP_MEMBERS', 'la tabla de lo que tiene un Workshop (la que imprime taller.help())'],
  ['MODULE_MEMBERS', 'esta tabla'],
];
