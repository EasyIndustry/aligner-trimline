// Los presets: cómo se ve una escena — fondo, luces, piso, grilla, contornos y el entorno del
// render final. Lo que cuesta GPU (antialiasing, tamaño de las sombras, prender el AO o el bloom,
// muestras del render) no está acá: es la CALIDAD (quality.js). Son DATOS: un cliente nuevo es un preset nuevo (o uno que pisa algunos valores
// de otro), no código.
//
// `camera` es cómo se siente el visor: cuánto dura una animación de la cámara (ms), con qué
// easing, la inercia al soltar el mouse (damping, 0 sin inercia) y cuánto aire deja el encuadre
// alrededor de lo encuadrado (margin: 1.15, lo encuadrado ocupa 1/1.15 de la pantalla).
//
// El radio del AO (y las distancias) van en función de `area` (el radio de la zona de trabajo, en la unidad de la
// escena), así el mismo preset sirve en cm, en mm o en m: el motor escala sombras, grilla y
// niebla con ella.
//
// Puro: no importa three ni DOM.

/**
 * @typedef {{
 *   background: string,
 *   sky: { top: string, bottom: string } | null,
 *   fog: { near: number, far: number } | null,
 *   exposure: number,
 *   environment: { intensity: number },
 *   hemisphere: { sky: string, ground: string, intensity: number },
 *   sun: { color: string, intensity: number, direction: [number, number, number], shadows: boolean },
 *   floor: { color: string, roughness: number } | null,
 *   grid: { color: string, opacity: number, divisions: number } | null,
 *   selection: { color: string, strength: number, thickness: number, detailStrength: number, detailThickness: number },
 *   edges: { enabled: boolean, normalThreshold: number, depthThreshold: number, darken: number },
 *   bloom: { strength: number, radius: number, threshold: number },
 *   ao: { radius: number, intensity: number },
 *   render: { bounces: number, sky: string, ground: string, environmentIntensity: number },
 *   camera: { duration: number, easing: string, damping: number, margin: number },
 * }} Preset
 */

/** @type {Preset} */
const STUDIO = {
  background: '#e9e9ec',
  sky: { top: '#f6f7fb', bottom: '#c4c6ce' },
  fog: { near: 1.8, far: 4.8 },
  exposure: 1,
  environment: { intensity: 0.35 },
  hemisphere: { sky: '#ffffff', ground: '#8a8a90', intensity: 0.9 },
  sun: { color: '#ffffff', intensity: 2.2, direction: [0.45, 0.82, 0.35], shadows: true },
  floor: { color: '#d9d9dd', roughness: 1 },
  grid: { color: '#9a9aa2', opacity: 0.25, divisions: 28 },
  selection: { color: '#2f6fd6', strength: 3, thickness: 1.2, detailStrength: 1.2, detailThickness: 0.25 },
  edges: { enabled: false, normalThreshold: 0.7, depthThreshold: 0.6, darken: 0.55 },
  bloom: { strength: 0.8, radius: 0.4, threshold: 1 },
  ao: { radius: 0.03, intensity: 1 },
  render: { bounces: 5, sky: '#ffffff', ground: '#9a9aa2', environmentIntensity: 1 },
  camera: { duration: 450, easing: 'ease-in-out', damping: 0.12, margin: 1.15 },
};

/** @type {Preset} */
const WARM = {
  background: '#f2e3cd',
  sky: { top: '#fff7ec', bottom: '#dcc2a0' },
  fog: { near: 1.8, far: 4.8 },
  exposure: 1,
  environment: { intensity: 0.3 },
  hemisphere: { sky: '#fff3df', ground: '#9c7a5c', intensity: 0.9 },
  sun: { color: '#ffe0b5', intensity: 2.4, direction: [0.44, 0.8, 0.33], shadows: true },
  floor: { color: '#e6d2b5', roughness: 1 },
  grid: { color: '#a87b58', opacity: 0.22, divisions: 28 },
  selection: { color: '#a84a1f', strength: 3, thickness: 1.2, detailStrength: 1.2, detailThickness: 0.25 },
  edges: { enabled: false, normalThreshold: 0.7, depthThreshold: 0.6, darken: 0.55 },
  bloom: { strength: 0.8, radius: 0.4, threshold: 1 },
  ao: { radius: 0.03, intensity: 1 },
  render: { bounces: 5, sky: '#fff6ea', ground: '#b8987a', environmentIntensity: 1 },
  camera: { duration: 450, easing: 'ease-in-out', damping: 0.12, margin: 1.15 },
};

/** @type {Preset} */
const DARK = {
  background: '#141418',
  sky: { top: '#3a3f4a', bottom: '#0c0c0f' },
  fog: null,
  exposure: 1,
  environment: { intensity: 0.4 },
  hemisphere: { sky: '#8fa6ff', ground: '#1a1712', intensity: 0.55 },
  sun: { color: '#fff1dc', intensity: 2.4, direction: [0.5, 0.65, 0.45], shadows: true },
  floor: { color: '#1d1d22', roughness: 0.92 },
  grid: { color: '#4a4248', opacity: 0.5, divisions: 28 },
  selection: { color: '#e2984f', strength: 3, thickness: 1.2, detailStrength: 1.2, detailThickness: 0.25 },
  edges: { enabled: false, normalThreshold: 0.7, depthThreshold: 0.6, darken: 0.55 },
  bloom: { strength: 0.8, radius: 0.4, threshold: 1 },
  ao: { radius: 0.03, intensity: 1 },
  render: { bounces: 5, sky: '#3a3f4a', ground: '#0c0c0f', environmentIntensity: 1 },
  camera: { duration: 450, easing: 'ease-in-out', damping: 0.12, margin: 1.15 },
};

/** Los presets que trae el motor. Una app agrega los suyos con `definePreset`. */
export const PRESETS = /** @type {Record<string, Preset>} */ ({ studio: STUDIO, warm: WARM, dark: DARK });

/** ¿Es un objeto plano (no un array, no null)? @param {unknown} v @returns {v is Record<string, unknown>} */
const plano = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Un preset pisado por otro: lo de `over` reemplaza a lo de `base`, sección por sección (un
 * `sun` parcial cambia solo lo que dice). `null` saca una sección que se puede sacar (sky,
 * fog, floor, grid). Una clave que el preset no tiene es un error: así un typo no pasa en silencio.
 * @param {Preset} base @param {Record<string, any>} [over] @returns {Preset}
 */
export function mergePreset(base, over = {}) {
  if (!plano(over)) throw new TypeError('el preset va como un objeto: { background, sun: { … }, … }');
  /** @type {Record<string, any>} */
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    if (!(k in base)) throw new Error(`clave de preset desconocida: ${k} (van ${Object.keys(base).join(', ')})`);
    const b = /** @type {Record<string, any>} */ (base)[k];
    if (v === null) {
      if (!['sky', 'fog', 'floor', 'grid'].includes(k)) throw new Error(`${k} no se puede apagar con null`);
      out[k] = null;
    } else if (plano(v)) {
      const desde = plano(b) ? b : /** @type {Record<string, any>} */ (PRESETS.studio)[k];
      for (const kk of Object.keys(v)) if (!(kk in desde)) throw new Error(`clave desconocida: ${k}.${kk} (van ${Object.keys(desde).join(', ')})`);
      out[k] = { ...structuredClone(desde), ...structuredClone(v) };
    } else {
      out[k] = v;
    }
  }
  return /** @type {Preset} */ (out);
}

/**
 * El preset que se pidió: un nombre de PRESETS, un objeto completo, o `{ extends: nombre, … }`
 * para pisar algunos valores de uno que existe.
 * @param {string | Record<string, any>} p @returns {Preset}
 */
export function resolvePreset(p) {
  if (typeof p === 'string') {
    const found = PRESETS[p];
    if (!found) throw new Error(`preset desconocido: ${p} (van ${Object.keys(PRESETS).join(', ')})`);
    return structuredClone(found);
  }
  if (!plano(p)) throw new TypeError('el preset va como un nombre o un objeto');
  const { extends: base = 'studio', ...resto } = p;
  return mergePreset(resolvePreset(String(base)), resto);
}

/**
 * Registra un preset con nombre, por ejemplo el de un cliente: definePreset('cliente-a',
 * { extends: 'warm', selection: { color: '#0a7' } }).
 * @param {string} name @param {Record<string, any>} preset
 */
export function definePreset(name, preset) {
  if (typeof name !== 'string' || !name) throw new TypeError('el preset necesita un nombre');
  PRESETS[name] = resolvePreset(preset);
  return PRESETS[name];
}
