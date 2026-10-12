// Los valores geométricos: Point3d, Vector3d, Line, BoundingBox, Face y Transform.
//
// Calcados de RhinoCommon en nombre y forma. Son VALORES, no objetos con identidad:
// inmutables (Object.freeze), así que una consulta como `pieza.vertices[0]` se puede leer
// pero no escribir — editar una pieza es siempre por un método explícito de la pieza.
// `transform(t)` en un valor devuelve uno nuevo; el original no cambia.
//
// Transform es el verbo común: mover, girar (y lo que venga) son constructores de un
// Transform, y cualquier geometría sabe aplicarse uno. Transform.apply(t, [...]) lo aplica
// a un array de lo que sea.
//
// Las medidas son números en la unidad del documento (`taller.units`); los ángulos, en grados.
// Este módulo no importa three ni DOM.
import { frame, compose, invert, apply as applyFrame, rotate as rotateVec, turn, isQuarterTurn, toEuler, fromEuler, mul3, identity3 } from './frame.js';
import { help } from './help.js';

/** @typedef {import('./frame.js').Vec3} Vec3 */
/** @typedef {import('./frame.js').Frame} Frame */
/** @typedef {import('./help.js').Member} Member */
/** Un punto: un Point3d, [x, y, z] o un objeto con x, y, z. @typedef {Point3d | Vec3 | number[] | { x: number, y: number, z: number }} PointLike */
/** Un vector, igual. @typedef {Vector3d | Vec3 | number[] | { x: number, y: number, z: number }} VectorLike */
/** Un eje: 'x', 'y', 'z' (del mundo) o un vector. @typedef {'x' | 'y' | 'z' | VectorLike} AxisLike */

const TOL = 1e-9;
/** -0 → 0, para que la consola no muestre "-0" en una medida. @param {number} v */
const clean = (v) => (v === 0 ? 0 : v);
/** Para mostrar: hasta 4 decimales, sin ceros de más. @param {number} v */
const fmt = (v) => String(Math.round(v * 1e4) / 1e4);

/**
 * Lleva cualquier forma de escribir un punto o vector a [x, y, z], o falla con un mensaje
 * que dice qué se esperaba.
 * @param {unknown} v @param {string} [what] @returns {Vec3}
 */
export function vec3(v, what = 'punto') {
  /** @type {unknown[] | null} */
  let a = null;
  if (Array.isArray(v)) a = v;
  else if (v && typeof v === 'object') {
    const o = /** @type {{ x?: unknown, y?: unknown, z?: unknown }} */ (v);
    a = [o.x, o.y, o.z];
  }
  if (!a || a.length !== 3 || a.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new TypeError(`${what} inválido: ${JSON.stringify(v)} (va [x, y, z] o un objeto con x, y, z)`);
  }
  return [/** @type {number} */ (a[0]), /** @type {number} */ (a[1]), /** @type {number} */ (a[2])];
}

// ---------------------------------------------------------------------------------------

export class Point3d {
  /** @param {number} [x] @param {number} [y] @param {number} [z] */
  constructor(x = 0, y = 0, z = 0) {
    const [a, b, c] = vec3([x, y, z], 'punto');
    /** @readonly */ this.x = clean(a);
    /** @readonly */ this.y = clean(b);
    /** @readonly */ this.z = clean(c);
    Object.freeze(this);
  }

  /** @param {PointLike} v @returns {Point3d} */
  static from(v) { return v instanceof Point3d ? v : new Point3d(...vec3(v, 'punto')); }
  static get origin() { return new Point3d(0, 0, 0); }

  /** @param {PointLike} p */
  distanceTo(p) { const q = Point3d.from(p); return Math.hypot(this.x - q.x, this.y - q.y, this.z - q.z); }
  /** El punto corrido por un vector. @param {VectorLike} v */
  add(v) { const w = Vector3d.from(v); return new Point3d(this.x + w.x, this.y + w.y, this.z + w.z); }
  /** El vector que va de `p` a este punto (como en Rhino: punto − punto = vector). @param {PointLike} p */
  subtract(p) { const q = Point3d.from(p); return new Vector3d(this.x - q.x, this.y - q.y, this.z - q.z); }
  /** @param {Transform} t @returns {Point3d} */
  transform(t) { return new Point3d(...applyFrame(Transform.check(t).frame, this.toArray())); }
  /** @param {PointLike} p @param {number} [tol] */
  equals(p, tol = TOL) { return this.distanceTo(p) <= tol; }
  /** @returns {Vec3} */
  toArray() { return [this.x, this.y, this.z]; }
  toString() { return `(${fmt(this.x)}, ${fmt(this.y)}, ${fmt(this.z)})`; }

  /** @param {{ print?: boolean }} [opts] */
  static help(opts) { return help('Point3d — un punto en el espacio', Point3d.members, opts); }
  /** @param {{ print?: boolean }} [opts] */
  help(opts) { return Point3d.help(opts); }

  /** @type {Member[]} */
  static members = [
    ['new Point3d(x, y, z)', 'un punto nuevo'],
    ['x  y  z', 'sus coordenadas (solo lectura)'],
    ['static from(v)', 'un Point3d a partir de [x, y, z] o de un objeto con x, y, z'],
    ['static origin', 'el (0, 0, 0)'],
    ['distanceTo(p)', 'la distancia a otro punto'],
    ['add(v)', 'el punto corrido por un vector'],
    ['subtract(p)', 'el Vector3d que va de p a este punto'],
    ['transform(t)', 'el punto transformado (devuelve uno nuevo)'],
    ['equals(p, tol?)', '¿es el mismo punto, con tolerancia?'],
    ['toArray()', '[x, y, z]'],
    ['toString()', 'para leer: (x, y, z)'],
    ['help()', 'esta tabla'],
    ['static help()', 'esta tabla, sin crear una instancia'],
  ];
}

// ---------------------------------------------------------------------------------------

export class Vector3d {
  /** @param {number} [x] @param {number} [y] @param {number} [z] */
  constructor(x = 0, y = 0, z = 0) {
    const [a, b, c] = vec3([x, y, z], 'vector');
    /** @readonly */ this.x = clean(a);
    /** @readonly */ this.y = clean(b);
    /** @readonly */ this.z = clean(c);
    Object.freeze(this);
  }

  /** @param {VectorLike} v @returns {Vector3d} */
  static from(v) { return v instanceof Vector3d ? v : new Vector3d(...vec3(v, 'vector')); }
  static get xAxis() { return new Vector3d(1, 0, 0); }
  static get yAxis() { return new Vector3d(0, 1, 0); }
  static get zAxis() { return new Vector3d(0, 0, 1); }

  get length() { return Math.hypot(this.x, this.y, this.z); }
  /** El mismo vector con largo 1. */
  unitize() {
    const n = this.length;
    if (!n) throw new Error('no se puede unitizar un vector nulo');
    return new Vector3d(this.x / n, this.y / n, this.z / n);
  }
  /** @param {number} s */
  multiply(s) { return new Vector3d(this.x * s, this.y * s, this.z * s); }
  /** @param {VectorLike} v */
  add(v) { const w = Vector3d.from(v); return new Vector3d(this.x + w.x, this.y + w.y, this.z + w.z); }
  reverse() { return new Vector3d(-this.x, -this.y, -this.z); }
  /** @param {VectorLike} v */
  dot(v) { const w = Vector3d.from(v); return this.x * w.x + this.y * w.y + this.z * w.z; }
  /** @param {VectorLike} v */
  cross(v) {
    const w = Vector3d.from(v);
    return new Vector3d(this.y * w.z - this.z * w.y, this.z * w.x - this.x * w.z, this.x * w.y - this.y * w.x);
  }
  /** El ángulo con otro vector, en grados (0 a 180). @param {VectorLike} v */
  angleTo(v) {
    const w = Vector3d.from(v);
    const c = this.dot(w) / (this.length * w.length);
    return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
  }
  /** Solo la rotación: un vector no tiene posición, así que trasladarlo no lo cambia. @param {Transform} t */
  transform(t) { return new Vector3d(...rotateVec(Transform.check(t).frame.r, this.toArray())); }
  /** @param {VectorLike} v @param {number} [tol] */
  equals(v, tol = TOL) { const w = Vector3d.from(v); return Math.hypot(this.x - w.x, this.y - w.y, this.z - w.z) <= tol; }
  /** @returns {Vec3} */
  toArray() { return [this.x, this.y, this.z]; }
  toString() { return `<${fmt(this.x)}, ${fmt(this.y)}, ${fmt(this.z)}>`; }

  /** @param {{ print?: boolean }} [opts] */
  static help(opts) { return help('Vector3d — una dirección con largo', Vector3d.members, opts); }
  /** @param {{ print?: boolean }} [opts] */
  help(opts) { return Vector3d.help(opts); }

  /** @type {Member[]} */
  static members = [
    ['new Vector3d(x, y, z)', 'un vector nuevo'],
    ['x  y  z', 'sus componentes (solo lectura)'],
    ['static from(v)', 'un Vector3d a partir de [x, y, z] o de un objeto con x, y, z'],
    ['static xAxis', 'el <1, 0, 0>'],
    ['static yAxis', 'el <0, 1, 0>'],
    ['static zAxis', 'el <0, 0, 1>'],
    ['length', 'su largo'],
    ['unitize()', 'el mismo vector con largo 1'],
    ['multiply(s)', 'el vector multiplicado por un número'],
    ['add(v)', 'la suma con otro vector'],
    ['reverse()', 'el vector al revés'],
    ['dot(v)', 'producto escalar'],
    ['cross(v)', 'producto vectorial: perpendicular a los dos'],
    ['angleTo(v)', 'el ángulo con otro vector, en grados'],
    ['transform(t)', 'el vector girado (la traslación no lo afecta)'],
    ['equals(v, tol?)', '¿es el mismo vector, con tolerancia?'],
    ['toArray()', '[x, y, z]'],
    ['toString()', 'para leer: <x, y, z>'],
    ['help()', 'esta tabla'],
    ['static help()', 'esta tabla, sin crear una instancia'],
  ];
}

// ---------------------------------------------------------------------------------------

export class Line {
  /** @param {PointLike} from @param {PointLike} to */
  constructor(from, to) {
    /** @readonly */ this.from = Point3d.from(from);
    /** @readonly */ this.to = Point3d.from(to);
    Object.freeze(this);
  }

  get length() { return this.from.distanceTo(this.to); }
  get direction() { return this.to.subtract(this.from); }
  get midpoint() { return new Point3d((this.from.x + this.to.x) / 2, (this.from.y + this.to.y) / 2, (this.from.z + this.to.z) / 2); }
  /** @param {Transform} t */
  transform(t) { return new Line(this.from.transform(t), this.to.transform(t)); }
  toString() { return `${this.from} → ${this.to}`; }

  /** @param {{ print?: boolean }} [opts] */
  static help(opts) { return help('Line — un segmento entre dos puntos', Line.members, opts); }
  /** @param {{ print?: boolean }} [opts] */
  help(opts) { return Line.help(opts); }

  /** @type {Member[]} */
  static members = [
    ['new Line(from, to)', 'un segmento nuevo'],
    ['from  to', 'sus dos puntas (Point3d)'],
    ['length', 'su largo'],
    ['direction', 'el Vector3d de from a to'],
    ['midpoint', 'el punto del medio'],
    ['transform(t)', 'el segmento transformado (devuelve uno nuevo)'],
    ['toString()', 'para leer'],
    ['help()', 'esta tabla'],
    ['static help()', 'esta tabla, sin crear una instancia'],
  ];
}

// ---------------------------------------------------------------------------------------

export class BoundingBox {
  /** @param {PointLike} min @param {PointLike} max */
  constructor(min, max) {
    /** @readonly */ this.min = Point3d.from(min);
    /** @readonly */ this.max = Point3d.from(max);
    Object.freeze(this);
  }

  /** La caja que encierra a todos los puntos. @param {readonly PointLike[]} points */
  static fromPoints(points) {
    if (!points.length) throw new Error('no hay puntos para encerrar');
    const ps = points.map((p) => Point3d.from(p));
    const k = /** @type {const} */ (['x', 'y', 'z']);
    const lo = k.map((c) => Math.min(...ps.map((p) => p[c])));
    const hi = k.map((c) => Math.max(...ps.map((p) => p[c])));
    return new BoundingBox(lo, hi);
  }

  get center() { return new Point3d((this.min.x + this.max.x) / 2, (this.min.y + this.max.y) / 2, (this.min.z + this.max.z) / 2); }
  /** De min a max: sus componentes son el ancho, el alto y la profundidad de la caja. */
  get diagonal() { return this.max.subtract(this.min); }
  /** Las 8 esquinas. */
  get corners() {
    /** @type {Point3d[]} */
    const out = [];
    for (const x of [this.min.x, this.max.x]) for (const y of [this.min.y, this.max.y]) for (const z of [this.min.z, this.max.z]) out.push(new Point3d(x, y, z));
    return Object.freeze(out);
  }
  /** @param {PointLike} p @param {number} [tol] */
  contains(p, tol = TOL) {
    const q = Point3d.from(p);
    return q.x >= this.min.x - tol && q.x <= this.max.x + tol && q.y >= this.min.y - tol && q.y <= this.max.y + tol
      && q.z >= this.min.z - tol && q.z <= this.max.z + tol;
  }
  /** @param {BoundingBox} b */
  union(b) { return BoundingBox.fromPoints([this.min, this.max, b.min, b.max]); }
  /** La caja que encierra a esta caja transformada. @param {Transform} t */
  transform(t) { return BoundingBox.fromPoints(this.corners.map((c) => c.transform(t))); }
  toString() { return `[${this.min} … ${this.max}]`; }

  /** @param {{ print?: boolean }} [opts] */
  static help(opts) { return help('BoundingBox — la caja alineada a los ejes que encierra algo', BoundingBox.members, opts); }
  /** @param {{ print?: boolean }} [opts] */
  help(opts) { return BoundingBox.help(opts); }

  /** @type {Member[]} */
  static members = [
    ['new BoundingBox(min, max)', 'una caja nueva'],
    ['min  max', 'sus dos esquinas opuestas (Point3d)'],
    ['static fromPoints(points)', 'la caja que encierra a todos los puntos'],
    ['center', 'el centro'],
    ['diagonal', 'de min a max: ancho, alto y profundidad'],
    ['corners', 'las 8 esquinas'],
    ['contains(p, tol?)', '¿el punto está adentro?'],
    ['union(b)', 'la caja que encierra a las dos'],
    ['transform(t)', 'la caja que encierra a esta, transformada'],
    ['toString()', 'para leer'],
    ['help()', 'esta tabla'],
    ['static help()', 'esta tabla, sin crear una instancia'],
  ];
}

// ---------------------------------------------------------------------------------------

export class Face {
  /**
   * Una cara plana de una pieza. `localAxis` y `localSide` dicen cuál es EN LA PIEZA (la +x
   * local sigue siendo la +x aunque la pieza esté girada), o son null si la cara no mira hacia
   * un eje de la pieza (un chanfle). Lo demás está en el espacio en que se pidió. `holes`: los
   * agujeros que tiene (la tapa de un caño).
   * @param {{ piece: string, localAxis: 'x' | 'y' | 'z' | null, localSide: 1 | -1 | null, normal: VectorLike, center: PointLike,
   *           vertices: PointLike[], holes?: PointLike[][] }} f
   */
  constructor({ piece, localAxis, localSide, normal, center, vertices, holes = [] }) {
    /** @readonly */ this.piece = piece;
    /** @readonly */ this.localAxis = localAxis;
    /** @readonly */ this.localSide = localSide;
    /** @readonly */ this.normal = Vector3d.from(normal);
    /** @readonly */ this.center = Point3d.from(center);
    /** @readonly */ this.vertices = Object.freeze(vertices.map((v) => Point3d.from(v)));
    /** @readonly */ this.holes = Object.freeze(holes.map((h) => Object.freeze(h.map((v) => Point3d.from(v)))));
    Object.freeze(this);
  }

  get edges() {
    return Object.freeze([this.vertices, ...this.holes].flatMap((l) => l.map((v, i) => new Line(v, l[(i + 1) % l.length]))));
  }
  /** Su superficie: la del contorno menos la de sus agujeros. */
  get area() {
    /** @param {readonly Point3d[]} l */
    const a = (l) => {
      let x = 0, y = 0, z = 0;
      for (let i = 0; i < l.length; i++) {
        const p = l[i], q = l[(i + 1) % l.length];
        x += p.y * q.z - p.z * q.y; y += p.z * q.x - p.x * q.z; z += p.x * q.y - p.y * q.x;
      }
      return Math.hypot(x, y, z) / 2;
    };
    return this.holes.reduce((s, h) => s - a(h), a(this.vertices));
  }
  /** @param {Transform} t */
  transform(t) {
    return new Face({
      piece: this.piece, localAxis: this.localAxis, localSide: this.localSide,
      normal: this.normal.transform(t), center: this.center.transform(t), vertices: this.vertices.map((v) => v.transform(t)),
      holes: this.holes.map((h) => h.map((v) => v.transform(t))),
    });
  }
  toString() { return this.localAxis ? `cara ${this.localSide && this.localSide > 0 ? '+' : '-'}${this.localAxis} de ${this.piece}, normal ${this.normal}` : `cara de ${this.piece}, normal ${this.normal}`; }

  /** @param {{ print?: boolean }} [opts] */
  static help(opts) { return help('Face — una cara de una pieza', Face.members, opts); }
  /** @param {{ print?: boolean }} [opts] */
  help(opts) { return Face.help(opts); }

  /** @type {Member[]} */
  static members = [
    ['piece', 'el id de la pieza'],
    ['localAxis  localSide', 'cuál cara es en la pieza: eje local y lado (+1 o -1); null si no mira hacia un eje'],
    ['normal', 'hacia dónde mira (Vector3d)'],
    ['center', 'su centro (Point3d)'],
    ['vertices', 'su contorno, en orden (4 esquinas en una caja)'],
    ['holes', 'sus agujeros: un contorno por agujero (vacío en una caja)'],
    ['edges', 'sus aristas (Line), las del contorno y las de los agujeros'],
    ['area', 'su superficie sin los agujeros, en unidades del documento al cuadrado'],
    ['transform(t)', 'la cara transformada (devuelve una nueva)'],
    ['toString()', 'para leer'],
    ['help()', 'esta tabla'],
    ['static help()', 'esta tabla, sin crear una instancia'],
  ];
}

// ---------------------------------------------------------------------------------------

/**
 * Por ahora, transformaciones rígidas: trasladar y girar, que es lo que se le hace a una
 * pieza de madera sin cambiarla. Escalar una pieza no es una transformación sino cambiarle
 * las medidas (resize), y espejar va a necesitar saber de qué mano es cada forma; las dos
 * llegan cuando haga falta, como constructores nuevos.
 */
export class Transform {
  /** @param {Frame} [f] */
  constructor(f = frame()) {
    /** @readonly @type {Frame} */
    this.frame = /** @type {Frame} */ (/** @type {unknown} */ (Object.freeze({ r: Object.freeze([...f.r]), t: Object.freeze([...f.t]) })));
    Object.freeze(this);
  }

  static identity() { return new Transform(); }

  /**
   * Trasladar. Con un argumento, por un vector; con dos, del punto `from` al punto `to`
   * (como Transform.Translation en Rhino, y como el mover de a dos clics).
   * @param {VectorLike | PointLike} a @param {PointLike} [b]
   */
  static translation(a, b) {
    const v = b === undefined ? Vector3d.from(a) : Point3d.from(b).subtract(Point3d.from(a));
    return new Transform(frame([v.x, v.y, v.z]));
  }

  /**
   * Girar `degrees` grados alrededor de un eje que pasa por `center`. Regla de la mano
   * derecha. El eje es 'x', 'y', 'z' (del mundo) o un vector cualquiera — por ejemplo una
   * dirección propia de una pieza: `pieza.directions.length`.
   * @param {number} degrees @param {AxisLike} [axis] @param {PointLike} [center]
   */
  static rotation(degrees, axis = 'z', center = [0, 0, 0]) {
    if (typeof degrees !== 'number' || !Number.isFinite(degrees)) throw new TypeError(`ángulo inválido: ${degrees} (va en grados)`);
    const ax = typeof axis === 'string' ? axis : vec3(axis, 'eje');
    return new Transform(turn(frame(), ax, degrees, vec3(center, 'centro')));
  }

  /**
   * El giro de un Euler XYZ en radianes, aplicado como `Rx · Ry · Rz` (primero z, después
   * y, al final x): la misma convención que `THREE.Euler 'XYZ'`. Sin traslación — para
   * crear una pieza ya orientada, pasalo junto con `center` a `addPiece`.
   * @param {VectorLike} radians
   */
  static fromEuler(radians) {
    return new Transform(frame([0, 0, 0], fromEuler(vec3(radians, 'Euler'))));
  }

  /**
   * Orient (como el de Grasshopper): la transformación rígida que lleva la cara `a` sobre la
   * cara `b`. Los centros coinciden; con `faceToward` (por defecto) quedan enfrentadas —se
   * tocan—, y si no, mirando para el mismo lado. El primer lado de `a` (su "ancho") queda a lo
   * largo del primer lado de `b`; `flip` lo gira 180° sobre la normal.
   * @param {Face} a @param {Face} b @param {{ faceToward?: boolean, flip?: boolean }} [opts]
   */
  static orient(a, b, { faceToward = true, flip = false } = {}) {
    /** @param {Face} f */
    const marco = (f) => {
      const n = f.normal.unitize();
      const e = f.vertices[1].subtract(f.vertices[0]);
      const u = e.add(n.multiply(-e.dot(n))).unitize();
      return { o: f.center, u, v: n.cross(u), n };
    };
    const A = marco(a), B = marco(b);
    const nT = faceToward ? B.n.reverse() : B.n;
    const uT = flip ? B.u.reverse() : B.u;
    const vT = nT.cross(uT);
    const T = [uT, vT, nT], S = [A.u, A.v, A.n];
    const k = /** @type {const} */ (['x', 'y', 'z']);
    // R = [uT vT nT] · [uA vA nA]ᵀ
    const r = /** @type {import('./frame.js').Mat3} */ ([0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => T.reduce((acc, w, m) => acc + w[k[i]] * S[m][k[j]], 0))));
    const R = mul3(r, identity3()); // asentada: los cuartos de vuelta quedan exactos
    const o = rotateVec(R, A.o.toArray());
    return new Transform(frame([B.o.x - o[0], B.o.y - o[1], B.o.z - o[2]], R));
  }

  /**
   * Aplica la transformación a todo lo del array: puntos, vectores, líneas, piezas,
   * ensambles. Devuelve lo transformado (valores nuevos, o las mismas partes). Si en el
   * array está un ensamble y también algo de adentro, lo de adentro no se mueve dos veces:
   * ya se mueve con el ensamble.
   * @template {{ transform: (t: Transform) => any }} T
   * @param {Transform} t @param {T[]} items @returns {T[]}
   */
  static apply(t, items) {
    Transform.check(t);
    const ids = new Set(items.map((x) => /** @type {{ id?: unknown }} */ (x).id).filter((id) => typeof id === 'string'));
    /** @param {any} x */
    const yaVa = (x) => { for (let p = x.parent; p; p = p.parent) if (ids.has(p.id)) return true; return false; };
    return items.map((x) => {
      if (!x || typeof x.transform !== 'function') throw new TypeError(`no se puede transformar ${String(x)}`);
      return 'parent' in x && yaVa(x) ? x : x.transform(t);
    });
  }

  /** @param {unknown} t @returns {Transform} */
  static check(t) {
    if (!(t instanceof Transform)) throw new TypeError('va un Transform (Transform.translation, Transform.rotation, …)');
    return t;
  }

  /** `this · other`: aplica primero `other` y después esta. @param {Transform} other */
  multiply(other) { return new Transform(compose(this.frame, Transform.check(other).frame)); }
  inverse() { return new Transform(invert(this.frame)); }
  /** ¿No hace nada? Con la misma tolerancia con que se asientan los giros (1e-9). */
  get isIdentity() { return this.frame.t.every((v) => Math.abs(v) <= TOL) && this.frame.r.every((v, i) => Math.abs(v - (i % 4 === 0 ? 1 : 0)) <= TOL); }
  /** ¿El giro es de cuartos de vuelta? Entonces lo que transforma queda alineado a los ejes, exacto. */
  get isQuarterTurn() { return isQuarterTurn(this.frame.r); }
  /** Cuánto traslada. */
  get translationVector() { return new Vector3d(...this.frame.t); }
  /** El giro como Euler XYZ en grados, para leer. */
  get eulerDegrees() {
    const [x, y, z] = toEuler(this.frame.r).map((a) => clean(Math.round(((a * 180) / Math.PI) * 1e6) / 1e6));
    return Object.freeze({ x, y, z });
  }
  toString() {
    const e = this.eulerDegrees;
    return `Transform(traslada ${this.translationVector}, gira x ${e.x}° y ${e.y}° z ${e.z}°)`;
  }

  /** @param {{ print?: boolean }} [opts] */
  static help(opts) { return help('Transform — mover y girar: el verbo común a toda geometría', Transform.members, opts); }
  /** @param {{ print?: boolean }} [opts] */
  help(opts) { return Transform.help(opts); }

  /** @type {Member[]} */
  static members = [
    ['static identity()', 'la que no hace nada'],
    ['static translation(v) / translation(from, to)', 'trasladar por un vector, o de un punto a otro'],
    ['static rotation(degrees, axis?, center?)', "girar en grados; eje 'x' | 'y' | 'z' o un vector; centro por defecto el origen"],
    ['static orient(faceA, faceB, { faceToward?, flip? })', 'lleva la cara A sobre la B (centros juntos, enfrentadas o del mismo lado); flip gira 180°'],
    ['static fromEuler(radians)', "el giro de un Euler XYZ en radianes (Rx · Ry · Rz), la convención 'XYZ' de three.js; sin traslación"],
    ['static apply(t, items)', 'aplicarla a todo un array (piezas, ensambles, puntos…)'],
    ['static check(t)', 'falla con un mensaje claro si t no es un Transform'],
    ['frame', 'la matriz por dentro: { r (3×3 por filas), t }'],
    ['multiply(other)', 'componer: primero other, después esta'],
    ['inverse()', 'la que deshace a esta'],
    ['isIdentity', '¿no hace nada?'],
    ['isQuarterTurn', '¿gira solo en cuartos de vuelta?'],
    ['translationVector', 'cuánto traslada (Vector3d)'],
    ['eulerDegrees', 'el giro como Euler XYZ, en grados'],
    ['toString()', 'para leer'],
    ['help()', 'esta tabla'],
    ['static help()', 'esta tabla, sin crear una instancia'],
  ];
}

// ---------------------------------------------------------------------------------------

/**
 * Una malla de triángulos: la forma que resulta de una pieza (el bruto con sus operaciones).
 * `positions` son las coordenadas x, y, z de cada vértice, una detrás de otra; `indices`, de a
 * tres, los vértices de cada triángulo, en sentido antihorario visto desde afuera. Es un valor:
 * `transform(t)` devuelve otra.
 *
 * Opcional: `surfaces` dice a qué superficie pertenece cada triángulo (los de una misma cara
 * comparten número) y `smooth[s]` si la superficie s aproxima una curva (un cilindro). De ahí
 * salen las aristas y los vértices de verdad; si no vienen (una malla de un kernel), se deducen.
 */
export class Mesh {
  /** @param {{ positions: ArrayLike<number>, indices: ArrayLike<number>, surfaces?: ArrayLike<number>, smooth?: ArrayLike<boolean> }} m */
  constructor({ positions, indices, surfaces, smooth }) {
    const pos = Array.from(positions ?? []), idx = Array.from(indices ?? []);
    if (pos.length % 3 || pos.some((v) => typeof v !== 'number' || !Number.isFinite(v))) throw new TypeError('malla inválida: positions va de a tres números (x, y, z)');
    const n = pos.length / 3;
    if (idx.length % 3 || idx.some((i) => !Number.isInteger(i) || i < 0 || i >= n)) throw new TypeError(`malla inválida: indices va de a tres, cada uno entre 0 y ${n - 1}`);
    /** @readonly */ this.positions = Object.freeze(pos);
    /** @readonly */ this.indices = Object.freeze(idx);
    /** @readonly @type {readonly number[] | null} */
    this.surfaces = null;
    /** @readonly @type {readonly boolean[] | null} */
    this.smooth = null;
    if (surfaces !== undefined && surfaces !== null) {
      const sf = Array.from(surfaces);
      if (sf.length !== idx.length / 3 || sf.some((v) => !Number.isInteger(v) || v < 0)) throw new TypeError('malla inválida: surfaces va un entero por triángulo');
      const sm = Array.from(smooth ?? []).map(Boolean);
      while (sm.length <= Math.max(-1, ...sf)) sm.push(false);
      this.surfaces = Object.freeze(sf);
      this.smooth = Object.freeze(sm);
    }
    Object.freeze(this);
  }

  /** Una Mesh a partir de cualquier { positions, indices } (lo que devuelve un kernel, p. ej.). @param {{ positions: ArrayLike<number>, indices: ArrayLike<number>, surfaces?: ArrayLike<number>, smooth?: ArrayLike<boolean> }} m */
  static from(m) { return m instanceof Mesh ? m : new Mesh(m); }

  get vertexCount() { return this.positions.length / 3; }
  get triangleCount() { return this.indices.length / 3; }
  /** El volumen que encierra (positivo si los triángulos miran hacia afuera). */
  get volume() {
    const p = this.positions, ix = this.indices;
    let v = 0;
    for (let k = 0; k < ix.length; k += 3) {
      const a = ix[k] * 3, b = ix[k + 1] * 3, c = ix[k + 2] * 3;
      v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
    return v / 6;
  }
  get boundingBox() {
    /** @type {Point3d[]} */
    const pts = [];
    for (let k = 0; k < this.positions.length; k += 3) pts.push(new Point3d(this.positions[k], this.positions[k + 1], this.positions[k + 2]));
    return BoundingBox.fromPoints(pts);
  }
  /** @param {Transform} t */
  transform(t) {
    const f = Transform.check(t).frame;
    /** @type {number[]} */
    const pos = [];
    for (let k = 0; k < this.positions.length; k += 3) pos.push(...applyFrame(f, [this.positions[k], this.positions[k + 1], this.positions[k + 2]]));
    return new Mesh({ positions: pos, indices: this.indices, surfaces: this.surfaces ?? undefined, smooth: this.smooth ?? undefined });
  }
  toString() { return `Mesh: ${this.triangleCount} triángulos, volumen ${fmt(this.volume)}`; }

  /** @param {{ print?: boolean }} [opts] */
  static help(opts) { return help('Mesh — una malla de triángulos: la forma que resulta de una pieza', Mesh.members, opts); }
  /** @param {{ print?: boolean }} [opts] */
  help(opts) { return Mesh.help(opts); }

  /** @type {Member[]} */
  static members = [
    ['new Mesh({ positions, indices })', 'una malla nueva'],
    ['positions', 'x, y, z de cada vértice, uno detrás de otro'],
    ['indices', 'de a tres: los vértices de cada triángulo, antihorario visto desde afuera'],
    ['surfaces', 'a qué superficie pertenece cada triángulo, o null si no se sabe'],
    ['smooth', 'por superficie: ¿aproxima una curva? (o null)'],
    ['static from(m)', 'una Mesh a partir de cualquier { positions, indices }'],
    ['vertexCount', 'cuántos vértices tiene'],
    ['triangleCount', 'cuántos triángulos tiene'],
    ['volume', 'el volumen que encierra'],
    ['boundingBox', 'la caja que la encierra'],
    ['transform(t)', 'la malla transformada (devuelve una nueva)'],
    ['toString()', 'para leer'],
    ['help()', 'esta tabla'],
    ['static help()', 'esta tabla, sin crear una instancia'],
  ];
}

// ---------------------------------------------------------------------------------------

/**
 * Dónde se tocan dos piezas que no se meten una en otra (ver contact.js). `kind` dice qué
 * se toca: 'face' (dos caras enfrentadas: `points` es el polígono donde se solapan, con su
 * área — ahí va la cola o el tornillo), 'edge' (una arista apoyada: `points` son sus dos
 * puntas) o 'point' (un vértice apoyado).
 */
export class Contact {
  /**
   * @param {{ kind: 'face' | 'edge' | 'point', a: string, b: string, points: PointLike[], area: number, normal: VectorLike,
   *           faceA: { localAxis: 'x' | 'y' | 'z', localSide: 1 | -1 } | null, faceB: { localAxis: 'x' | 'y' | 'z', localSide: 1 | -1 } | null }} c
   */
  constructor({ kind, a, b, points, area, normal, faceA, faceB }) {
    /** @readonly */ this.kind = kind;
    /** @readonly */ this.a = a;
    /** @readonly */ this.b = b;
    /** @readonly */ this.points = Object.freeze(points.map((p) => Point3d.from(p)));
    /** @readonly */ this.area = area;
    /** @readonly */ this.normal = Vector3d.from(normal);
    /** @readonly */ this.faceA = faceA ? Object.freeze({ ...faceA }) : null;
    /** @readonly */ this.faceB = faceB ? Object.freeze({ ...faceB }) : null;
    Object.freeze(this);
  }

  get center() {
    const n = this.points.length;
    return new Point3d(...[0, 1, 2].map((k) => this.points.reduce((s, p) => s + p.toArray()[k], 0) / n));
  }
  /** La arista de contacto, si es de arista. */
  get line() { return this.kind === 'edge' ? new Line(this.points[0], this.points[1]) : null; }
  /** @param {Transform} t */
  transform(t) {
    return new Contact({
      kind: this.kind, a: this.a, b: this.b, points: this.points.map((p) => p.transform(t)), area: this.area,
      normal: this.normal.transform(t), faceA: this.faceA, faceB: this.faceB,
    });
  }
  toString() {
    const que = this.kind === 'face' ? `cara, área ${fmt(this.area)}` : this.kind === 'edge' ? `arista de largo ${fmt(/** @type {Line} */ (this.line).length)}` : 'punto';
    return `${this.a} toca a ${this.b}: ${que}, en ${this.center}`;
  }

  /** @param {{ print?: boolean }} [opts] */
  static help(opts) { return help('Contact — dónde se tocan dos piezas', Contact.members, opts); }
  /** @param {{ print?: boolean }} [opts] */
  help(opts) { return Contact.help(opts); }

  /** @type {Member[]} */
  static members = [
    ['kind', "'face' (se tocan dos caras), 'edge' (una arista apoyada) o 'point' (un vértice)"],
    ['a  b', 'los ids de las dos piezas'],
    ['points', 'face: el polígono donde se solapan · edge: sus dos puntas · point: el punto'],
    ['area', 'la superficie de contacto, en unidades del documento al cuadrado (0 si es arista o punto)'],
    ['normal', 'hacia dónde mira el contacto, de a hacia b (Vector3d)'],
    ['faceA  faceB', 'cuál cara de cada pieza, en la pieza: { localAxis, localSide } (null si no es de cara)'],
    ['center', 'el centro del contacto'],
    ['line', 'la arista de contacto (Line), si es de arista; si no, null'],
    ['transform(t)', 'el contacto transformado (devuelve uno nuevo)'],
    ['toString()', 'para leer'],
    ['help()', 'esta tabla'],
    ['static help()', 'esta tabla, sin crear un contacto'],
  ];
}

/**
 * Lo que dos piezas comparten de volumen cuando se meten una en otra: un choque. Es un
 * sólido convexo: sus caras, sus vértices, su volumen y cuánto se meten (`depth`, en el
 * eje en que menos se meten — lo mínimo que habría que correr una para que dejen de chocar).
 */
export class Intersection {
  /** @param {{ a: string, b: string, volume: number, depth: number, vertices: PointLike[], faces: PointLike[][] }} i */
  constructor({ a, b, volume, depth, vertices, faces }) {
    /** @readonly */ this.a = a;
    /** @readonly */ this.b = b;
    /** @readonly */ this.volume = volume;
    /** @readonly */ this.depth = depth;
    /** @readonly */ this.vertices = Object.freeze(vertices.map((p) => Point3d.from(p)));
    /** @readonly */ this.faces = Object.freeze(faces.map((f) => Object.freeze(f.map((p) => Point3d.from(p)))));
    Object.freeze(this);
  }

  get boundingBox() { return BoundingBox.fromPoints(this.vertices); }
  /** @param {Transform} t */
  transform(t) {
    return new Intersection({
      a: this.a, b: this.b, volume: this.volume, depth: this.depth,
      vertices: this.vertices.map((p) => p.transform(t)), faces: this.faces.map((f) => f.map((p) => p.transform(t))),
    });
  }
  toString() { return `${this.a} se mete en ${this.b}: ${fmt(this.depth)} de profundidad, volumen ${fmt(this.volume)}`; }

  /** @param {{ print?: boolean }} [opts] */
  static help(opts) { return help('Intersection — dos piezas que se meten una en otra', Intersection.members, opts); }
  /** @param {{ print?: boolean }} [opts] */
  help(opts) { return Intersection.help(opts); }

  /** @type {Member[]} */
  static members = [
    ['a  b', 'los ids de las dos piezas'],
    ['volume', 'el volumen compartido, en unidades del documento al cubo'],
    ['depth', 'cuánto se meten: lo mínimo que habría que correr una (en unidades del documento)'],
    ['vertices', 'los vértices del sólido compartido'],
    ['faces', 'sus caras, como polígonos de Point3d'],
    ['boundingBox', 'la caja que lo encierra'],
    ['transform(t)', 'transformado (devuelve uno nuevo)'],
    ['toString()', 'para leer'],
    ['help()', 'esta tabla'],
    ['static help()', 'esta tabla, sin crear una'],
  ];
}
