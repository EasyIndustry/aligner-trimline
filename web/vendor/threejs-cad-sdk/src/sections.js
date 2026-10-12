// Las formas de un bruto que no es una caja: perfiles (una sección extruida) y torneados (un
// contorno que gira alrededor de un eje).
//
//   { kind: 'profile', axis, section, params? }
//       una sección 2D extruida a lo largo de `axis` (0, 1, 2: x, y, z locales). La sección
//       llena las medidas de la pieza en los otros dos ejes y se calcula con ellas, así que al
//       estirar la pieza la sección se estira y lo que es espesor (la pared) se mantiene.
//       `section` es el nombre de una función de sección: las de SECTIONS (genéricas) o las que
//       registre la app (`createWorkshop({ sections })`). `params.turn` (0, 90, 180, 270) gira
//       la sección dentro de su rectángulo.
//   { kind: 'lathe', axis, contour }
//       un contorno [r, y] que gira alrededor de `axis`: r de 0 a 1 (del eje al borde de la
//       pieza) e y de 0 a 1 (de una punta a la otra), con y que no decrece. Se estira con la
//       pieza.
//
// Una sección es { outer, holes? }: contornos { points: [u, v][], smooth? } en la unidad del
// documento, centrados. `smooth: true` dice que el contorno aproxima una curva (un círculo):
// sus tramos no son aristas de verdad, y un contacto contra esa superficie es una línea.
//
// El catálogo (nombres comerciales, medidas, íconos) es de la app: acá están las familias
// geométricas, que sirven a cualquiera.
//
// Puro: no importa three ni DOM.
import { signedArea, isSimple, pointInPolygon } from './polygon.js';

/** @typedef {[number, number]} Vec2 */
/** @typedef {{ points: Vec2[], smooth?: boolean }} Loop */
/** @typedef {{ outer: Loop, holes?: Loop[] }} Section */
/** @typedef {(params: Record<string, any>, width: number, height: number) => Section} SectionFn */
/** @typedef {{ kind: 'profile', axis: 0 | 1 | 2, section: string, params?: Record<string, any> }} ProfileShape */
/** @typedef {{ kind: 'lathe', axis: 0 | 1 | 2, contour: Vec2[] }} LatheShape */
/** @typedef {ProfileShape | LatheShape} Shape */

/** Cuántos lados tiene el polígono con que se aproxima un círculo. */
export const CIRCLE_SIDES = 32;

/** Una elipse (un círculo si rx = ry), antihoraria, con un vértice en cada eje. @param {number} rx @param {number} ry @returns {Vec2[]} */
export const ellipse = (rx, ry) => Array.from({ length: CIRCLE_SIDES }, (_, i) => {
  const a = (2 * Math.PI * i) / CIRCLE_SIDES;
  return /** @type {Vec2} */ ([rx * Math.cos(a), ry * Math.sin(a)]);
});
/** @param {number} w @param {number} h @returns {Vec2[]} */
const rect = (w, h) => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];

/** @param {Record<string, any>} params @param {number} w @param {number} h */
function pared(params, w, h) {
  const t = params.wall;
  if (typeof t !== 'number' || !(t > 0) || t >= Math.min(w, h) / 2) throw new RangeError(`pared inválida: ${String(t)} (va mayor que 0 y menor que la mitad del lado más corto, ${Math.min(w, h) / 2})`);
  return t;
}

/**
 * Las secciones genéricas. Cada una recibe sus parámetros y el ancho y el alto que tiene que
 * llenar, y devuelve la sección centrada.
 * @type {Readonly<Record<string, SectionFn>>}
 */
export const SECTIONS = Object.freeze({
  /** Tubo rectangular: pared `wall`. */
  'rect-tube': (p, w, h) => { const t = pared(p, w, h); return { outer: { points: rect(w, h) }, holes: [{ points: rect(w - 2 * t, h - 2 * t) }] }; },
  /** Tubo redondo (elíptico si el ancho y el alto difieren): pared `wall`. */
  'round-tube': (p, w, h) => { const t = pared(p, w, h); return { outer: { points: ellipse(w / 2, h / 2), smooth: true }, holes: [{ points: ellipse(w / 2 - t, h / 2 - t), smooth: true }] }; },
  /** Barra redonda (elíptica si el ancho y el alto difieren). */
  'round-bar': (_p, w, h) => ({ outer: { points: ellipse(w / 2, h / 2), smooth: true } }),
  /** Ángulo (L): las alas abajo y a la izquierda, de espesor `wall`. */
  angle: (p, w, h) => {
    const t = pared(p, w, h), x = w / 2, y = h / 2;
    return { outer: { points: [[-x, -y], [x, -y], [x, -y + t], [-x + t, -y + t], [-x + t, y], [-x, y]] } };
  },
  /** Canal (U): abierto hacia arriba, de espesor `wall`. */
  channel: (p, w, h) => {
    const t = pared(p, w, h), x = w / 2, y = h / 2;
    return { outer: { points: [[-x, -y], [x, -y], [x, y], [x - t, y], [x - t, -y + t], [-x + t, -y + t], [-x + t, y], [-x, y]] } };
  },
  /** T: el ala arriba, el alma en el medio, de espesor `wall`. */
  tee: (p, w, h) => {
    const t = pared(p, w, h), x = w / 2, y = h / 2;
    return { outer: { points: [[-t / 2, -y], [t / 2, -y], [t / 2, y - t], [x, y - t], [x, y], [-x, y], [-x, y - t], [-t / 2, y - t]] } };
  },
});

/** @param {unknown} a */
const eje = (a) => {
  if (a !== 0 && a !== 1 && a !== 2) throw new TypeError(`eje inválido: ${String(a)} (va 0, 1 o 2: x, y o z de la pieza)`);
  return /** @type {0 | 1 | 2} */ (a);
};

/**
 * Revisa la forma de un bruto y la devuelve limpia. null es una caja.
 * @param {unknown} shape @returns {Shape | null}
 */
export function checkShape(shape) {
  if (shape === null || shape === undefined) return null;
  if (typeof shape !== 'object') throw new TypeError('forma inválida: va { kind: \'profile\' | \'lathe\', … } o null');
  const s = /** @type {Record<string, any>} */ (shape);
  if (s.kind === 'profile') {
    const axis = eje(s.axis);
    if (typeof s.section !== 'string' || !s.section) throw new TypeError('perfil inválido: va section, el nombre de una sección (ver SECTIONS)');
    /** @type {ProfileShape} */
    const out = { kind: 'profile', axis, section: s.section };
    if (s.params !== undefined) {
      if (!s.params || typeof s.params !== 'object' || Array.isArray(s.params)) throw new TypeError('perfil inválido: params va como un objeto');
      const turn = s.params.turn;
      if (turn !== undefined && ![0, 90, 180, 270].includes(turn)) throw new RangeError(`perfil inválido: turn ${String(turn)} (va 0, 90, 180 o 270)`);
      out.params = JSON.parse(JSON.stringify(s.params));
    }
    return out;
  }
  if (s.kind === 'lathe') {
    const axis = eje(s.axis);
    if (!Array.isArray(s.contour) || s.contour.length < 2) throw new TypeError('torneado inválido: el contorno va con al menos 2 puntos [r, y]');
    /** @type {Vec2[]} */
    const contour = s.contour.map((/** @type {unknown} */ p, /** @type {number} */ i) => {
      if (!Array.isArray(p) || p.length !== 2 || p.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) {
        throw new RangeError(`torneado inválido: punto ${i} ${JSON.stringify(p)} (va [r, y], de 0 a 1)`);
      }
      return /** @type {Vec2} */ ([p[0], p[1]]);
    });
    for (let i = 1; i < contour.length; i++) if (contour[i][1] < contour[i - 1][1]) throw new RangeError('torneado inválido: y no puede decrecer (el contorno va de una punta a la otra)');
    if (Math.abs(signedArea(cerrarTorneado(contour))) < 1e-9) throw new RangeError('torneado inválido: el contorno no encierra nada con el eje');
    return { kind: 'lathe', axis, contour };
  }
  throw new TypeError(`forma desconocida: ${String(s.kind)} (van 'profile' o 'lathe')`);
}

/** El contorno de un torneado, cerrado por el eje: de (0, y₀) a (0, yₙ). @param {readonly Vec2[]} contour @returns {Vec2[]} */
export function cerrarTorneado(contour) {
  /** @type {Vec2[]} */
  const out = [];
  if (contour[0][0] > 0) out.push([0, contour[0][1]]);
  out.push(...contour.map((p) => /** @type {Vec2} */ ([...p])));
  if (contour[contour.length - 1][0] > 0) out.push([0, contour[contour.length - 1][1]]);
  return out;
}

/** @param {Loop} loop @param {string} que */
function checkLoop(loop, que) {
  if (!loop || !Array.isArray(loop.points) || loop.points.length < 3) throw new TypeError(`sección inválida: ${que} va con al menos 3 puntos`);
  if (loop.points.some((p) => !Array.isArray(p) || p.length !== 2 || p.some((v) => typeof v !== 'number' || !Number.isFinite(v)))) throw new TypeError(`sección inválida: ${que} va con puntos [u, v]`);
  if (!isSimple(loop.points) || Math.abs(signedArea(loop.points)) < 1e-12) throw new RangeError(`sección inválida: ${que} se cruza consigo mismo o no encierra área`);
}

/**
 * La sección de un perfil, para una pieza de medidas `size`.
 * @param {ProfileShape} shape @param {readonly number[]} size @param {Readonly<Record<string, SectionFn>>} registro
 * @returns {{ outer: Loop, holes: Loop[] }}
 */
export function resolveSection(shape, size, registro) {
  const fn = registro[shape.section];
  if (!fn) throw new Error(`sección desconocida: ${shape.section} (hay ${Object.keys(registro).join(', ')}; las de la app se registran con createWorkshop({ sections }))`);
  const [u, v] = [0, 1, 2].filter((k) => k !== shape.axis);
  const params = shape.params ?? {};
  const turn = params.turn ?? 0;
  const deLado = turn === 90 || turn === 270;
  const s = fn(params, deLado ? size[v] : size[u], deLado ? size[u] : size[v]);
  checkLoop(s.outer, 'el contorno');
  const holes = s.holes ?? [];
  holes.forEach((h, i) => {
    checkLoop(h, `el agujero ${i}`);
    if (!h.points.every((p) => pointInPolygon(p, s.outer.points))) throw new RangeError(`sección inválida: el agujero ${i} se sale del contorno`);
  });
  const c = Math.cos((turn * Math.PI) / 180), sn = Math.sin((turn * Math.PI) / 180);
  /** @param {Loop} l @returns {Loop} */
  const gira = (l) => ({ points: l.points.map(([x, y]) => /** @type {Vec2} */ ([Math.round((c * x - sn * y) * 1e12) / 1e12, Math.round((sn * x + c * y) * 1e12) / 1e12])), smooth: !!l.smooth });
  return { outer: gira(s.outer), holes: holes.map(gira) };
}
