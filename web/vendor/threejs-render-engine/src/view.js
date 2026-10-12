// La cámara como valores planos: el estado (posición, objetivo, arriba, fov, proyección, zoom) y
// la matemática de moverla — orbitar, desplazar, acercar, mirar —, los límites y la interpolación
// de las animaciones. El motor (index.js) la aplica a la cámara de three.
//
// En ortográfica la escala sale igual que en perspectiva: lo que mide `distance · tan(fov / 2)`
// en el plano del objetivo es media pantalla de alto. Así el cambio de proyección no salta, y
// acercar, desplazar y encuadrar son la misma cuenta (acercar achica esa distancia).
//
// Arriba es +y. Orbitar es girar la mesa: la guiñada (yaw) gira alrededor del eje vertical y el
// cabeceo (pitch) sube o baja la cámara sin inclinar el horizonte. Justo arriba o justo abajo
// (en los polos) no hay horizonte que diga hacia dónde queda la pantalla: lo dice `up`. En el
// resto, `up` es [0, 1, 0].
//
// Puro: no importa three ni DOM.

/** @typedef {[number, number, number]} Vec3 */
/** @typedef {'perspective' | 'orthographic'} Projection */
/** @typedef {{ position: Vec3, target: Vec3, up: Vec3, fov: number, projection: Projection, zoom: number }} ViewState */
/** @typedef {{ minDistance: number, maxDistance: number, minPitch: number, maxPitch: number, floor: number | null }} ViewLimits */

const RAD = Math.PI / 180;
/** Hasta dónde se considera que la cámara está en un polo (horizontal / distancia). */
const POLO = 1e-9;

/** Sin límites: la distancia libre, el cabeceo de −90° a 90° y sin piso. */
export const NO_LIMITS = /** @type {Readonly<ViewLimits>} */ (Object.freeze({ minDistance: 0, maxDistance: Infinity, minPitch: -90, maxPitch: 90, floor: null }));

/** Los easings de las animaciones. */
export const EASINGS = Object.freeze({
  linear: (/** @type {number} */ t) => t,
  'ease-in-out': (/** @type {number} */ t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  'ease-out': (/** @type {number} */ t) => 1 - (1 - t) ** 3,
});

// ---------- vectores (arrays de 3) ----------
/** @param {Vec3} a @param {Vec3} b @returns {Vec3} */ const suma = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** @param {Vec3} a @param {Vec3} b @returns {Vec3} */ const resta = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** @param {Vec3} a @param {number} k @returns {Vec3} */ const por = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
/** @param {Vec3} a @param {Vec3} b */ const punto = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** @param {Vec3} a @param {Vec3} b @returns {Vec3} */ const cruz = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** @param {Vec3} a */ const largo = (a) => Math.hypot(a[0], a[1], a[2]);
/** @param {Vec3} a @param {Vec3} b @param {number} t @returns {Vec3} */ const mezcla = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** v girado `ang` radianes alrededor del eje unitario `k` (Rodrigues). @param {Vec3} v @param {Vec3} k @param {number} ang @returns {Vec3} */
function girar(v, k, ang) {
  const c = Math.cos(ang), s = Math.sin(ang), kv = cruz(k, v), d = punto(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * d, v[1] * c + kv[1] * s + k[1] * d, v[2] * c + kv[2] * s + k[2] * d];
}
/** @param {number} x @param {number} a @param {number} b */ const entre = (x, a, b) => Math.min(b, Math.max(a, x));

/**
 * Un vector de 3 números finitos, copiado.
 * @param {unknown} v @param {string} nombre @returns {Vec3}
 */
export function vec3(v, nombre) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    throw new TypeError(`${nombre} va como [x, y, z] con números finitos (llegó ${JSON.stringify(v)})`);
  }
  return [v[0], v[1], v[2]];
}

/**
 * Dónde está la cámara en ángulos, alrededor del objetivo: distancia, guiñada y cabeceo (en
 * radianes), y la dirección horizontal `h` hacia la que se aleja. En un polo, `h` sale de `up`.
 * @param {ViewState} s
 */
export function angles(s) {
  const o = resta(s.position, s.target);
  const r = largo(o);
  if (!(r > 0)) throw new RangeError('la cámara y el objetivo están en el mismo punto');
  const pitch = Math.asin(entre(o[1] / r, -1, 1));
  const hl = Math.hypot(o[0], o[2]);
  /** @type {Vec3} */ let h;
  if (hl / r > POLO) h = [o[0] / hl, 0, o[2] / hl];
  else {
    // arriba, `up` apunta hacia donde la cámara deja de mirar (−h); abajo, hacia h
    const ul = Math.hypot(s.up[0], s.up[2]);
    const u = ul > 0 ? /** @type {Vec3} */ ([s.up[0] / ul, 0, s.up[2] / ul]) : /** @type {Vec3} */ ([0, 0, -1]);
    h = o[1] > 0 ? por(u, -1) : u;
  }
  return { distance: r, yaw: Math.atan2(h[0], h[2]), pitch, h };
}

/**
 * La posición y el `up` de una cámara a `distance` del objetivo, con esa guiñada y ese cabeceo.
 * @param {Vec3} target @param {number} distance @param {number} yaw @param {number} pitch
 * @returns {{ position: Vec3, up: Vec3 }}
 */
function desdeAngulos(target, distance, yaw, pitch) {
  /** @type {Vec3} */ const h = [Math.sin(yaw), 0, Math.cos(yaw)];
  if (Math.abs(pitch) >= Math.PI / 2 - 1e-12) {
    const arriba = pitch > 0;
    return { position: [target[0], target[1] + (arriba ? distance : -distance), target[2]], up: arriba ? por(h, -1) : h };
  }
  const c = Math.cos(pitch);
  return { position: suma(target, [h[0] * c * distance, Math.sin(pitch) * distance, h[2] * c * distance]), up: [0, 1, 0] };
}

/**
 * Hacia dónde mira la cámara: adelante, derecha y arriba de la pantalla, unitarios.
 * @param {ViewState} s
 */
export function basis(s) {
  const { pitch, h } = angles(s);
  /** @type {Vec3} */ const right = [h[2], 0, -h[0]];
  const c = Math.cos(pitch), sn = Math.sin(pitch);
  /** @type {Vec3} */ const up = [-sn * h[0], c, -sn * h[2]];
  /** @type {Vec3} */ const forward = [-c * h[0], -sn, -c * h[2]];
  return { forward, right, up };
}

/** El `up` que corresponde: [0, 1, 0], o el de la pantalla en un polo. @param {ViewState} s @returns {ViewState} */
function conUp(s) {
  const a = angles(s);
  return { ...s, up: desdeAngulos(s.target, a.distance, a.yaw, a.pitch).up };
}

/**
 * Lleva el estado dentro de los límites: la distancia, el cabeceo y el piso.
 * @param {ViewState} s @param {ViewLimits} [limits] @returns {ViewState}
 */
export function constrain(s, limits = NO_LIMITS) {
  const a = angles(s);
  const r = entre(a.distance, limits.minDistance, limits.maxDistance);
  const p = entre(a.pitch, limits.minPitch * RAD, limits.maxPitch * RAD);
  // adentro de los límites queda tal cual, sin el redondeo de pasar por los ángulos
  if (r === a.distance && p === a.pitch && (limits.floor === null || s.position[1] >= limits.floor)) return s;
  let out = { ...s, ...desdeAngulos(s.target, r, a.yaw, p) };
  if (limits.floor !== null && out.position[1] < limits.floor) {
    out = conUp({ ...out, position: [out.position[0], limits.floor, out.position[2]] });
  }
  return out;
}

/**
 * De `a` hacia `b`, lo más que deja el piso: posición y objetivo se mueven en línea recta, así
 * que alcanza con ver en qué fracción la cámara llega al piso. Si ya estaba abajo, deja subir.
 * @param {ViewState} a @param {ViewState} b @param {ViewLimits} limits @returns {ViewState}
 */
function hastaElPiso(a, b, limits) {
  const f = limits.floor;
  const y0 = a.position[1], y1 = b.position[1];
  if (f === null || y1 >= f || y1 >= y0) return b;
  const t = entre((f - y0) / (y1 - y0), 0, 1);
  if (t <= 0) return a;
  return conUp({ ...b, position: mezcla(a.position, b.position, t), target: mezcla(a.target, b.target, t) });
}

/**
 * Orbitar: guiñada y cabeceo en grados. La guiñada positiva lleva la cámara a su derecha; el
 * cabeceo positivo, hacia arriba. Gira alrededor de `around` (por defecto el objetivo): si es
 * otro punto, el objetivo gira con la cámara, y ese punto queda quieto en la pantalla.
 * @param {ViewState} s @param {number} dYaw @param {number} dPitch
 * @param {{ around?: Vec3, limits?: ViewLimits }} [opts] @returns {ViewState}
 */
export function orbit(s, dYaw, dPitch, { around, limits = NO_LIMITS } = {}) {
  if (!Number.isFinite(dYaw) || !Number.isFinite(dPitch)) throw new TypeError('orbit(yaw, pitch) va en grados, con números finitos');
  const a = angles(s);
  // si ya está afuera de los límites, solo se deja volver hacia adentro
  const pMin = Math.min(limits.minPitch * RAD, a.pitch), pMax = Math.max(limits.maxPitch * RAD, a.pitch);
  const dy = dYaw * RAD;

  /** @param {number} dp */
  const girado = (dp) => {
    const yaw = a.yaw + dy, pitch = entre(a.pitch + dp, pMin, pMax);
    const real = pitch - a.pitch;
    let target = s.target;
    if (around) {
      const c = vec3(around, 'around');
      /** @type {Vec3} */ const derecha = [Math.cos(yaw), 0, -Math.sin(yaw)];
      // el mismo giro que hace la cámara alrededor del objetivo: guiñada en el eje vertical y
      // cabeceo en el eje derecho (girar +ang alrededor de la derecha baja la cámara)
      target = suma(c, girar(girar(resta(s.target, c), [0, 1, 0], dy), derecha, -real));
    }
    return /** @type {ViewState} */ ({ ...s, target, ...desdeAngulos(target, a.distance, yaw, pitch) });
  };

  const fin = girado(dPitch * RAD);
  const f = limits.floor;
  if (f === null || fin.position[1] >= f || fin.position[1] >= s.position[1]) return fin;
  // el piso corta el cabeceo: la fracción más grande que lo respeta (bisección)
  let lo = 0, hi = 1;
  for (let i = 0; i < 48; i++) { const m = (lo + hi) / 2; if (girado(dPitch * RAD * m).position[1] >= f) lo = m; else hi = m; }
  return girado(dPitch * RAD * lo);
}

/**
 * Desplazar la cámara y el objetivo en el plano de la pantalla, en unidades de la escena: `dx`
 * positivo hacia la derecha de la pantalla, `dy` positivo hacia arriba.
 * @param {ViewState} s @param {number} dx @param {number} dy @param {{ limits?: ViewLimits }} [opts] @returns {ViewState}
 */
export function pan(s, dx, dy, { limits = NO_LIMITS } = {}) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new TypeError('pan(dx, dy) va con números finitos');
  const b = basis(s);
  const d = suma(por(b.right, dx), por(b.up, dy));
  return hastaElPiso(s, { ...s, position: suma(s.position, d), target: suma(s.target, d) }, limits);
}

/**
 * Avanzar hacia el objetivo (o retroceder, con `distance` negativa), sin pasarlo.
 * @param {ViewState} s @param {number} distance @param {{ limits?: ViewLimits }} [opts] @returns {ViewState}
 */
export function dolly(s, distance, { limits = NO_LIMITS } = {}) {
  if (!Number.isFinite(distance)) throw new TypeError('dolly(distancia) va con un número finito');
  const a = angles(s);
  return zoom(s, a.distance / Math.max(a.distance - distance, a.distance * 1e-9), { limits });
}

/**
 * Acercar: `factor` 2 deja todo el doble de grande en la pantalla, 0.5 la mitad: la cámara se
 * acerca al objetivo. Con `at` (un punto de la pantalla en
 * coordenadas normalizadas, de −1 a 1, y hacia arriba), lo que está bajo ese punto, en el plano
 * del objetivo, queda bajo ese punto. `aspect` (ancho / alto) hace falta solo con `at`.
 * @param {ViewState} s @param {number} factor
 * @param {{ at?: [number, number], aspect?: number, limits?: ViewLimits }} [opts] @returns {ViewState}
 */
export function zoom(s, factor, { at, aspect = 1, limits = NO_LIMITS } = {}) {
  if (!(factor > 0) || !Number.isFinite(factor)) throw new RangeError(`zoom(factor) va con un número mayor que 0 (llegó ${factor})`);
  const a = angles(s);
  /** @type {Vec3} */ let centro = s.target;
  if (at) {
    const b = basis(s);
    const medio = a.distance * Math.tan((s.fov * RAD) / 2);
    centro = suma(s.target, suma(por(b.right, at[0] * medio * aspect), por(b.up, at[1] * medio)));
  }
  // una homotecia con centro en `centro`: el rayo de la cámara a ese punto no cambia, y el
  // punto se queda en el mismo lugar de la pantalla
  const r = entre(a.distance / factor, Math.max(limits.minDistance, a.distance * 1e-9), limits.maxDistance);
  const k = r / a.distance;
  const fin = { ...s, position: suma(centro, por(resta(s.position, centro), k)), target: suma(centro, por(resta(s.target, centro), k)) };
  return hastaElPiso(s, fin, limits);
}

/**
 * Mirar a un punto sin mover la cámara.
 * @param {ViewState} s @param {Vec3} point @param {{ limits?: ViewLimits }} [opts] @returns {ViewState}
 */
export function lookAt(s, point, { limits = NO_LIMITS } = {}) {
  const p = vec3(point, 'lookAt(punto)');
  if (largo(resta(p, s.position)) === 0) throw new RangeError('lookAt: el punto es donde está la cámara');
  const a = angles(s);
  // en un polo, la pantalla sigue mirando para el mismo lado
  const out = conUp({ ...s, target: p, up: desdeAngulos(p, 1, a.yaw, a.pitch).up });
  const b = angles(out);
  const pitch = entre(b.pitch, limits.minPitch * RAD, limits.maxPitch * RAD);
  if (pitch === b.pitch) return out;
  // el cabeceo quedó afuera de los límites: se corrige moviendo el objetivo, no la cámara
  const target = resta(s.position, desdeAngulos([0, 0, 0], b.distance, b.yaw, pitch).position);
  return conUp({ ...out, target });
}

/**
 * Entre dos estados, en `t` (0 a 1): el objetivo en línea recta, la distancia y el zoom en
 * escala logarítmica, y la guiñada por el camino corto. Así la cámara gira alrededor de lo que
 * mira, como al orbitar, sin inclinar el horizonte.
 * @param {ViewState} a @param {ViewState} b @param {number} t @returns {ViewState}
 */
export function interpolate(a, b, t) {
  if (t <= 0) return clone(a);
  if (t >= 1) return clone(b);
  const A = angles(a), B = angles(b);
  let dy = (B.yaw - A.yaw) % (2 * Math.PI);
  if (dy > Math.PI) dy -= 2 * Math.PI;
  if (dy < -Math.PI) dy += 2 * Math.PI;
  const target = mezcla(a.target, b.target, t);
  const distance = A.distance * (B.distance / A.distance) ** t;
  return {
    ...desdeAngulos(target, distance, A.yaw + dy * t, A.pitch + (B.pitch - A.pitch) * t),
    target,
    fov: a.fov + (b.fov - a.fov) * t,
    projection: a.projection,
    zoom: a.zoom * (b.zoom / a.zoom) ** t,
  };
}

/**
 * Un easing por nombre (ver EASINGS).
 * @param {string} name
 */
export function easing(name) {
  const e = /** @type {Record<string, (t: number) => number>} */ (EASINGS)[name];
  if (!e) throw new Error(`easing desconocido: ${name} (van ${Object.keys(EASINGS).join(', ')})`);
  return e;
}

/**
 * Un estado con lo que se pasa encima de `base`: lo que no se pasa queda como está. Valida
 * todo y ajusta `up` (solo cuenta en los polos).
 * @param {ViewState} base @param {Partial<ViewState>} over @returns {ViewState}
 */
export function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) throw new TypeError('set() va con un objeto: { position, target, up, fov }');
  const conocidas = ['position', 'target', 'up', 'fov', 'projection', 'zoom'];
  for (const k of Object.keys(over)) if (!conocidas.includes(k)) throw new Error(`clave de vista desconocida: ${k} (van ${conocidas.join(', ')})`);
  /** @type {ViewState} */
  const s = clone(base);
  if (over.position !== undefined) s.position = vec3(over.position, 'position');
  if (over.target !== undefined) s.target = vec3(over.target, 'target');
  if (over.up !== undefined) s.up = vec3(over.up, 'up');
  if (over.fov !== undefined) {
    if (!(over.fov > 0 && over.fov < 180)) throw new RangeError(`fov va en grados, entre 0 y 180 (llegó ${over.fov})`);
    s.fov = over.fov;
  }
  if (over.projection !== undefined) {
    if (over.projection !== 'perspective' && over.projection !== 'orthographic') throw new Error(`proyección desconocida: ${over.projection} (van 'perspective', 'orthographic')`);
    s.projection = over.projection;
  }
  if (over.zoom !== undefined) {
    if (!(over.zoom > 0) || !Number.isFinite(over.zoom)) throw new RangeError(`zoom va mayor que 0 (llegó ${over.zoom})`);
    s.zoom = over.zoom;
  }
  return conUp(s);
}

/**
 * Los límites con lo que se pasa encima. `floor`: la altura mínima de la cámara, o null.
 * @param {ViewLimits} base @param {Partial<ViewLimits>} over @returns {ViewLimits}
 */
export function mergeLimits(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (!(k in NO_LIMITS)) throw new Error(`límite desconocido: ${k} (van ${Object.keys(NO_LIMITS).join(', ')})`);
    if (k === 'floor') { if (v !== null && !Number.isFinite(v)) throw new TypeError('floor va como una altura o null'); }
    else if (typeof v !== 'number' || Number.isNaN(v)) throw new TypeError(`${k} va como un número`);
    /** @type {Record<string, unknown>} */ (out)[k] = v;
  }
  if (out.minDistance < 0 || out.minDistance > out.maxDistance) throw new RangeError('las distancias van 0 ≤ minDistance ≤ maxDistance');
  if (out.minPitch < -90 || out.maxPitch > 90 || out.minPitch > out.maxPitch) throw new RangeError('el cabeceo va −90 ≤ minPitch ≤ maxPitch ≤ 90');
  return out;
}

/** Una copia (los arrays nuevos). @param {ViewState} s @returns {ViewState} */
export function clone(s) {
  return { position: [...s.position], target: [...s.target], up: [...s.up], fov: s.fov, projection: s.projection, zoom: s.zoom };
}

/** ¿Son la misma vista, salvo `eps` (relativo a la distancia)? @param {ViewState} a @param {ViewState} b */
export function sameView(a, b, eps = 1e-9) {
  const r = Math.max(largo(resta(a.position, a.target)), 1e-12);
  const cerca = (/** @type {Vec3} */ x, /** @type {Vec3} */ y, /** @type {number} */ k) => largo(resta(x, y)) <= eps * k;
  return cerca(a.position, b.position, r) && cerca(a.target, b.target, r) && cerca(a.up, b.up, 1)
    && Math.abs(a.fov - b.fov) <= eps * 180 && a.projection === b.projection && Math.abs(a.zoom - b.zoom) <= eps * a.zoom;
}

// ---------- vistas con nombre y encuadre ----------

/** @typedef {{ dir: Vec3, up: Vec3 }} ViewDirection */
/** @typedef {{ min: Vec3, max: Vec3 }} Box */

/**
 * Las vistas con nombre: `dir` es de qué lado del objetivo se pone la cámara (front: en +z,
 * mirando hacia −z) y `up`, hacia dónde queda arriba la pantalla. Arriba y abajo tienen su propio
 * `up`: son exactas, sin ángulos mágicos. Para vistas propias (un ViewCube, una esquina), go()
 * acepta también un { dir, up }.
 */
export const VIEWS = /** @type {Readonly<Record<string, Readonly<ViewDirection>>>} */ (Object.freeze({
  front: Object.freeze({ dir: [0, 0, 1], up: [0, 1, 0] }),
  back: Object.freeze({ dir: [0, 0, -1], up: [0, 1, 0] }),
  right: Object.freeze({ dir: [1, 0, 0], up: [0, 1, 0] }),
  left: Object.freeze({ dir: [-1, 0, 0], up: [0, 1, 0] }),
  top: Object.freeze({ dir: [0, 1, 0], up: [0, 0, -1] }),
  bottom: Object.freeze({ dir: [0, -1, 0], up: [0, 0, 1] }),
  iso: Object.freeze({ dir: [1, 0.8, 1], up: [0, 1, 0] }),
}));

/**
 * Una vista: un nombre de VIEWS o un { dir, up } (up solo cuenta en los polos).
 * @param {string | ViewDirection} v @returns {ViewDirection}
 */
export function viewDirection(v) {
  if (typeof v === 'string') {
    const found = VIEWS[v];
    if (!found) throw new Error(`vista desconocida: ${v} (van ${Object.keys(VIEWS).join(', ')}, o un { dir, up })`);
    return { dir: [...found.dir], up: [...found.up] };
  }
  if (!v || typeof v !== 'object') throw new TypeError("la vista va como un nombre ('front', 'top', …) o un { dir, up }");
  const dir = vec3(v.dir, 'dir');
  if (!(largo(dir) > 0)) throw new RangeError('dir no puede ser [0, 0, 0]');
  return { dir, up: v.up === undefined ? [0, 1, 0] : vec3(v.up, 'up') };
}

/**
 * Una caja { min, max } de arrays, validada. Una caja vacía (min > max en algún eje) da null.
 * @param {unknown} b @returns {Box | null}
 */
export function box(b) {
  if (!b || typeof b !== 'object') throw new TypeError('la caja va como { min: [x, y, z], max: [x, y, z] }');
  const { min, max } = /** @type {{ min: unknown, max: unknown }} */ (b);
  const lo = vec3(min, 'min'), hi = vec3(max, 'max');
  return lo.every((x, i) => x <= hi[i]) ? { min: lo, max: hi } : null;
}

/**
 * A qué distancia del centro de la caja, mirando desde `dir`, entra la caja entera en la
 * pantalla: los 8 vértices, con el fov que limite (el vertical o el horizontal, según el aspecto)
 * y con `margin` (1.15: la caja ocupa 1/1.15 de la pantalla en el eje que más la llena). `near`:
 * lo más cerca que puede quedar el vértice más cercano. En ortográfica la profundidad no cuenta.
 * @param {Box} b @param {Vec3} dir @param {Vec3} up
 * @param {{ fov: number, aspect: number, margin?: number, near?: number, projection?: Projection }} o
 */
export function fitDistance(b, dir, up, { fov, aspect, margin = 1.15, near = 0, projection = 'perspective' }) {
  if (!(margin > 0)) throw new RangeError(`margin va mayor que 0 (llegó ${margin})`);
  if (!(aspect > 0)) throw new RangeError(`aspect va mayor que 0 (llegó ${aspect})`);
  const c = mezcla(b.min, b.max, 0.5);
  // la base de la cámara para esa vista: la misma que usa orbitar
  const s = conUp(/** @type {ViewState} */ ({ position: suma(c, por(dir, 1 / largo(dir))), target: c, up, fov, projection: 'perspective', zoom: 1 }));
  const { right, up: arriba, forward } = basis(s);
  const tv = Math.tan((fov * RAD) / 2), th = tv * aspect;
  let d = 0, delante = -Infinity;
  for (let i = 0; i < 8; i++) {
    const p = /** @type {Vec3} */ ([i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]]);
    const q = resta(p, c);
    // la cámara está en c − forward·d: la profundidad del vértice es d + q·forward
    const z = projection === 'orthographic' ? 0 : punto(q, forward);
    d = Math.max(d, (Math.abs(punto(q, right)) * margin) / th - z, (Math.abs(punto(q, arriba)) * margin) / tv - z);
    delante = Math.max(delante, -z);
  }
  return projection === 'orthographic' ? d : Math.max(d, delante + near);
}

/**
 * Encuadrar una caja: el centro de la caja al centro de la pantalla y la caja entera adentro.
 * Sin `view`, desde la dirección en la que ya mira la cámara; con `view`, desde esa vista.
 * @param {ViewState} s @param {Box} b
 * @param {{ aspect: number, margin?: number, near?: number, view?: string | ViewDirection, limits?: ViewLimits }} o
 * @returns {ViewState}
 */
export function fit(s, b, { aspect, margin, near, view, limits = NO_LIMITS }) {
  const v = view === undefined ? null : viewDirection(view);
  const a = angles(s);
  const dir = v ? v.dir : resta(s.position, s.target);
  // en un polo, la pantalla sigue mirando para el mismo lado (o para el de la vista)
  const up = v ? v.up : desdeAngulos(s.target, 1, a.yaw, a.pitch).up;
  const c = mezcla(b.min, b.max, 0.5);
  const d = fitDistance(b, dir, up, { fov: s.fov, aspect, margin, near, projection: s.projection });
  const out = conUp({ ...s, target: c, position: suma(c, por(dir, d / largo(dir))), up });
  return constrain(out, limits);
}

/**
 * Ir a una vista sin encuadrar: la misma distancia y el mismo objetivo, desde otro lado.
 * @param {ViewState} s @param {string | ViewDirection} view @param {{ limits?: ViewLimits }} [o] @returns {ViewState}
 */
export function go(s, view, { limits = NO_LIMITS } = {}) {
  const v = viewDirection(view);
  const r = angles(s).distance;
  return constrain(conUp({ ...s, position: suma(s.target, por(v.dir, r / largo(v.dir))), up: v.up }), limits);
}

// ---------- de la pantalla al mundo y del mundo a la pantalla ----------

/**
 * El rayo que sale por un punto de la pantalla (normalizado, de −1 a 1, y hacia arriba). En
 * perspectiva sale de la cámara; en ortográfica, del plano de la cámara, todos paralelos.
 * @param {ViewState} s @param {[number, number]} at @param {number} aspect
 * @returns {{ origin: Vec3, dir: Vec3 }}
 */
export function ray(s, at, aspect) {
  const { forward, right, up } = basis(s);
  const t = Math.tan((s.fov * RAD) / 2);
  if (s.projection === 'orthographic') {
    const medio = angles(s).distance * t;
    return { origin: suma(s.position, suma(por(right, at[0] * medio * aspect), por(up, at[1] * medio))), dir: forward };
  }
  const d = suma(forward, suma(por(right, at[0] * t * aspect), por(up, at[1] * t)));
  return { origin: [...s.position], dir: por(d, 1 / largo(d)) };
}

/**
 * Dónde cae un punto del mundo en la pantalla (normalizado, de −1 a 1, y hacia arriba), y a qué
 * profundidad: la distancia a lo largo de la vista desde la cámara (negativa: está detrás).
 * @param {ViewState} s @param {Vec3} p @param {number} aspect @returns {[number, number, number]}
 */
export function project(s, p, aspect) {
  const { forward, right, up } = basis(s);
  const q = resta(p, s.position);
  const z = punto(q, forward);
  const t = Math.tan((s.fov * RAD) / 2);
  const medio = s.projection === 'orthographic' ? angles(s).distance * t : z * t;
  return [punto(q, right) / (medio * aspect), punto(q, up) / medio, z];
}

/**
 * Cuántas unidades de la escena mide un píxel del visor en ese punto: en perspectiva depende de
 * la profundidad; en ortográfica es la misma en todos lados. Lo que necesita una manija de
 * tamaño constante en pantalla.
 * @param {ViewState} s @param {Vec3} p @param {number} heightPx
 */
export function worldPerPixel(s, p, heightPx) {
  const t = Math.tan((s.fov * RAD) / 2);
  const z = s.projection === 'orthographic' ? angles(s).distance : punto(resta(p, s.position), basis(s).forward);
  return (2 * Math.abs(z) * t) / Math.max(1, heightPx);
}
