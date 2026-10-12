// Colocación: lo que hace cómodo armar a mano. Pegar un borde a otro (imán), sacar una pieza de
// un choque, apoyarla sobre lo que tiene abajo y mostrar con qué quedó alineada.
//
// Son funciones PURAS que PROPONEN: devuelven una traslación (y qué la causó) y no tocan nada.
// La app decide si la aplica, por ejemplo durante un arrastre. Trabajan con cajas orientadas
// (las de contact.js), así que andan con piezas giradas. Lo que se mueve puede ser un grupo:
// todo se calcula para el grupo entero, que se mueve junto.
//
// Las distancias (el imán, la grilla, el piso) son parámetros: decisiones de la app. Los valores
// sugeridos están en config.js.
//
// Puro: no importa three ni DOM.

/** @typedef {import('./frame.js').Vec3} Vec3 */
/** @typedef {import('./contact.js').OBB} OBB */

/** @param {Vec3} a @param {Vec3} b */ const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** @param {Vec3} a @param {Vec3} b @returns {Vec3} */ const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** @param {Vec3} a @param {number} s @returns {Vec3} */ const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
/** @param {Vec3} a @param {Vec3} b @returns {Vec3} */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** @param {Vec3} a */ const len = (a) => Math.hypot(a[0], a[1], a[2]);

/** Una caja corrida. @param {OBB} b @param {Vec3} t @returns {OBB} */
const corrida = (b, t) => ({ ...b, c: add(b.c, t) });

/** Lo que ocupa una caja sobre un eje. @param {OBB} b @param {Vec3} L @returns {[number, number]} */
function intervalo(b, L) {
  const c = dot(b.c, L), r = b.h[0] * Math.abs(dot(b.ax[0], L)) + b.h[1] * Math.abs(dot(b.ax[1], L)) + b.h[2] * Math.abs(dot(b.ax[2], L));
  return [c - r, c + r];
}

/** Las caras de una caja como planos: normal hacia afuera y `d` (n·x = d). @param {OBB} b */
function caras(b) {
  /** @type {{ n: Vec3, d: number }[]} */
  const out = [];
  for (let i = 0; i < 3; i++) for (const s of [1, -1]) {
    const n = mul(b.ax[i], s);
    out.push({ n, d: dot(n, b.c) + b.h[i] });
  }
  return out;
}

/** La caja alineada al mundo de un grupo. @param {readonly OBB[]} bs */
function cajaMundo(bs) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const b of bs) for (let k = 0; k < 3; k++) {
    const e = /** @type {Vec3} */ ([0, 0, 0]);
    e[k] = 1;
    const [a, c] = intervalo(b, e);
    lo[k] = Math.min(lo[k], a);
    hi[k] = Math.max(hi[k], c);
  }
  return { lo, hi };
}

/** ¿Las cajas mundo de dos grupos quedan a `d` o menos? @param {readonly OBB[]} as @param {readonly OBB[]} bs @param {number} d */
function cerca(as, bs, d) {
  const A = cajaMundo(as), B = cajaMundo(bs);
  return [0, 1, 2].every((k) => A.lo[k] <= B.hi[k] + d && B.lo[k] <= A.hi[k] + d);
}

/** Los 15 ejes separadores de dos cajas (sin repetir). @param {OBB} a @param {OBB} b @returns {Vec3[]} */
function ejes(a, b) {
  /** @type {Vec3[]} */
  const out = [];
  const agrega = (/** @type {Vec3} */ L) => { if (!out.some((w) => Math.abs(dot(w, L)) > 1 - 1e-9)) out.push(L); };
  for (const x of [...a.ax, ...b.ax]) agrega(x);
  for (const x of a.ax) for (const y of b.ax) {
    const c = cross(x, y), m = len(c);
    if (m > 1e-9) agrega(mul(c, 1 / m));
  }
  return out;
}

/**
 * La traslación t de norma mínima que cumple n_i·t = δ_i para las direcciones elegidas.
 * @param {readonly Vec3[]} N @param {readonly number[]} D @returns {Vec3}
 */
function resolver(N, D) {
  const k = N.length;
  if (!k) return [0, 0, 0];
  // t = Nᵀ (N Nᵀ)⁻¹ δ, con N de 1 a 3 filas
  const G = N.map((a) => N.map((b) => dot(a, b)));
  const x = gauss(G, [...D]);
  return N.reduce((t, n, i) => add(t, mul(n, x[i])), /** @type {Vec3} */ ([0, 0, 0]));
}

/** Resuelve G x = b (G chica, simétrica, invertible). @param {number[][]} G @param {number[]} b */
function gauss(G, b) {
  const n = b.length, A = G.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = A[r][i] / A[i][i];
      for (let c = i; c <= n; c++) A[r][c] -= f * A[i][c];
    }
  }
  return A.map((r, i) => r[n] / r[i]);
}

/**
 * Imán: la traslación que pega las caras del grupo a las caras paralelas de otras piezas que
 * estén a `distance` o menos — enfrentadas (se tocan) o del mismo lado (quedan al ras). Hasta tres
 * direcciones independientes, las más cercanas primero. Con `grid`, en los ejes del mundo que el
 * imán no tocó, la esquina del grupo cae sobre la grilla.
 * @param {readonly OBB[]} moving @param {readonly OBB[]} others
 * Con `axis` (unitario), el grupo solo puede correr a lo largo de esa dirección: se elige UNA
 * cara (la que queda a menos recorrido) y la traslación es múltiplo de `axis`; la grilla solo
 * actúa si `axis` es un eje del mundo.
 * @param {{ distance: number, grid?: number | null, axis?: Vec3 | null }} opts
 * @returns {{ t: Vec3, snaps: { normal: Vec3, delta: number, other: string, kind: 'face' | 'flush' }[] } | null}
 */
export function snapMove(moving, others, { distance, grid = null, axis = null }) {
  /** @type {{ normal: Vec3, delta: number, other: string, kind: 'face' | 'flush' }[]} */
  const candidatos = [];
  for (const b of others) {
    if (!cerca(moving, [b], distance)) continue;
    for (const a of moving) for (const fa of caras(a)) for (const fb of caras(b)) {
      const c = dot(fa.n, fb.n);
      if (c < -1 + 1e-9) candidatos.push({ normal: fa.n, delta: -fb.d - fa.d, other: b.id, kind: 'face' });
      else if (c > 1 - 1e-9) candidatos.push({ normal: fa.n, delta: fb.d - fa.d, other: b.id, kind: 'flush' });
    }
  }
  if (axis) return snapAlong(moving, candidatos, axis, { distance, grid });
  const validos = candidatos.filter((c) => Math.abs(c.delta) <= distance).sort((x, y) => Math.abs(x.delta) - Math.abs(y.delta));
  /** @type {typeof validos} */
  const elegidos = [];
  for (const c of validos) {
    if (elegidos.length === 3) break;
    // independiente de las ya elegidas (una normal y su opuesta son la misma dirección)
    const N = [...elegidos.map((e) => e.normal), c.normal];
    const det = N.length === 1 ? 1 : N.length === 2 ? len(cross(N[0], N[1])) : Math.abs(dot(N[0], cross(N[1], N[2])));
    if (det > 1e-6) elegidos.push(c);
  }
  let t = resolver(elegidos.map((e) => e.normal), elegidos.map((e) => e.delta));
  if (grid && grid > 0) {
    const lo = cajaMundo(moving.map((b) => corrida(b, t))).lo;
    for (let k = 0; k < 3; k++) {
      if (elegidos.some((e) => Math.abs(e.normal[k]) > 1 - 1e-9)) continue; // ese eje ya lo puso el imán
      const d = Math.round(lo[k] / grid) * grid - lo[k];
      if (Math.abs(d) > 1e-12) t = add(t, /** @type {Vec3} */ ([0, 1, 2].map((i) => (i === k ? d : 0))));
    }
  }
  if (!elegidos.length && len(t) === 0) return null;
  return { t, snaps: elegidos };
}

/**
 * El imán sobre una sola dirección: de cada cara candidata, cuánto hay que correr a lo largo de
 * `axis` para que quede pegada (o al ras); gana la de menor recorrido.
 * @param {readonly OBB[]} moving
 * @param {{ normal: Vec3, delta: number, other: string, kind: 'face' | 'flush' }[]} candidatos
 * @param {Vec3} axis @param {{ distance: number, grid: number | null }} opts
 * @returns {{ t: Vec3, snaps: { normal: Vec3, delta: number, other: string, kind: 'face' | 'flush' }[] } | null}
 */
function snapAlong(moving, candidatos, axis, { distance, grid }) {
  const con = candidatos
    .map((c) => ({ c, s: Math.abs(dot(c.normal, axis)) > 1e-9 ? c.delta / dot(c.normal, axis) : NaN }))
    .filter((x) => Math.abs(x.s) <= distance)
    .sort((x, y) => Math.abs(x.s) - Math.abs(y.s));
  if (con.length) return { t: mul(axis, con[0].s), snaps: [con[0].c] };
  const k = [0, 1, 2].find((i) => Math.abs(axis[i]) > 1 - 1e-9);
  if (grid && grid > 0 && k !== undefined) {
    const lo = cajaMundo(moving).lo[k];
    const d = Math.round(lo / grid) * grid - lo;
    if (Math.abs(d) > 1e-12) return { t: mul(axis, d * Math.sign(axis[k])), snaps: [] };
  }
  return null;
}

/**
 * Si el grupo está metido en otras piezas, la traslación que lo saca por el lado de menor
 * penetración (las cajas quedan tocándose, sin meterse). Itera, por si al salir de una entra en
 * otra. Con `floor`, nunca deja al grupo por debajo del piso (en la dirección `up`): elige otro
 * lado.
 * @param {readonly OBB[]} moving @param {readonly OBB[]} others
 * @param {{ up: Vec3, floor?: number | null, scale: number }} opts
 * @returns {{ t: Vec3, from: string[] } | null}
 */
export function pushOutMove(moving, others, { up, floor = null, scale }) {
  const eps = 1e-9 * scale;
  /** @type {Vec3} */
  let t = [0, 0, 0];
  /** @type {Set<string>} */
  const de = new Set();
  for (let vuelta = 0; vuelta < 16; vuelta++) {
    const mov = moving.map((b) => corrida(b, t));
    /** @type {{ b: OBB, salidas: { m: Vec3, d: number }[] } | null} */
    let peor = null, peorD = eps;
    for (const a of mov) for (const b of others) {
      // por cada eje, las dos salidas: hacia un lado y hacia el otro (si el piso prohíbe una, queda la otra)
      /** @type {{ m: Vec3, d: number }[]} */
      const salidas = [];
      let depth = Infinity;
      for (const L of ejes(a, b)) {
        const [a0, a1] = intervalo(a, L), [b0, b1] = intervalo(b, L);
        depth = Math.min(depth, a1 - b0, b1 - a0);
        salidas.push({ m: mul(L, b1 - a0), d: Math.abs(b1 - a0) }, { m: mul(L, -(a1 - b0)), d: Math.abs(a1 - b0) });
      }
      if (depth > peorD) { peorD = depth; peor = { b, salidas: salidas.sort((x, y) => x.d - y.d) }; }
    }
    if (!peor) break;
    const p = peor;
    const ok = p.salidas.find((s) => {
      if (floor === null) return true;
      const abajo = Math.min(...mov.map((b) => intervalo(corrida(b, s.m), up)[0]));
      return abajo >= floor - eps;
    });
    if (!ok) break;
    t = add(t, ok.m);
    de.add(p.b.id);
  }
  return de.size ? { t, from: [...de] } : null;
}

/**
 * Cuánto baja el grupo (en la dirección contraria a `up`) hasta apoyarse sobre algo o sobre el
 * piso: el primer contacto de las cajas al barrerlas hacia abajo.
 * @param {readonly OBB[]} moving @param {readonly OBB[]} others
 * @param {{ up: Vec3, floor?: number | null }} opts
 * @returns {{ distance: number, on: string | null } | null} on: la pieza donde apoya, o null si es el piso
 */
export function dropMove(moving, others, { up, floor = null }) {
  const dir = mul(up, -1);
  let mejor = Infinity;
  /** @type {string | null} */
  let sobre = null;
  if (floor !== null) mejor = Math.max(0, Math.min(...moving.map((b) => intervalo(b, up)[0])) - floor);
  for (const a of moving) for (const b of others) {
    let entra = -Infinity, sale = Infinity;
    for (const L of ejes(a, b)) {
      const v = dot(dir, L);
      const [a0, a1] = intervalo(a, L), [b0, b1] = intervalo(b, L);
      if (Math.abs(v) < 1e-12) {
        if (a1 <= b0 || b1 <= a0) { entra = Infinity; break; } // separados en un eje que el movimiento no cambia
        continue;
      }
      const t0 = v > 0 ? (b0 - a1) / v : (b1 - a0) / v;
      const t1 = v > 0 ? (b1 - a0) / v : (b0 - a1) / v;
      entra = Math.max(entra, t0);
      sale = Math.min(sale, t1);
    }
    if (entra === Infinity || entra > sale || sale < 0) continue;
    const t = Math.max(0, entra);
    if (t < mejor) { mejor = t; sobre = b.id; }
  }
  return mejor === Infinity ? null : { distance: mejor, on: sobre };
}

/**
 * Los planos de otras piezas con los que una cara del grupo quedó alineada (a `tolerance` o
 * menos): enfrentados (se tocan) o del mismo lado (al ras). Sin repetir, los más cercanos primero.
 * @param {readonly OBB[]} moving @param {readonly OBB[]} others @param {{ tolerance: number }} opts
 * @returns {{ normal: Vec3, offset: number, other: string, kind: 'face' | 'flush', gap: number }[]}
 */
export function guides(moving, others, { tolerance }) {
  /** @type {ReturnType<typeof guides>} */
  const out = [];
  for (const b of others) for (const a of moving) for (const fa of caras(a)) for (const fb of caras(b)) {
    const c = dot(fa.n, fb.n);
    const kind = c < -1 + 1e-9 ? 'face' : c > 1 - 1e-9 ? 'flush' : null;
    if (!kind) continue;
    const gap = kind === 'face' ? -fb.d - fa.d : fb.d - fa.d;
    if (Math.abs(gap) > tolerance) continue;
    const offset = kind === 'face' ? -fb.d : fb.d; // el plano, escrito con la normal de la cara del grupo: n·x = offset
    if (out.some((g) => dot(g.normal, fa.n) > 1 - 1e-9 && Math.abs(g.offset - offset) <= 1e-9 * Math.max(1, Math.abs(offset)))) continue;
    out.push({ normal: fa.n, offset, other: b.id, kind, gap });
  }
  return out.sort((x, y) => Math.abs(x.gap) - Math.abs(y.gap));
}
