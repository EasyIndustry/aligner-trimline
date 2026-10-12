// El entorno HDRI: un panorama equirectangular (.hdr, .exr o una imagen común) que ilumina, se
// refleja y, si se quiere, se ve de fondo. Acá va lo puro (opciones y tipo de archivo); cargar
// el archivo y ponerlo en la escena es de index.js.
//
// Puro: no importa three ni DOM.

/**
 * @typedef {{ background: boolean, intensity: number, blur: number, rotation: number }} HdriOptions
 * `background`: se dibuja de fondo; `intensity`: cuánto ilumina y cuánto brilla de fondo (1 =
 * como viene); `blur`: desenfoque del fondo, de 0 a 1; `rotation`: grados alrededor de Y.
 */

/** Cómo se ve un HDRI si no se pide otra cosa. */
export const HDRI_DEFAULTS = /** @type {Readonly<HdriOptions>} */ (Object.freeze({ background: true, intensity: 1, blur: 0, rotation: 0 }));

/** Los formatos que sabe cargar: 'hdr' (Radiance RGBE), 'exr' (OpenEXR) o 'image' (jpg, png, webp: equirectangular en sRGB). */
export const HDRI_TYPES = Object.freeze(['hdr', 'exr', 'image']);

/**
 * El formato de un archivo: el que se pide, o el que dice la extensión (sin mirar `?query` ni
 * `#hash`). Lo que no se reconoce se trata como imagen común.
 * @param {string} url @param {string} [type] @returns {'hdr' | 'exr' | 'image'}
 */
export function hdriKind(url, type) {
  if (type !== undefined) {
    if (!HDRI_TYPES.includes(type)) throw new Error(`tipo de HDRI desconocido: ${type} (van ${HDRI_TYPES.join(', ')})`);
    return /** @type {'hdr' | 'exr' | 'image'} */ (type);
  }
  const ext = /\.([a-z0-9]+)$/i.exec(String(url).split(/[?#]/)[0])?.[1]?.toLowerCase();
  return ext === 'hdr' ? 'hdr' : ext === 'exr' ? 'exr' : 'image';
}

/**
 * Las opciones de un HDRI: `over` pisa a `base` (lo que no se dice queda). Una clave que no
 * existe o un valor fuera de rango es un error, así un typo no pasa en silencio.
 * @param {HdriOptions} base @param {Record<string, any>} [over] @returns {HdriOptions}
 */
export function mergeHdri(base, over = {}) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) throw new TypeError('las opciones del HDRI van como un objeto: { background, intensity, blur, rotation }');
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k === 'type') continue; // el formato lo usa quien carga, no es parte de cómo se ve
    if (!(k in HDRI_DEFAULTS)) throw new Error(`opción de HDRI desconocida: ${k} (van ${Object.keys(HDRI_DEFAULTS).join(', ')}, type)`);
    if (v === undefined) continue;
    if (k === 'background') { out.background = !!v; continue; }
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new RangeError(`hdri.${k} va como un número`);
    if (k === 'intensity' && v < 0) throw new RangeError('hdri.intensity no puede ser negativa');
    if (k === 'blur' && (v < 0 || v > 1)) throw new RangeError('hdri.blur va de 0 a 1');
    /** @type {Record<string, number>} */ (out)[k] = v;
  }
  return out;
}
