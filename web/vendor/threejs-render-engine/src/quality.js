// Calidad, como en un juego: lo que cuesta GPU (antialiasing, sombras, oclusión ambiental,
// bloom, muestras del render final), aparte del preset de apariencia (colores, intensidades:
// el "look" de cada cliente). Tres de fábrica — baja, media, alta — y 'personalizada': la que
// queda cuando el usuario toca un ajuste suelto. La resolución del visor va aparte
// (motor.resolution): ningún preset de calidad la toca.
//
// `textures` no lo usa el motor: es una pista para la app (texturas SD o HD), que se entera con
// motor.onQualityChange.
//
// Puro: no importa three ni DOM.

/**
 * @typedef {{
 *   antialias: number, shadows: boolean, shadowMapSize: number,
 *   ao: boolean, aoSamples: number, bloom: boolean,
 *   renderSamples: number, textures: 'sd' | 'hd',
 * }} Quality
 */

/** @type {Readonly<Record<'baja' | 'media' | 'alta', Readonly<Quality>>>} */
export const QUALITY = Object.freeze({
  baja: Object.freeze({ antialias: 0, shadows: true, shadowMapSize: 1024, ao: false, aoSamples: 8, bloom: false, renderSamples: 128, textures: 'sd' }),
  media: Object.freeze({ antialias: 4, shadows: true, shadowMapSize: 2048, ao: false, aoSamples: 16, bloom: false, renderSamples: 256, textures: 'sd' }),
  alta: Object.freeze({ antialias: 8, shadows: true, shadowMapSize: 4096, ao: true, aoSamples: 16, bloom: true, renderSamples: 512, textures: 'hd' }),
});

/** Cómo se llama la calidad cuando no es una de fábrica. */
export const CUSTOM_QUALITY = 'personalizada';

const CLAVES = Object.keys(QUALITY.media);

/** @param {string} k @param {unknown} v */
function validar(k, v) {
  const potencia2 = (/** @type {number} */ n) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
  const ok = {
    antialias: () => [0, 2, 4, 8, 16].includes(/** @type {number} */ (v)),
    shadows: () => typeof v === 'boolean',
    shadowMapSize: () => potencia2(/** @type {number} */ (v)) && /** @type {number} */ (v) >= 256 && /** @type {number} */ (v) <= 8192,
    ao: () => typeof v === 'boolean',
    aoSamples: () => Number.isInteger(v) && /** @type {number} */ (v) >= 4 && /** @type {number} */ (v) <= 64,
    bloom: () => typeof v === 'boolean',
    renderSamples: () => Number.isInteger(v) && /** @type {number} */ (v) >= 1 && /** @type {number} */ (v) <= 100000,
    textures: () => v === 'sd' || v === 'hd',
  }[k];
  if (!ok) throw new Error(`ajuste de calidad desconocido: ${k} (van ${CLAVES.join(', ')})`);
  const pista = {
    antialias: '0, 2, 4, 8 o 16', shadows: 'true o false', shadowMapSize: 'una potencia de 2 de 256 a 8192', ao: 'true o false',
    aoSamples: 'un entero de 4 a 64', bloom: 'true o false', renderSamples: 'un entero de 1 en adelante', textures: "'sd' o 'hd'",
  }[k];
  if (!ok()) throw new TypeError(`${k}: va ${pista} (vino ${JSON.stringify(v)})`);
}

/**
 * Una calidad pisada por algunos ajustes (validados: una clave que no existe es un error).
 * @param {Quality} base @param {Record<string, unknown>} over @returns {Quality}
 */
export function mergeQuality(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) throw new TypeError('la calidad va como un nombre o un objeto { antialias, shadows, … }');
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k === 'extends') continue;
    validar(k, v);
    /** @type {Record<string, unknown>} */ (out)[k] = v;
  }
  return out;
}

/**
 * La calidad pedida: un nombre de fábrica, o `{ extends: nombre, … }` para pisar algunos ajustes.
 * @param {string | Record<string, unknown>} q @returns {Quality}
 */
export function resolveQuality(q) {
  if (typeof q === 'string') {
    const found = /** @type {Record<string, Quality>} */ (QUALITY)[q];
    if (!found) throw new Error(`calidad desconocida: ${q} (van ${Object.keys(QUALITY).join(', ')}, o un objeto con los ajustes)`);
    return { ...found };
  }
  const base = resolveQuality(String(q?.extends ?? 'media'));
  return mergeQuality(base, q);
}

/** El nombre de una calidad: el de fábrica si coincide con uno, si no 'personalizada'. @param {Quality} q */
export function qualityName(q) {
  for (const [n, p] of Object.entries(QUALITY)) if (CLAVES.every((k) => /** @type {Record<string, unknown>} */ (p)[k] === /** @type {Record<string, unknown>} */ (q)[k])) return n;
  return CUSTOM_QUALITY;
}

/**
 * La calidad para arrancar según la placa (ver gpu.js): dedicada alta, integrada o por software
 * baja, desconocida media.
 * @param {'discrete' | 'integrated' | 'software' | 'unknown'} kind
 */
export const suggestQuality = (kind) => (kind === 'discrete' ? 'alta' : kind === 'integrated' || kind === 'software' ? 'baja' : 'media');
