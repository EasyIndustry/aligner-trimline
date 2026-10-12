// Generadores: texturas procedurales que el motor hornea a mapas. Un generador es GLSL que
// llena una "superficie" (color, alfa, rugosidad, metálico, altura, normal, emisivo, oclusión)
// en cada texel; el material dice qué salida usa cada capa.
//
// Hay dos espacios:
//   'uv'     trabaja sobre las coordenadas de la textura (mtl_uv(), ya con repeat, offset y
//            rotación de la capa). Los que trae el motor son así.
//   'solid'  una textura sólida 3D (la veta de una madera, el mármol de un bloque): el plugin
//            dice qué plano de su espacio cae sobre la textura (`plane`), y el motor le pasa a
//            cada texel su punto vPos y su normal vNrm en ese espacio.
//
// Un plugin (de una app) es un generador más, registrado con registerGenerator:
//   {
//     name: 'mi-app/madera', version: '1', space: 'solid',
//     outputs: ['color', 'roughness', 'normal'],
//     params: { especie: { type: 'string', default: 'pino' }, … },
//     fragment: `…GLSL… void generate(inout Surface s) { s.color = …; }`,
//     vertex: { pars: '…', main: '…' },               // opcional: varyings propios
//     uniforms: (params, ctx) => ({ uX: { value } }),  // opcional: uniforms calculados en JS
//     plane: (params) => ({ corners: [p00, p10, p11, p01], normal }),  // 'solid': el plano
//   }
// Los params con tipo number, int, bool o color se vuelven uniforms solos (p_<nombre>); los
// demás (string, select) los usa la función uniforms. ctx: { width, height, supersample }.
//
// Puro: no importa three ni DOM (los plugins pueden: sus funciones las llama el adaptador).
import { OUTPUTS } from './channels.js';

/** @typedef {'number' | 'int' | 'bool' | 'color' | 'string' | 'select'} ParamType */
/** @typedef {{ type: ParamType, default: unknown, min?: number, max?: number, values?: readonly unknown[], doc?: string }} ParamSpec */
/**
 * @typedef {{
 *   name: string, version: string, space: 'uv' | 'solid', outputs: readonly string[],
 *   params: Readonly<Record<string, ParamSpec>>, fragment: string,
 *   vertex?: { pars?: string, main?: string },
 *   uniforms?: (params: Record<string, unknown>, ctx: { width: number, height: number, supersample: number }) => Record<string, { value: unknown }>,
 *   plane?: (params: Record<string, unknown>) => { corners: number[][], normal: number[] },
 *   doc?: string,
 * }} Generator
 */

/** La superficie que llena un generador, y cómo sale cada campo al horneado. */
export const SURFACE_GLSL = /* glsl */ `
struct Surface { vec3 color; float alpha; float roughness; float metalness; float height; vec3 normal; vec3 emissive; float ao; };
Surface surfaceDefault() { return Surface(vec3(1.0), 1.0, 0.5, 0.0, 0.0, vec3(0.0, 0.0, 1.0), vec3(0.0), 1.0); }
vec4 surfaceOut(Surface s, int o) {
  if (o == 0) return vec4(s.color, 1.0);
  if (o == 1) return vec4(vec3(s.alpha), 1.0);
  if (o == 2) return vec4(vec3(s.roughness), 1.0);
  if (o == 3) return vec4(vec3(s.metalness), 1.0);
  if (o == 4) return vec4(vec3(s.height), 1.0);
  if (o == 5) return vec4(normalize(s.normal) * 0.5 + 0.5, 1.0);
  if (o == 6) return vec4(s.emissive, 1.0);
  return vec4(vec3(s.ao), 1.0);
}`;

/** Ruido y hash, con prefijo mtl_ para no chocar con los de un plugin. */
export const NOISE_GLSL = /* glsl */ `
float mtl_hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 mtl_hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float mtl_noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mtl_hash12(i), mtl_hash12(i + vec2(1.0, 0.0)), u.x), mix(mtl_hash12(i + vec2(0.0, 1.0)), mtl_hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float mtl_fbm(vec2 p, int octaves, float persistence, float lacunarity) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    s += a * mtl_noise(p); n += a; p *= lacunarity; a *= persistence;
  }
  return s / max(n, 1e-5);
}`;

/** Llena con un mismo valor todos los campos escalares, y el color en gris. */
const TODO = 's.color = vec3(v); s.alpha = v; s.roughness = v; s.metalness = v; s.height = v; s.emissive = vec3(v); s.ao = v;';
const ESCALARES = Object.freeze(['color', 'alpha', 'roughness', 'metalness', 'height', 'emissive', 'ao']);
const SEED = { type: 'number', default: 0, doc: 'semilla: otro valor, otro dibujo' };

/** @type {Generator[]} */
const BUILTIN = [
  {
    name: 'noise', version: '1', space: 'uv', outputs: ESCALARES,
    doc: 'ruido fractal (fbm): manchas, suciedad, variación de rugosidad',
    params: {
      scale: { type: 'number', default: 8, min: 0.01, max: 4096, doc: 'cuántas manchas entran a lo ancho' },
      octaves: { type: 'int', default: 4, min: 1, max: 8, doc: 'capas de detalle' },
      persistence: { type: 'number', default: 0.5, min: 0, max: 1, doc: 'cuánto pesa cada capa de detalle' },
      lacunarity: { type: 'number', default: 2, min: 1, max: 4, doc: 'cuánto más fino es cada capa' },
      seed: SEED,
    },
    fragment: `void generate(inout Surface s) { float v = mtl_fbm(mtl_uv() * p_scale + p_seed * 17.31, p_octaves, p_persistence, p_lacunarity); ${TODO} }`,
  },
  {
    name: 'cells', version: '1', space: 'uv', outputs: ESCALARES,
    doc: 'celdas (Voronoi): distancia al centro más cercano; piedra, escamas, raspones con remap',
    params: { scale: { type: 'number', default: 8, min: 0.01, max: 4096 }, jitter: { type: 'number', default: 1, min: 0, max: 1 }, seed: SEED },
    fragment: `void generate(inout Surface s) {
  vec2 p = mtl_uv() * p_scale + p_seed * 7.13, i = floor(p), f = fract(p);
  float d = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = g + mtl_hash22(i + g) * p_jitter - f;
    d = min(d, dot(o, o));
  }
  float v = clamp(sqrt(d), 0.0, 1.0); ${TODO} }`,
  },
  {
    name: 'checker', version: '1', space: 'uv', outputs: ESCALARES,
    doc: 'damero: 0 y 1 alternados (azulejos, pruebas de mapeo)',
    params: { count: { type: 'number', default: 8, min: 1, max: 4096, doc: 'cuadros a lo ancho' } },
    fragment: `void generate(inout Surface s) { vec2 c = floor(mtl_uv() * p_count); float v = mod(c.x + c.y, 2.0); ${TODO} }`,
  },
  {
    name: 'brushed', version: '1', space: 'uv', outputs: ESCALARES,
    doc: 'cepillado: rayas finas a lo largo de u (metal cepillado; úsese en rugosidad o bump)',
    params: {
      scale: { type: 'number', default: 300, min: 1, max: 8192, doc: 'rayas a lo alto' },
      stretch: { type: 'number', default: 0.02, min: 0.001, max: 1, doc: 'cuánto se estiran a lo largo' },
      seed: SEED,
    },
    fragment: `void generate(inout Surface s) { vec2 p = mtl_uv(); float v = mtl_fbm(vec2(p.x * p_scale * p_stretch, p.y * p_scale) + p_seed * 3.7, 3, 0.5, 2.0); ${TODO} }`,
  },
  {
    name: 'grain', version: '1', space: 'uv', outputs: ESCALARES,
    doc: 'granos sueltos: puntos al azar (texturado de plástico, polvo, chispas)',
    params: {
      scale: { type: 'number', default: 200, min: 1, max: 8192, doc: 'celdas a lo ancho (una pinta como mucho por celda)' },
      density: { type: 'number', default: 0.3, min: 0, max: 1, doc: 'qué parte de las celdas tiene pinta' },
      size: { type: 'number', default: 0.35, min: 0.01, max: 0.7, doc: 'tamaño de la pinta dentro de su celda' },
      seed: SEED,
    },
    fragment: `void generate(inout Surface s) {
  vec2 p = mtl_uv() * p_scale + p_seed * 11.1, i = floor(p), f = fract(p);
  float on = step(mtl_hash12(i + 0.37), p_density);
  vec2 c = 0.5 + (mtl_hash22(i) - 0.5) * (1.0 - 2.0 * p_size);
  float v = on * (1.0 - smoothstep(p_size * 0.8, p_size, length(f - c))); ${TODO} }`,
  },
  {
    name: 'dots', version: '1', space: 'uv', outputs: ESCALARES,
    doc: 'círculos en grilla: 1 adentro (chapa perforada como alfa invertido, botones)',
    params: {
      count: { type: 'number', default: 20, min: 1, max: 4096, doc: 'agujeros a lo ancho' },
      radius: { type: 'number', default: 0.3, min: 0, max: 0.5, doc: 'radio en fracción de la celda' },
      stagger: { type: 'bool', default: false, doc: 'filas alternadas corridas media celda' },
    },
    fragment: `void generate(inout Surface s) {
  vec2 p = mtl_uv() * p_count;
  if (p_stagger) p.x += 0.5 * mod(floor(p.y), 2.0);
  float d = length(fract(p) - 0.5), w = fwidth(d);
  float v = 1.0 - smoothstep(p_radius - w, p_radius + w, d); ${TODO} }`,
  },
  {
    name: 'tiles', version: '1', space: 'uv', outputs: ESCALARES,
    doc: 'baldosas o ladrillos: 1 en la pieza, 0 en la junta (con bisel en altura)',
    params: {
      columns: { type: 'number', default: 4, min: 1, max: 4096 },
      rows: { type: 'number', default: 8, min: 1, max: 4096 },
      gap: { type: 'number', default: 0.04, min: 0, max: 0.5, doc: 'ancho de la junta, en fracción de la pieza' },
      bevel: { type: 'number', default: 0.05, min: 0, max: 0.5, doc: 'redondeo del borde, en fracción de la pieza' },
      stagger: { type: 'number', default: 0.5, min: 0, max: 1, doc: 'corrimiento de una fila a la otra (0.5: ladrillo)' },
    },
    fragment: `void generate(inout Surface s) {
  vec2 p = mtl_uv() * vec2(p_columns, p_rows);
  p.x += p_stagger * mod(floor(p.y), 2.0);
  vec2 f = fract(p), e = min(f, 1.0 - f);
  float d = min(e.x * p_rows / p_columns, e.y);
  float v = smoothstep(p_gap * 0.5, p_gap * 0.5 + max(p_bevel, 1e-4), d); ${TODO} }`,
  },
  {
    name: 'gradient', version: '1', space: 'uv', outputs: ESCALARES,
    doc: 'degradé lineal de 0 a 1 a lo largo de u o de v',
    params: { axis: { type: 'select', values: ['u', 'v'], default: 'v' } },
    uniforms: (p) => ({ p_axisV: { value: p.axis === 'v' } }),
    fragment: `uniform bool p_axisV;\nvoid generate(inout Surface s) { vec2 p = mtl_uv(); float v = clamp(p_axisV ? p.y : p.x, 0.0, 1.0); ${TODO} }`,
  },
];

/** @type {Map<string, Readonly<Generator>>} */
const registry = new Map();

const NOMBRE = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?$/;

/**
 * Agrega (o reemplaza) un generador. Los de una app van con su prefijo: 'mi-app/madera'.
 * @param {Generator} gen @returns {Readonly<Generator>}
 */
export function registerGenerator(gen) {
  if (!gen || typeof gen !== 'object') throw new TypeError('el generador va como un objeto { name, version, space, outputs, params, fragment }');
  const { name, version, space, outputs, params = {}, fragment } = gen;
  if (typeof name !== 'string' || !NOMBRE.test(name)) throw new Error(`nombre de generador inválido: ${String(name)} (minúsculas, números y guiones; un plugin con prefijo: 'app/nombre')`);
  if (typeof version !== 'string' || !version) throw new Error(`${name}: falta version (un texto; cambiarlo invalida lo horneado)`);
  if (space !== 'uv' && space !== 'solid') throw new Error(`${name}: space va 'uv' o 'solid'`);
  if (!Array.isArray(outputs) || !outputs.length || outputs.some((o) => !OUTPUTS.includes(o))) throw new Error(`${name}: outputs va una lista de ${OUTPUTS.join(', ')}`);
  if (typeof fragment !== 'string' || !/void\s+generate\s*\(\s*inout\s+Surface\s+\w+\s*\)/.test(fragment)) throw new Error(`${name}: fragment tiene que definir void generate(inout Surface s)`);
  if (space === 'solid' && typeof gen.plane !== 'function') throw new Error(`${name}: un generador 'solid' necesita plane(params) → { corners, normal }`);
  if (gen.uniforms !== undefined && typeof gen.uniforms !== 'function') throw new TypeError(`${name}: uniforms va una función (params, ctx) → { nombre: { value } }`);
  for (const [k, p] of Object.entries(params)) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(k)) throw new Error(`${name}: parámetro inválido ${k}`);
    if (!['number', 'int', 'bool', 'color', 'string', 'select'].includes(p.type)) throw new Error(`${name}.${k}: tipo inválido ${String(p.type)}`);
    if (p.type === 'select' && !p.values?.includes(p.default)) throw new Error(`${name}.${k}: el default tiene que estar en values`);
  }
  const g = Object.freeze({ ...gen, params: Object.freeze({ ...params }), outputs: Object.freeze([...outputs]) });
  registry.set(name, g);
  return g;
}

/** @param {string} name */
export function getGenerator(name) {
  const g = registry.get(name);
  if (!g) throw new Error(`generador desconocido: ${name} (hay ${[...registry.keys()].join(', ')})`);
  return g;
}

/** Los generadores registrados: { name, version, space, outputs, params, doc }. */
export const listGenerators = () => [...registry.values()].map(({ name, version, space, outputs, params, doc }) => ({ name, version, space, outputs, params, doc }));

/**
 * Los parámetros de una capa completos y validados contra el generador (los que faltan, con su
 * default). @param {Readonly<Generator>} g @param {Record<string, unknown>} params
 */
export function resolveParams(g, params = {}) {
  for (const k of Object.keys(params)) if (!(k in g.params)) throw new Error(`${g.name}: parámetro desconocido ${k} (van ${Object.keys(g.params).join(', ') || 'ninguno'})`);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, p] of Object.entries(g.params)) {
    const v = params[k] ?? p.default;
    if (p.type === 'number' || p.type === 'int') {
      if (typeof v !== 'number' || !Number.isFinite(v) || (p.type === 'int' && !Number.isInteger(v))) throw new TypeError(`${g.name}.${k}: va un ${p.type === 'int' ? 'entero' : 'número'}`);
      if ((p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max)) throw new RangeError(`${g.name}.${k}: va de ${p.min} a ${p.max}`);
    } else if (p.type === 'bool' && typeof v !== 'boolean') throw new TypeError(`${g.name}.${k}: va true o false`);
    else if (p.type === 'color' && !(typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v))) throw new TypeError(`${g.name}.${k}: va un color '#rrggbb'`);
    else if (p.type === 'select' && !p.values?.includes(v)) throw new Error(`${g.name}.${k}: va ${p.values?.join(', ')}`);
    else if (p.type === 'string' && typeof v !== 'string') throw new TypeError(`${g.name}.${k}: va un texto`);
    out[k] = v;
  }
  return out;
}

/** Las declaraciones GLSL de los parámetros que van como uniforms solos (p_<nombre>). @param {Readonly<Generator>} g */
export function paramUniformsGLSL(g) {
  const tipo = { number: 'float', int: 'int', bool: 'bool', color: 'vec3' };
  return Object.entries(g.params)
    .filter(([, p]) => p.type in tipo)
    .map(([k, p]) => `uniform ${tipo[/** @type {keyof typeof tipo} */ (p.type)]} p_${k};`)
    .join('\n');
}

for (const g of BUILTIN) registerGenerator(g);
