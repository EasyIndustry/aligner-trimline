// Polígonos en el plano: área, si es simple, triangulación (también con agujeros) y partición
// en polígonos convexos. Es lo que necesitan las secciones de los perfiles, los contornos de
// los cortes y las caras de las piezas.
//
// Puro: no importa three ni DOM.

/** @typedef {[number, number]} Vec2 */

/** Área con signo: positiva si va antihorario. @param {readonly Vec2[]} poly */
export function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** (a − o) × (b − o): positivo si o → a → b dobla a la izquierda. @param {Vec2} o @param {Vec2} a @param {Vec2} b */
export const cross2 = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** ¿Se cruzan los segmentos ab y cd en un punto interior de los dos? @param {Vec2} a @param {Vec2} b @param {Vec2} c @param {Vec2} d */
export function segmentsCross(a, b, c, d) {
  const s = (/** @type {number} */ v) => (Math.abs(v) < 1e-15 ? 0 : Math.sign(v));
  return s(cross2(a, b, c)) * s(cross2(a, b, d)) < 0 && s(cross2(c, d, a)) * s(cross2(c, d, b)) < 0;
}

/** ¿El polígono no se cruza consigo mismo? @param {readonly Vec2[]} poly */
export function isSimple(poly) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (segmentsCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return false;
    }
  }
  return true;
}

/** ¿El punto está adentro del polígono (sin contar el borde)? @param {Vec2} p @param {readonly Vec2[]} poly */
export function pointInPolygon(p, poly) {
  let dentro = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

/** La escala del polígono, para que las tolerancias no dependan de la unidad. @param {readonly Vec2[]} pts */
const escala = (pts) => {
  let m = 0;
  for (const [x, y] of pts) m = Math.max(m, Math.abs(x), Math.abs(y));
  return m || 1;
};

/**
 * Une cada agujero al contorno de afuera con un puente (un corte de ancho cero), y deja un
 * solo anillo que se puede triangular como un polígono simple.
 * @param {number[]} anillo índices del contorno, antihorario @param {number[]} hueco índices del agujero, horario
 * @param {readonly Vec2[]} P @returns {number[]}
 */
function puentear(anillo, hueco, P) {
  // M: el punto del agujero más a la derecha; desde ahí, un rayo hacia +x
  let mi = 0;
  for (let k = 1; k < hueco.length; k++) if (P[hueco[k]][0] > P[hueco[mi]][0]) mi = k;
  const M = P[hueco[mi]];
  let mejorX = Infinity, borde = -1;
  for (let k = 0; k < anillo.length; k++) {
    const a = P[anillo[k]], b = P[anillo[(k + 1) % anillo.length]];
    if ((a[1] - M[1]) * (b[1] - M[1]) > 0 || a[1] === b[1]) continue;
    const x = a[0] + ((M[1] - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
    if (x >= M[0] && x < mejorX) { mejorX = x; borde = k; }
  }
  if (borde < 0) throw new Error('sección inválida: un agujero queda afuera del contorno');
  const ka = borde, kb = (borde + 1) % anillo.length;
  // el extremo del borde más a la derecha; si algún vértice cóncavo tapa la vista, el de menor ángulo
  let pk = P[anillo[ka]][0] > P[anillo[kb]][0] ? ka : kb;
  /** @type {Vec2} */ const I = [mejorX, M[1]];
  const Pp = P[anillo[pk]];
  let mejor = Infinity;
  for (let k = 0; k < anillo.length; k++) {
    const q = P[anillo[k]];
    if (k === pk) continue;
    const prev = P[anillo[(k + anillo.length - 1) % anillo.length]], next = P[anillo[(k + 1) % anillo.length]];
    if (cross2(prev, q, next) >= 0) continue; // solo los cóncavos pueden tapar
    const enTri = cross2(M, I, q) * cross2(M, I, Pp) >= 0 && cross2(I, Pp, q) * cross2(I, Pp, M) >= 0 && cross2(Pp, M, q) * cross2(Pp, M, I) >= 0;
    if (!enTri) continue;
    const ang = Math.atan2(Math.abs(q[1] - M[1]), q[0] - M[0]);
    if (ang < mejor) { mejor = ang; pk = k; }
  }
  const rotado = [...hueco.slice(mi), ...hueco.slice(0, mi)];
  return [...anillo.slice(0, pk + 1), ...rotado, hueco[mi], anillo[pk], ...anillo.slice(pk + 1)];
}

/**
 * Recorte de orejas sobre un anillo de índices (que puede repetir índices: los puentes).
 * @param {number[]} anillo @param {readonly Vec2[]} P @returns {[number, number, number][]}
 */
function orejas(anillo, P) {
  const eps = 1e-12 * escala(P) ** 2;
  const idx = [...anillo];
  /** @type {[number, number, number][]} */
  const out = [];
  while (idx.length > 3) {
    let corte = -1;
    for (let i = 0; i < idx.length && corte < 0; i++) {
      const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      const [pa, pb, pc] = [P[a], P[b], P[c]];
      if (cross2(pa, pb, pc) <= eps) continue;
      let tapa = false;
      for (const j of idx) {
        if (j === a || j === b || j === c) continue;
        const q = P[j];
        if ((q[0] === pa[0] && q[1] === pa[1]) || (q[0] === pb[0] && q[1] === pb[1]) || (q[0] === pc[0] && q[1] === pc[1])) continue;
        if (cross2(pa, pb, q) >= -eps && cross2(pb, pc, q) >= -eps && cross2(pc, pa, q) >= -eps) { tapa = true; break; }
      }
      if (tapa) continue;
      corte = i;
      out.push([a, b, c]);
    }
    if (corte >= 0) { idx.splice(corte, 1); continue; }
    // no hay oreja: queda un vértice alineado o un pico de ancho cero (un puente); se saca
    const k = idx.findIndex((b, i) => Math.abs(cross2(P[idx[(i + idx.length - 1) % idx.length]], P[b], P[idx[(i + 1) % idx.length]])) <= eps);
    if (k < 0) throw new Error('polígono inválido: no se puede triangular (¿se cruza consigo mismo?)');
    idx.splice(k, 1);
  }
  if (idx.length === 3 && cross2(P[idx[0]], P[idx[1]], P[idx[2]]) > eps) out.push([idx[0], idx[1], idx[2]]);
  return out;
}

/**
 * Triangula un polígono simple con agujeros. Devuelve todos los puntos (el contorno primero,
 * antihorario; después cada agujero, horario) y los triángulos, antihorarios, como índices.
 * @param {readonly Vec2[]} outer @param {readonly (readonly Vec2[])[]} [holes]
 * @returns {{ points: Vec2[], triangles: [number, number, number][], loops: number[][] }}
 *   `loops`: los índices de cada contorno (el de afuera primero), para saber qué es borde.
 */
export function triangulate(outer, holes = []) {
  const o = signedArea(outer) >= 0 ? [...outer] : [...outer].reverse();
  const hs = holes.map((h) => (signedArea(h) <= 0 ? [...h] : [...h].reverse()));
  /** @type {Vec2[]} */
  const points = [...o, ...hs.flat()];
  /** @type {number[][]} */
  const loops = [o.map((_, i) => i)];
  let off = o.length;
  for (const h of hs) { loops.push(h.map((_, i) => off + i)); off += h.length; }
  let anillo = loops[0];
  const huecos = loops.slice(1).sort((a, b) => Math.max(...b.map((i) => points[i][0])) - Math.max(...a.map((i) => points[i][0])));
  for (const h of huecos) anillo = puentear(anillo, h, points);
  return { points, triangles: orejas(anillo, points), loops };
}

/**
 * Parte un polígono (con agujeros) en polígonos convexos: triangula y junta triángulos vecinos
 * mientras el resultado siga convexo (Hertel–Mehlhorn). Cada parte va antihoraria, como índices
 * de `points`.
 * @param {readonly Vec2[]} outer @param {readonly (readonly Vec2[])[]} [holes]
 * @returns {{ points: Vec2[], parts: number[][], loops: number[][] }}
 */
export function convexPartition(outer, holes = []) {
  const { points, triangles, loops } = triangulate(outer, holes);
  const eps = 1e-12 * escala(points) ** 2;
  /** @type {number[][]} */
  let partes = triangles.map((t) => [...t]);
  const esConvexo = (/** @type {number[]} */ r) => r.every((b, i) => cross2(points[r[(i + r.length - 1) % r.length]], points[b], points[r[(i + 1) % r.length]]) >= -eps);
  for (let junto = true; junto;) {
    junto = false;
    for (let i = 0; i < partes.length && !junto; i++) {
      for (let j = i + 1; j < partes.length && !junto; j++) {
        const A = partes[i], B = partes[j];
        // una arista a→b de A que en B va b→a
        for (let x = 0; x < A.length && !junto; x++) {
          const a = A[x], b = A[(x + 1) % A.length];
          const y = B.findIndex((v, k) => v === b && B[(k + 1) % B.length] === a);
          if (y < 0) continue;
          // A sin la arista, siguiendo por B: a … (resto de A) … b, después B desde a hasta b
          const restoA = [...A.slice(x + 1), ...A.slice(0, x + 1)];               // b … a
          const restoB = [...B.slice(y + 1), ...B.slice(0, y + 1)];               // a … b
          const unida = [...restoA.slice(0, -1), ...restoB.slice(0, -1)];
          if (unida.length < 3 || !esConvexo(unida)) continue;
          partes = partes.filter((_, k) => k !== i && k !== j);
          partes.push(unida);
          junto = true;
        }
      }
    }
  }
  return { points, parts: partes, loops };
}
