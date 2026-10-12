// Modos de fusión de las capas, los de cualquier editor de imágenes: cómo se combina una capa
// con lo que tiene abajo. La misma cuenta está en JS (para las pruebas y para resolver capas de
// valores constantes sin hornear) y en GLSL (para el horneado).
//
// Puro: no importa three ni DOM.

/** Los modos, en el orden de su número en el shader. */
export const BLEND_MODES = Object.freeze(['normal', 'multiply', 'add', 'subtract', 'screen', 'overlay', 'darken', 'lighten', 'difference']);

/**
 * Un canal (0 a 1) de la capa `b` sobre lo de abajo `a`, con el modo dado (sin opacidad).
 * @param {string} mode @param {number} a @param {number} b
 */
export function blendValue(mode, a, b) {
  switch (mode) {
    case 'normal': return b;
    case 'multiply': return a * b;
    case 'add': return Math.min(1, a + b);
    case 'subtract': return Math.max(0, a - b);
    case 'screen': return 1 - (1 - a) * (1 - b);
    case 'overlay': return a < 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b);
    case 'darken': return Math.min(a, b);
    case 'lighten': return Math.max(a, b);
    case 'difference': return Math.abs(a - b);
    default: throw new Error(`modo de fusión desconocido: ${mode} (van ${BLEND_MODES.join(', ')})`);
  }
}

/**
 * La capa sobre lo de abajo, mezclada por `amount` (opacidad × máscara).
 * @param {string} mode @param {number} a @param {number} b @param {number} amount
 */
export const layerValue = (mode, a, b, amount) => a + (blendValue(mode, a, b) - a) * amount;

/** La misma cuenta en GLSL: mtlBlend(modo, abajo, capa). Los modos van por su índice en BLEND_MODES. */
export const BLEND_GLSL = /* glsl */ `
vec3 mtlBlend(int m, vec3 a, vec3 b) {
  if (m == 1) return a * b;
  if (m == 2) return min(vec3(1.0), a + b);
  if (m == 3) return max(vec3(0.0), a - b);
  if (m == 4) return 1.0 - (1.0 - a) * (1.0 - b);
  if (m == 5) return mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(0.5, a));
  if (m == 6) return min(a, b);
  if (m == 7) return max(a, b);
  if (m == 8) return abs(a - b);
  return b;
}`;
