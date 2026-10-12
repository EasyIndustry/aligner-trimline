// Los canales de un material: lo que tiene cualquier CAD (Principled de Blender, el PBR de
// glTF, los materiales físicos de Rhino o 3ds Max). Cada canal es un valor constante y,
// opcionalmente, una pila de capas de mapas encima.
//
// La tabla dice de qué tipo es cada canal, su valor por defecto, su rango, en qué espacio de
// color va, y qué propiedad y qué mapa de three.js lo reciben. El adaptador lee esta tabla;
// el núcleo no sabe de three.
//
// Puro: no importa three ni DOM.

/**
 * @typedef {'color' | 'scalar' | 'normal'} ChannelType
 * @typedef {{
 *   type: ChannelType,
 *   default: string | number,
 *   range?: [number, number],
 *   srgb?: boolean,
 *   prop?: string, map?: string,
 *   output: string,
 *   doc: string,
 * }} ChannelInfo
 */

/** @type {Readonly<Record<string, ChannelInfo>>} */
export const CHANNELS = Object.freeze({
  baseColor: { type: 'color', default: '#ffffff', srgb: true, prop: 'color', map: 'map', output: 'color', doc: 'color base (difuso / albedo)' },
  alpha: { type: 'scalar', default: 1, range: [0, 1], prop: 'opacity', map: 'alphaMap', output: 'alpha', doc: 'opacidad: 1 opaco, 0 transparente (ver alphaMode)' },
  metalness: { type: 'scalar', default: 0, range: [0, 1], prop: 'metalness', map: 'metalnessMap', output: 'metalness', doc: 'metálico: 0 dieléctrico, 1 metal' },
  roughness: { type: 'scalar', default: 0.5, range: [0, 1], prop: 'roughness', map: 'roughnessMap', output: 'roughness', doc: 'rugosidad: 0 espejo, 1 mate' },
  normal: { type: 'normal', default: 0, map: 'normalMap', output: 'normal', doc: 'mapa de normales (espacio tangente)' },
  bump: { type: 'scalar', default: 0, range: [0, 1], output: 'height', doc: 'relieve (altura); se hornea dentro del mapa de normales, con bumpStrength' },
  displacement: { type: 'scalar', default: 0, range: [0, 1], map: 'displacementMap', output: 'height', doc: 'desplazamiento: mueve vértices (necesita una malla densa), con displacementScale' },
  ao: { type: 'scalar', default: 1, range: [0, 1], map: 'aoMap', output: 'ao', doc: 'oclusión ambiental: 1 sin oclusión' },
  emissive: { type: 'color', default: '#000000', srgb: true, prop: 'emissive', map: 'emissiveMap', output: 'emissive', doc: 'color que emite (con emissiveIntensity); en el path tracer ilumina' },
  specularIntensity: { type: 'scalar', default: 1, range: [0, 1], prop: 'specularIntensity', map: 'specularIntensityMap', output: 'alpha', doc: 'intensidad del brillo especular de un dieléctrico' },
  specularColor: { type: 'color', default: '#ffffff', srgb: true, prop: 'specularColor', map: 'specularColorMap', output: 'color', doc: 'color del brillo especular de un dieléctrico' },
  transmission: { type: 'scalar', default: 0, range: [0, 1], prop: 'transmission', map: 'transmissionMap', output: 'alpha', doc: 'transmisión (vidrio): 1 deja pasar la luz' },
  thickness: { type: 'scalar', default: 0, range: [0, 1e6], prop: 'thickness', output: 'height', doc: 'espesor para la refracción, en la unidad de la escena (sin mapa)' },
  clearcoat: { type: 'scalar', default: 0, range: [0, 1], prop: 'clearcoat', map: 'clearcoatMap', output: 'alpha', doc: 'capa de barniz encima' },
  clearcoatRoughness: { type: 'scalar', default: 0, range: [0, 1], prop: 'clearcoatRoughness', map: 'clearcoatRoughnessMap', output: 'roughness', doc: 'rugosidad del barniz' },
  sheen: { type: 'scalar', default: 0, range: [0, 1], prop: 'sheen', output: 'alpha', doc: 'brillo de tela / terciopelo (sin mapa)' },
  sheenColor: { type: 'color', default: '#000000', srgb: true, prop: 'sheenColor', map: 'sheenColorMap', output: 'color', doc: 'color del sheen' },
  sheenRoughness: { type: 'scalar', default: 1, range: [0, 1], prop: 'sheenRoughness', map: 'sheenRoughnessMap', output: 'roughness', doc: 'rugosidad del sheen' },
  iridescence: { type: 'scalar', default: 0, range: [0, 1], prop: 'iridescence', map: 'iridescenceMap', output: 'alpha', doc: 'iridiscencia (película fina, aceite)' },
  anisotropy: { type: 'scalar', default: 0, range: [0, 1], prop: 'anisotropy', output: 'alpha', doc: 'anisotropía (metal cepillado), a lo largo de u (sin mapa)' },
});

/**
 * Lo que no es un canal con mapas: números del material entero.
 * @type {Readonly<Record<string, { default: unknown, doc: string, values?: readonly unknown[], range?: [number, number] }>>}
 */
export const SETTINGS = Object.freeze({
  name: { default: '', doc: 'su nombre' },
  resolution: { default: [1024, 1024], doc: 'tamaño en píxeles de los mapas horneados: un número o [ancho, alto]' },
  supersample: { default: 2, range: [1, 4], doc: 'sobremuestreo del horneado de generadores: dibuja N× por eje y promedia (bordes netos sin escalera)' },
  alphaMode: { default: 'opaque', values: ['opaque', 'mask', 'blend'], doc: "cómo se usa alpha: 'opaque' lo ignora, 'mask' recorta en alphaCutoff (chapa perforada), 'blend' es transparencia" },
  alphaCutoff: { default: 0.5, range: [0, 1], doc: "dónde recorta alphaMode 'mask'" },
  doubleSided: { default: false, doc: 'se ven las dos caras' },
  normalScale: { default: 1, range: [0, 10], doc: 'intensidad del mapa de normales' },
  bumpStrength: { default: 1, range: [0, 100], doc: 'intensidad del relieve (bump) al hornearlo como normal' },
  displacementScale: { default: 1, range: [-1e6, 1e6], doc: 'cuánto mueve el desplazamiento, en la unidad de la escena' },
  displacementBias: { default: 0, range: [-1e6, 1e6], doc: 'corrimiento del desplazamiento' },
  aoIntensity: { default: 1, range: [0, 1], doc: 'intensidad de la oclusión ambiental' },
  emissiveIntensity: { default: 1, range: [0, 1e6], doc: 'intensidad de lo emisivo' },
  ior: { default: 1.5, range: [1, 2.333], doc: 'índice de refracción (vidrio 1.5, agua 1.33)' },
  attenuationColor: { default: '#ffffff', doc: 'color que toma la luz al atravesar (vidrio teñido)' },
  attenuationDistance: { default: Infinity, range: [0, Infinity], doc: 'a qué distancia la luz ya tomó attenuationColor' },
  iridescenceIOR: { default: 1.3, range: [1, 2.333], doc: 'índice de refracción de la película iridiscente' },
  anisotropyRotation: { default: 0, range: [-360, 360], doc: 'rotación de la anisotropía, en grados' },
  mapping: { default: 'uv', doc: "cómo se apoyan los mapas en la malla: 'uv' (sus coordenadas) o { type: 'triplanar', scale, sharpness }: proyectados desde los tres ejes del objeto y mezclados según la normal, sin costuras (para mallas sin UV buenas: esferas, piezas talladas)" },
});

/** ¿El canal puede llevar mapas? (bump se hornea dentro del de normales) @param {string} canal */
export const isMappable = (canal) => !!CHANNELS[canal]?.map || canal === 'bump';

/** Los campos que puede llenar un generador (la "superficie"), en el orden de su salida. */
export const OUTPUTS = Object.freeze(['color', 'alpha', 'roughness', 'metalness', 'height', 'normal', 'emissive', 'ao']);

/** ¿Es un color CSS hex? @param {unknown} v */
export const isHexColor = (v) => typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v);
