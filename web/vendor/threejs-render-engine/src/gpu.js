// Qué placa está dibujando: por el nombre que da WebGL, si es dedicada, integrada o render por
// software. Sirve para avisar (una integrada puede no dar con todo prendido; el software casi
// nunca) y para que la app decida bajar la calidad.
//
// Es una heurística sobre el nombre: el navegador decide qué placa usa (powerPreference es solo
// un pedido) y algunos navegadores lo generalizan por privacidad. Puro: no importa three ni DOM.

/** @typedef {'discrete' | 'integrated' | 'software' | 'unknown'} GpuKind */

const SOFTWARE = /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render|microsoft basic|mesa offscreen/i;
// "AMD Radeon Graphics" / "Radeon Vega 8 Graphics" son integradas; "Radeon RX 6700" no
const INTEGRADA = /intel|iris|uhd graphics|hd graphics|radeon(\(tm\))? (vega \d+ )?graphics|radeon \d{3,4}m|apple (m\d|gpu)|mali|adreno|powervr|videocore/i;
const DEDICADA = /nvidia|geforce|quadro|rtx|gtx|tesla|radeon (rx|pro|r9|r7|hd \d)|arc a\d|firepro/i;

/**
 * El tipo de placa por su nombre.
 * @param {string | null | undefined} name @returns {GpuKind}
 */
export function classifyGpu(name) {
  const n = String(name ?? '');
  if (!n) return 'unknown';
  if (SOFTWARE.test(n)) return 'software';
  if (DEDICADA.test(n) && !/radeon(\(tm\))? (vega \d+ )?graphics/i.test(n)) return 'discrete';
  if (INTEGRADA.test(n)) return 'integrated';
  return 'unknown';
}

/** Cómo se lee cada tipo, para la consola. @type {Record<GpuKind, string>} */
export const GPU_KIND_TEXT = {
  discrete: 'placa dedicada',
  integrated: 'gráficos integrados: con todo prendido puede andar lento',
  software: 'render por software (sin GPU): va a andar lento; revisá la aceleración por hardware del navegador',
  unknown: 'no se sabe (el navegador no da el nombre de la placa)',
};
