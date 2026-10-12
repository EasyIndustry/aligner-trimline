// La definición de un material, como datos: canales con capas de mapas, y capas de material
// encima (barniz, pintura con raspones, suciedad). defineMaterial la valida y la deja en su
// forma completa; planMaterial dice qué hay que hornear y en qué orden; hashMaterial la
// identifica (para la caché y los prehorneados).
//
//   {
//     name: 'Chapa pintada', resolution: 1024, alphaMode: 'opaque',
//     channels: {
//       baseColor: '#b03a2e',                                  // un valor
//       roughness: { value: 0.45, layers: [{ generator: 'noise', params: { scale: 40 }, blend: 'multiply', opacity: 0.3 }] },
//       bump: [{ generator: 'grain', params: { density: 0.4 } }], // solo capas (sobre el valor por defecto)
//     },
//     layers: [                                                // capas de MATERIAL, en orden
//       { name: 'raspones', mask: { generator: 'cells', params: { scale: 6 }, remap: [0, 0.2] },
//         channels: { baseColor: '#8a8f96', metalness: 1, roughness: 0.3 } },
//     ],
//   }
//
// Una capa de MAPA es una fuente (una imagen, un generador, un color o un valor), con:
//   read      qué tomar de la fuente: 'rgb' | 'r' | 'g' | 'b' | 'a' | 'luminance'
//   blend     cómo se fusiona con lo de abajo (BLEND_MODES)
//   opacity   0 a 1
//   mask      otra fuente (gris) que dice dónde se aplica
//   invert, remap: [desde, hasta], tint (multiplica el color)
//   transform { repeat: [u, v], offset: [u, v], rotation (grados), wrap: 'repeat' | 'mirror' | 'clamp' }
//   output    qué salida del generador (por defecto la del canal)
//
// Puro: no importa three ni DOM.
import { CHANNELS, SETTINGS, OUTPUTS, isHexColor, isMappable } from './channels.js';
import { BLEND_MODES, layerValue } from './blend.js';

const READS = Object.freeze(['rgb', 'r', 'g', 'b', 'a', 'luminance']);
const WRAPS = Object.freeze(['repeat', 'mirror', 'clamp']);
const plano = (/** @type {unknown} */ v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** Las definiciones que ya pasaron por defineMaterial (no se vuelven a validar). */
const normalizados = new WeakSet();
/** @param {Record<string, unknown>} def @returns {MaterialDef} */
const normalizado = (def) => (normalizados.has(def) ? /** @type {MaterialDef} */ (def) : defineMaterial(def));
const num = (/** @type {unknown} */ v, /** @type {string} */ que) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${que}: va un número (vino ${JSON.stringify(v)})`);
  return v;
};
const par = (/** @type {unknown} */ v, /** @type {string} */ que, /** @type {[number, number]} */ def) => {
  if (v === undefined) return def;
  if (typeof v === 'number') return /** @type {[number, number]} */ ([num(v, que), v]);
  if (!Array.isArray(v) || v.length !== 2) throw new TypeError(`${que}: va un número o [u, v]`);
  return /** @type {[number, number]} */ ([num(v[0], que), num(v[1], que)]);
};

/**
 * @typedef {{ kind: 'image', url: string }
 *   | { kind: 'generator', name: string, params: Record<string, unknown>, output: string | null }
 *   | { kind: 'color', value: string }
 *   | { kind: 'value', value: number }} Source
 * @typedef {{ repeat: [number, number], offset: [number, number], rotation: number, wrap: 'repeat' | 'mirror' | 'clamp' }} Transform
 * @typedef {{ source: Source, read: string, invert: boolean, remap: [number, number] | null, transform: Transform }} Mask
 * @typedef {Mask & { blend: string, opacity: number, mask: Mask | null, tint: string | null }} Layer
 * @typedef {{ value: string | number, layers: Layer[] }} Channel
 * @typedef {{ name: string, opacity: number, mask: Mask | null, channels: Record<string, Channel> }} MaterialLayer
 * @typedef {Record<string, any> & { channels: Record<string, Channel>, layers: MaterialLayer[] }} MaterialDef
 */

/** @param {unknown} v @param {string} que @returns {Transform} */
function transformDe(v, que) {
  if (v === undefined) return { repeat: [1, 1], offset: [0, 0], rotation: 0, wrap: 'repeat' };
  if (!plano(v)) throw new TypeError(`${que}.transform: va { repeat, offset, rotation, wrap }`);
  const o = /** @type {Record<string, unknown>} */ (v);
  for (const k of Object.keys(o)) if (!['repeat', 'offset', 'rotation', 'wrap'].includes(k)) throw new Error(`${que}.transform: clave desconocida ${k}`);
  const wrap = /** @type {Transform['wrap']} */ (o.wrap ?? 'repeat');
  if (!WRAPS.includes(wrap)) throw new Error(`${que}.transform.wrap: va ${WRAPS.join(', ')}`);
  return { repeat: par(o.repeat, `${que}.transform.repeat`, [1, 1]), offset: par(o.offset, `${que}.transform.offset`, [0, 0]), rotation: o.rotation === undefined ? 0 : num(o.rotation, `${que}.transform.rotation`), wrap };
}

/** @param {Record<string, unknown>} o @param {string} que @returns {Source} */
function fuenteDe(o, que) {
  const tipos = ['image', 'generator', 'color', 'value'].filter((k) => k in o);
  if (tipos.length !== 1) throw new Error(`${que}: va una fuente, y solo una: { image } | { generator } | { color } | { value } (vino ${tipos.join(', ') || 'ninguna'})`);
  if ('image' in o) {
    if (typeof o.image !== 'string' || !o.image) throw new TypeError(`${que}.image: va la URL de la imagen`);
    return { kind: 'image', url: o.image };
  }
  if ('generator' in o) {
    if (typeof o.generator !== 'string' || !o.generator) throw new TypeError(`${que}.generator: va el nombre de un generador`);
    if (o.params !== undefined && !plano(o.params)) throw new TypeError(`${que}.params: va un objeto`);
    if (o.output !== undefined && !OUTPUTS.includes(/** @type {string} */ (o.output))) throw new Error(`${que}.output: va ${OUTPUTS.join(', ')}`);
    return { kind: 'generator', name: o.generator, params: JSON.parse(JSON.stringify(o.params ?? {})), output: /** @type {string | undefined} */ (o.output) ?? null };
  }
  if ('color' in o) {
    if (!isHexColor(o.color)) throw new TypeError(`${que}.color: va un color '#rrggbb'`);
    return { kind: 'color', value: /** @type {string} */ (o.color).toLowerCase() };
  }
  return { kind: 'value', value: num(o.value, `${que}.value`) };
}

const CLAVES_MASCARA = ['image', 'generator', 'color', 'value', 'params', 'output', 'read', 'invert', 'remap', 'transform'];
const CLAVES_CAPA = [...CLAVES_MASCARA, 'blend', 'opacity', 'mask', 'tint'];

/** @param {unknown} v @param {string} que @returns {Mask} */
function mascaraDe(v, que) {
  const o = /** @type {Record<string, unknown>} */ (typeof v === 'string' ? { image: v } : v);
  if (!plano(o)) throw new TypeError(`${que}: va una fuente: una URL, { image }, { generator }, { value }`);
  for (const k of Object.keys(o)) if (!CLAVES_MASCARA.includes(k)) throw new Error(`${que}: clave desconocida ${k}`);
  const read = /** @type {string} */ (o.read ?? 'luminance');
  if (!READS.includes(read)) throw new Error(`${que}.read: va ${READS.join(', ')}`);
  let remap = null;
  if (o.remap !== undefined) remap = par(o.remap, `${que}.remap`, [0, 1]);
  return { source: fuenteDe(o, que), read, invert: !!o.invert, remap, transform: transformDe(o.transform, que) };
}

/**
 * El mapeo: 'uv', 'triplanar' o { type: 'triplanar', scale, sharpness }. scale: cuántas unidades del
 * objeto ocupa una repetición de la textura; sharpness: cuán rápido pasa de una proyección a otra
 * en los bordes (1 muy mezclado, 8 casi cortado).
 * @param {unknown} v @returns {{ type: 'uv' } | { type: 'triplanar', scale: number, sharpness: number }}
 */
function mapeoDe(v) {
  if (v === undefined || v === 'uv') return { type: 'uv' };
  if (v === 'triplanar') return { type: 'triplanar', scale: 1, sharpness: 4 };
  if (!plano(v)) throw new TypeError("mapping: va 'uv', 'triplanar' o { type: 'triplanar', scale, sharpness }");
  const o = /** @type {Record<string, unknown>} */ (v);
  for (const k of Object.keys(o)) if (!['type', 'scale', 'sharpness'].includes(k)) throw new Error(`mapping: clave desconocida ${k}`);
  if (o.type === 'uv') return { type: 'uv' };
  if (o.type !== 'triplanar') throw new Error("mapping.type: va 'uv' o 'triplanar'");
  const scale = o.scale === undefined ? 1 : num(o.scale, 'mapping.scale');
  const sharpness = o.sharpness === undefined ? 4 : num(o.sharpness, 'mapping.sharpness');
  if (!(scale > 0)) throw new RangeError('mapping.scale: va mayor que 0 (unidades del objeto por repetición)');
  if (sharpness < 1 || sharpness > 64) throw new RangeError('mapping.sharpness: va de 1 a 64');
  return { type: 'triplanar', scale, sharpness };
}

/** @param {unknown} v @param {string} que @param {string} canal @returns {Layer} */
function capaDe(v, que, canal) {
  const o = /** @type {Record<string, unknown>} */ (typeof v === 'string' ? { image: v } : v);
  if (!plano(o)) throw new TypeError(`${que}: va una capa: una URL o { image | generator | color | value, … }`);
  for (const k of Object.keys(o)) if (!CLAVES_CAPA.includes(k)) throw new Error(`${que}: clave desconocida ${k} (van ${CLAVES_CAPA.join(', ')})`);
  const tipo = CHANNELS[canal].type;
  const base = mascaraDe({ ...Object.fromEntries(Object.entries(o).filter(([k]) => CLAVES_MASCARA.includes(k))), read: o.read ?? (tipo === 'scalar' ? 'luminance' : 'rgb') }, que);
  if (tipo === 'scalar' && base.read === 'rgb') throw new Error(`${que}.read: ${canal} es un número; va 'r', 'g', 'b', 'a' o 'luminance'`);
  if (base.source.kind === 'color' && tipo === 'scalar') throw new Error(`${que}: ${canal} es un número; va { value }, no { color }`);
  if (base.source.kind === 'value' && tipo !== 'scalar') throw new Error(`${que}: ${canal} es un color; va { color }, no { value }`);
  const blend = /** @type {string} */ (o.blend ?? 'normal');
  if (!BLEND_MODES.includes(blend)) throw new Error(`${que}.blend: va ${BLEND_MODES.join(', ')}`);
  const opacity = o.opacity === undefined ? 1 : num(o.opacity, `${que}.opacity`);
  if (opacity < 0 || opacity > 1) throw new RangeError(`${que}.opacity: va de 0 a 1`);
  if (o.tint !== undefined && !isHexColor(o.tint)) throw new TypeError(`${que}.tint: va un color '#rrggbb'`);
  return { ...base, blend, opacity, mask: o.mask === undefined ? null : mascaraDe(o.mask, `${que}.mask`), tint: /** @type {string | undefined} */ (o.tint)?.toLowerCase() ?? null };
}

/** @param {string} canal @param {unknown} v @param {string} que @returns {string | number} */
function valorDe(canal, v, que) {
  const info = CHANNELS[canal];
  if (info.type === 'color') {
    if (!isHexColor(v)) throw new TypeError(`${que}: ${canal} va como un color '#rrggbb'`);
    return /** @type {string} */ (v).toLowerCase();
  }
  if (info.type === 'normal') {
    if (v !== 0 && v !== undefined) throw new TypeError(`${que}: normal no tiene valor; va solo con capas`);
    return 0;
  }
  num(v, `${que}`);
  const [a, b] = /** @type {[number, number]} */ (info.range);
  if (/** @type {number} */ (v) < a || /** @type {number} */ (v) > b) throw new RangeError(`${que}: ${canal} va de ${a} a ${b}`);
  return /** @type {number} */ (v);
}

/** @param {unknown} v @param {string} canal @param {string} que @returns {Channel} */
function canalDe(v, canal, que) {
  if (!(canal in CHANNELS)) throw new Error(`canal desconocido: ${canal} (van ${Object.keys(CHANNELS).join(', ')})`);
  const def = CHANNELS[canal].default;
  if (typeof v === 'string' && !isHexColor(v)) v = [v]; // una URL suelta: una capa de imagen
  if (Array.isArray(v)) return { value: def, layers: v.map((c, i) => capaDe(c, `${que}[${i}]`, canal)) };
  if (plano(v)) {
    const o = /** @type {Record<string, unknown>} */ (v);
    for (const k of Object.keys(o)) if (!['value', 'layers'].includes(k)) throw new Error(`${que}: va { value, layers } (vino ${k}); para una sola capa, ponela en layers: [ … ]`);
    if (o.layers !== undefined && !Array.isArray(o.layers)) throw new TypeError(`${que}.layers: va un array de capas`);
    return {
      value: o.value === undefined ? def : valorDe(canal, o.value, `${que}.value`),
      layers: (/** @type {unknown[]} */ (o.layers ?? [])).map((c, i) => capaDe(c, `${que}.layers[${i}]`, canal)),
    };
  }
  return { value: valorDe(canal, v, que), layers: [] };
}

/** @param {unknown} v @param {string} que */
function canalesDe(v, que) {
  if (v === undefined) return {};
  if (!plano(v)) throw new TypeError(`${que}: va un objeto { baseColor, roughness, … }`);
  return Object.fromEntries(Object.entries(/** @type {Record<string, unknown>} */ (v)).map(([k, c]) => [k, canalDe(c, k, `${que}.${k}`)]));
}

/**
 * La definición completa y validada de un material. Acepta los atajos (un valor, un array de
 * capas, una URL como capa) y devuelve siempre la misma forma. Un error dice dónde está.
 * @param {Record<string, unknown>} def @returns {MaterialDef}
 */
export function defineMaterial(def) {
  if (!plano(def)) throw new TypeError('el material va como un objeto: { name, channels: { … }, layers: [ … ] }');
  for (const k of Object.keys(def)) if (!(k in SETTINGS) && k !== 'channels' && k !== 'layers') throw new Error(`clave desconocida: ${k} (van channels, layers, ${Object.keys(SETTINGS).join(', ')})`);
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, s] of Object.entries(SETTINGS)) {
    const v = def[k] ?? s.default;
    if (s.values && !s.values.includes(v)) throw new Error(`${k}: va ${s.values.join(', ')}`);
    if (s.range && typeof s.default === 'number' && !(v === Infinity && s.range[1] === Infinity)) { num(v, k); if (v < s.range[0] || v > s.range[1]) throw new RangeError(`${k}: va de ${s.range[0]} a ${s.range[1]}`); }
    out[k] = v;
  }
  out.mapping = mapeoDe(def.mapping);
  out.resolution = par(def.resolution, 'resolution', /** @type {[number, number]} */ (SETTINGS.resolution.default)).map((x) => {
    if (!Number.isInteger(x) || x < 4 || x > 8192) throw new RangeError('resolution: va un entero de 4 a 8192 (o [ancho, alto])');
    return x;
  });
  if (!isHexColor(out.attenuationColor)) throw new TypeError("attenuationColor: va un color '#rrggbb'");
  out.channels = canalesDe(def.channels, 'channels');
  if (def.layers !== undefined && !Array.isArray(def.layers)) throw new TypeError('layers: va un array de capas de material');
  out.layers = (/** @type {unknown[]} */ (def.layers ?? [])).map((l, i) => {
    const que = `layers[${i}]`;
    if (!plano(l)) throw new TypeError(`${que}: va { name?, mask?, opacity?, channels }`);
    const o = /** @type {Record<string, unknown>} */ (l);
    for (const k of Object.keys(o)) if (!['name', 'mask', 'opacity', 'channels'].includes(k)) throw new Error(`${que}: clave desconocida ${k}`);
    const opacity = o.opacity === undefined ? 1 : num(o.opacity, `${que}.opacity`);
    if (opacity < 0 || opacity > 1) throw new RangeError(`${que}.opacity: va de 0 a 1`);
    const channels = canalesDe(o.channels, `${que}.channels`);
    if (!Object.keys(channels).length) throw new Error(`${que}: una capa de material sin canales no cambia nada`);
    return { name: String(o.name ?? `capa ${i + 1}`), opacity, mask: o.mask === undefined ? null : mascaraDe(o.mask, `${que}.mask`), channels };
  });
  normalizados.add(out);
  return /** @type {MaterialDef} */ (out);
}

// ---------- color: las mezclas de constantes van en lineal, como en el horneado ----------
const aLineal = (/** @type {number} */ c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const aSRGB = (/** @type {number} */ c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
/** @param {string} hex @returns {[number, number, number]} */
export function hexToLinear(hex) {
  const h = hex.length === 4 ? hex.slice(1).split('').map((c) => c + c).join('') : hex.slice(1);
  return /** @type {[number, number, number]} */ ([0, 2, 4].map((i) => aLineal(parseInt(h.slice(i, i + 2), 16) / 255)));
}
/** @param {[number, number, number]} rgb */
export const linearToHex = (rgb) => '#' + rgb.map((c) => Math.round(Math.min(1, Math.max(0, aSRGB(c))) * 255).toString(16).padStart(2, '0')).join('');

/**
 * @typedef {{ op: 'fill', value: string | number }
 *   | { op: 'layer', layer: Layer }
 *   | { op: 'mix', ops: Op[], mask: Mask | null, opacity: number, name: string }} Op
 * @typedef {{ type: 'constant', value: string | number } | { type: 'texture', ops: Op[] }} ChannelPlan
 */

/**
 * Qué hay que hacer para cada canal: un valor constante (no hace falta textura) o una textura
 * que se arma con pasos: llenar con el valor, cada capa de mapa encima, y cada capa de material
 * mezclada por su máscara. Las capas de material sin máscara y con valores constantes se
 * resuelven acá mismo, sin hornear.
 * @param {MaterialDef | Record<string, unknown>} def
 * @returns {{ def: MaterialDef, channels: Record<string, ChannelPlan>, normal: { from: ChannelPlan | null, bump: ChannelPlan | null } }}
 */
export function planMaterial(def) {
  const d = normalizado(/** @type {Record<string, unknown>} */ (def));
  const nombres = new Set([...Object.keys(d.channels), ...d.layers.flatMap((l) => Object.keys(l.channels))]);
  /** @type {Record<string, ChannelPlan>} */
  const channels = {};
  for (const canal of nombres) {
    const base = d.channels[canal] ?? { value: CHANNELS[canal].default, layers: [] };
    /** @type {Op[]} */
    let ops = [{ op: 'fill', value: base.value }, ...base.layers.map((layer) => /** @type {Op} */ ({ op: 'layer', layer }))];
    for (const l of d.layers) {
      const c = l.channels[canal];
      if (!c) continue;
      ops.push({ op: 'mix', name: l.name, mask: l.mask, opacity: l.opacity, ops: [{ op: 'fill', value: c.value }, ...c.layers.map((layer) => /** @type {Op} */ ({ op: 'layer', layer }))] });
    }
    ops = resolverConstantes(canal, ops);
    if (ops.length !== 1 || ops[0].op !== 'fill') {
      if (!isMappable(canal)) throw new Error(`${canal} no acepta mapas en three.js: va un valor (y las capas de material sobre él, sin máscara)`);
      channels[canal] = { type: 'texture', ops };
    } else channels[canal] = { type: 'constant', value: ops[0].value };
  }
  // normal y bump terminan en el mismo mapa: el relieve se hornea como normal
  const normal = { from: channels.normal ?? null, bump: channels.bump && channels.bump.type === 'texture' ? channels.bump : null };
  return { def: d, channels, normal };
}

/**
 * Las mezclas que se pueden resolver sin textura: capas de material sin máscara cuyos valores
 * son constantes. Quedan como un solo 'fill'.
 * @param {string} canal @param {Op[]} ops @returns {Op[]}
 */
function resolverConstantes(canal, ops) {
  const tipo = CHANNELS[canal].type;
  /** @type {Op[]} */
  const out = [];
  for (const op of ops) {
    const prev = out[out.length - 1];
    const sub = op.op === 'mix' ? resolverConstantes(canal, op.ops) : null;
    if (op.op === 'mix' && !op.mask && sub?.length === 1 && sub[0].op === 'fill' && prev?.op === 'fill' && tipo !== 'normal') {
      const a = prev.value, b = sub[0].value;
      if (tipo === 'scalar') prev.value = layerValue('normal', /** @type {number} */ (a), /** @type {number} */ (b), op.opacity);
      else {
        const la = hexToLinear(/** @type {string} */ (a)), lb = hexToLinear(/** @type {string} */ (b));
        prev.value = linearToHex(/** @type {[number, number, number]} */ (la.map((x, i) => layerValue('normal', x, lb[i], op.opacity))));
      }
      continue;
    }
    out.push(op.op === 'mix' ? { ...op, ops: /** @type {Op[]} */ (sub) } : op);
  }
  return out;
}

/** JSON con las claves ordenadas, para que el hash no dependa del orden en que se escribió. @param {unknown} v @returns {string} */
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(/** @type {Record<string, unknown>} */ (v)[k])}`).join(',')}}`;
  if (v === Infinity) return '"Infinity"';
  return JSON.stringify(v);
}

/**
 * Un identificador corto del material: dos definiciones iguales (aunque escritas distinto)
 * dan el mismo. `extra`: lo que también cambia el resultado (las versiones de los generadores).
 * @param {MaterialDef | Record<string, unknown>} def @param {string} [extra]
 */
export function hashMaterial(def, extra = '') {
  const d = normalizado(/** @type {Record<string, unknown>} */ (def));
  const s = stableStringify(d) + extra;
  // FNV-1a de 53 bits
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return ((h2 >>> 0) * 2 ** 21 + ((h1 >>> 0) >>> 11)).toString(36);
}

/** Los generadores que usa un material (para pedir sus versiones al hashear). @param {MaterialDef} d @returns {string[]} */
export function generatorsOf(d) {
  const out = new Set();
  /** @param {Mask | Layer | null} m */
  const ver = (m) => {
    if (!m) return;
    if (m.source.kind === 'generator') out.add(m.source.name);
    if ('mask' in m) ver(m.mask);
  };
  const canales = [...Object.values(d.channels), ...d.layers.flatMap((l) => { ver(l.mask); return Object.values(l.channels); })];
  for (const c of canales) c.layers.forEach(ver);
  return [...out].sort();
}
