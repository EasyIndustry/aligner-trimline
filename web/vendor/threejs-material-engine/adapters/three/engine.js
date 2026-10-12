// El motor de materiales para three.js: hornea en la GPU lo que dice el plan de un material
// (generadores, imágenes, capas, máscaras, capas de material) y arma un MeshPhysicalMaterial.
//
//   const materiales = createMaterialEngine(renderer);
//   const mat = await materiales.material({ channels: { baseColor: '#b03a2e', roughness: 0.4 } });
//   materiales.registerGenerator(miPlugin);   // un generador de la app (ver src/generators.js)
//   materiales.help();
//
// Todo pasa por render targets: cada capa es un pase de un shader de composición sobre lo de
// abajo. Los colores se componen en lineal (los targets de color son sRGB: la GPU codifica al
// escribir y decodifica al leer). Lo horneado se cachea por hash: el mismo material pedido
// dos veces se hornea una.
import * as THREE from 'three';
import { CHANNELS, OUTPUTS } from '../../src/channels.js';
import { BLEND_MODES, BLEND_GLSL } from '../../src/blend.js';
import { defineMaterial, planMaterial, hashMaterial, generatorsOf } from '../../src/material.js';
import { getGenerator, registerGenerator, listGenerators, resolveParams, paramUniformsGLSL, SURFACE_GLSL, NOISE_GLSL } from '../../src/generators.js';
import { help } from '../../src/help.js';
import { ENGINE_MEMBERS } from '../../src/members.js';
import { applyTriplanar } from './triplanar.js';

const READ = { rgb: 0, r: 1, g: 2, b: 3, a: 4, luminance: 5 };
const WRAP = { repeat: 0, mirror: 1, clamp: 2 };
const TIPO = { color: 0, scalar: 1, normal: 2 };
const IDENTIDAD = Object.freeze({ repeat: [1, 1], offset: [0, 0], rotation: 0, wrap: 'clamp' });

const VERT_QUAD = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// Una capa sobre lo de abajo. La fuente se muestrea con su transformación (las de un generador
// ya vienen horneadas con la suya y van con la identidad).
const FRAG_COMPONER = /* glsl */ `
uniform sampler2D tPrev, tSrc, tMask;
uniform bool hasPrev, hasSrc, hasMask, hasRemap, hasTint, invertir;
uniform vec4 srcConst;
uniform vec2 repeatUV, offsetUV, remap;
uniform float rotacion, opacidad;
uniform int wrapMode, readMode, blendMode, tipo;
uniform vec3 tinte;
varying vec2 vUv;
${BLEND_GLSL}
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
void main() {
  vec2 p = vUv - 0.5;
  float c = cos(rotacion), s = sin(rotacion);
  p = vec2(c * p.x - s * p.y, s * p.x + c * p.y) * repeatUV + 0.5 + offsetUV;
  vec2 q = wrapMode == 0 ? fract(p) : wrapMode == 1 ? 1.0 - abs(mod(p, 2.0) - 1.0) : clamp(p, 0.0, 1.0);
  // derivadas de p (sin el corte del fract), para que el mipmap no deje una costura al repetir
  vec4 src = hasSrc ? texture2DGradEXT(tSrc, q, dFdx(p), dFdy(p)) : srcConst;
  float uno = readMode == 1 ? src.r : readMode == 2 ? src.g : readMode == 3 ? src.b : readMode == 4 ? src.a : lum(src.rgb);
  vec3 v = (tipo != 1 && readMode == 0) ? src.rgb : vec3(uno);
  if (invertir && tipo != 2) v = 1.0 - v;
  if (hasRemap && tipo != 2) v = mix(vec3(remap.x), vec3(remap.y), v);
  if (hasTint) v *= tinte;
  float m = opacidad * (hasMask ? texture2D(tMask, vUv).r : 1.0);
  vec3 abajo = hasPrev ? texture2D(tPrev, vUv).rgb : vec3(0.0);
  vec3 r;
  if (tipo == 2) {
    vec3 a = hasPrev ? abajo * 2.0 - 1.0 : vec3(0.0, 0.0, 1.0), b = v * 2.0 - 1.0;
    vec3 f = blendMode == 0 ? b : normalize(vec3(a.xy + b.xy, a.z * b.z)); // 'normal' reemplaza; el resto suma relieve
    r = normalize(mix(a, f, m)) * 0.5 + 0.5;
  } else {
    r = mix(abajo, mtlBlend(blendMode, abajo, v), m);
  }
  gl_FragColor = tipo == 1 ? vec4(r.r) : vec4(r, 1.0);
}`;

// Relieve (altura) a normal, sumado al mapa de normales si hay.
const FRAG_RELIEVE = /* glsl */ `
uniform sampler2D tAltura, tNormal;
uniform bool hasNormal;
uniform vec2 texel, fuerza;
varying vec2 vUv;
float h(vec2 o) { return texture2D(tAltura, vUv + o * texel).r; }
void main() {
  vec2 d = vec2(h(vec2(1.0, 0.0)) - h(vec2(-1.0, 0.0)), h(vec2(0.0, 1.0)) - h(vec2(0.0, -1.0))) * 0.5;
  vec3 b = normalize(vec3(-d * fuerza, 1.0));
  vec3 n = b;
  if (hasNormal) { vec3 a = texture2D(tNormal, vUv).rgb * 2.0 - 1.0; n = normalize(vec3(a.xy + b.xy, a.z * b.z)); }
  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
}`;

// Promedio de ss×ss texels del dibujo grande (sobremuestreo); las normales se renormalizan.
const FRAG_REDUCIR = /* glsl */ `
uniform sampler2D tSrc;
uniform int ss;
uniform bool esNormal;
uniform vec2 srcTexel;
void main() {
  vec2 base = floor(gl_FragCoord.xy) * float(ss);
  vec4 suma = vec4(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    if (i >= ss || j >= ss) continue;
    vec4 t = texture2D(tSrc, (base + vec2(float(i), float(j)) + 0.5) * srcTexel);
    suma += esNormal ? vec4(t.rgb * 2.0 - 1.0, t.a) : t;
  }
  suma /= float(ss * ss);
  gl_FragColor = esNormal ? vec4(normalize(suma.rgb) * 0.5 + 0.5, 1.0) : suma;
}`;

/** Los mapas de three.js por canal, y el valor que lleva la propiedad cuando hay mapa. */
const NEUTRO = { color: '#ffffff', scalar: 1 };

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {{ anisotropy?: number, portable?: boolean }} [opts] `anisotropy`: filtrado de los mapas horneados (8 o lo que
 *   dé la placa). `portable` (true): cada mapa terminado se baja a memoria (DataTexture), así sirve en
 *   cualquier renderer o contexto (el path tracer, un exportador); con false queda solo en la GPU de este
 *   renderer, que es un poco más rápido pero no se puede leer desde otro contexto.
 */
export function createMaterialEngine(renderer, { anisotropy = 8, portable = true } = {}) {
  const aniso = Math.min(anisotropy, renderer.capabilities.getMaxAnisotropy());
  const camara = new THREE.OrthographicCamera();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  const escena = new THREE.Scene();
  escena.add(quad);

  const componer = new THREE.ShaderMaterial({
    vertexShader: VERT_QUAD, fragmentShader: FRAG_COMPONER, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    uniforms: {
      tPrev: { value: null }, tSrc: { value: null }, tMask: { value: null },
      hasPrev: { value: false }, hasSrc: { value: false }, hasMask: { value: false }, hasRemap: { value: false }, hasTint: { value: false }, invertir: { value: false },
      srcConst: { value: new THREE.Vector4() }, repeatUV: { value: new THREE.Vector2(1, 1) }, offsetUV: { value: new THREE.Vector2() }, remap: { value: new THREE.Vector2(0, 1) },
      rotacion: { value: 0 }, opacidad: { value: 1 }, wrapMode: { value: 0 }, readMode: { value: 0 }, blendMode: { value: 0 }, tipo: { value: 0 }, tinte: { value: new THREE.Color() },
    },
  });
  const relieve = new THREE.ShaderMaterial({
    vertexShader: VERT_QUAD, fragmentShader: FRAG_RELIEVE, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    uniforms: { tAltura: { value: null }, tNormal: { value: null }, hasNormal: { value: false }, texel: { value: new THREE.Vector2() }, fuerza: { value: new THREE.Vector2() } },
  });
  const reducir = new THREE.ShaderMaterial({
    vertexShader: VERT_QUAD, fragmentShader: FRAG_REDUCIR, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    uniforms: { tSrc: { value: null }, ss: { value: 1 }, esNormal: { value: false }, srcTexel: { value: new THREE.Vector2() } },
  });

  /** Un render target del tamaño dado; los de color, en sRGB. `final`: con mipmaps y repetición, para usar en un material. */
  function target(w, h, srgb, final = false) {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.UnsignedByteType, depthBuffer: false,
      colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
      generateMipmaps: final, minFilter: final ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
    });
    if (final) rt.texture.anisotropy = aniso;
    return rt;
  }

  /** Dibuja un material de pase a un target. @param {THREE.Material} mat @param {THREE.WebGLRenderTarget} rt */
  function dibujar(mat, rt) {
    quad.material = mat;
    renderer.setRenderTarget(rt);
    renderer.render(escena, camara);
  }

  // ---------- generadores: un programa por generador, compilado una vez ----------
  /** @type {Map<string, { mat: THREE.ShaderMaterial, uniformsPlugin: Record<string, { value: unknown }> | null }>} */
  const programas = new Map();
  const mallaGen = new THREE.Mesh();
  mallaGen.frustumCulled = false;
  const escenaGen = new THREE.Scene();
  escenaGen.add(mallaGen);
  /** @type {Map<string, THREE.BufferGeometry>} */
  const planos = new Map();

  /** @param {ReturnType<typeof getGenerator>} g */
  function programa(g) {
    let p = programas.get(g.name);
    if (p && p.version === g.version) return p;
    p?.mat.dispose();
    const uniforms = {
      mtl_out: { value: 0 }, mtl_repeat: { value: new THREE.Vector2(1, 1) }, mtl_offset: { value: new THREE.Vector2() }, mtl_rot: { value: 0 },
    };
    for (const [k, spec] of Object.entries(g.params)) {
      if (spec.type === 'color') uniforms[`p_${k}`] = { value: new THREE.Color() };
      else if (['number', 'int', 'bool'].includes(spec.type)) uniforms[`p_${k}`] = { value: spec.default };
    }
    const mat = new THREE.ShaderMaterial({
      uniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending, side: THREE.DoubleSide,
      vertexShader: `varying vec2 vUv; varying vec3 vPos; varying vec3 vNrm;\n${g.vertex?.pars ?? ''}\nvoid main() { vUv = uv; vPos = position; vNrm = normal; ${g.vertex?.main ?? ''}\n gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0); }`,
      fragmentShader: `${SURFACE_GLSL}\n${NOISE_GLSL}\nvarying vec2 vUv; varying vec3 vPos; varying vec3 vNrm;\nuniform int mtl_out; uniform vec2 mtl_repeat, mtl_offset; uniform float mtl_rot;\n`
        + 'vec2 mtl_uv() { vec2 p = vUv - 0.5; float c = cos(mtl_rot), s = sin(mtl_rot); return vec2(c * p.x - s * p.y, s * p.x + c * p.y) * mtl_repeat + 0.5 + mtl_offset; }\n'
        + `${paramUniformsGLSL(g)}\n${g.fragment}\nvoid main() { Surface s = surfaceDefault(); generate(s); gl_FragColor = surfaceOut(s, mtl_out); }`,
    });
    p = { mat, version: g.version, uniformsPlugin: null };
    programas.set(g.name, p);
    return p;
  }

  /** El plano del generador: la textura entera (uv) o el que dice el plugin (solid). */
  function planoDe(g, params) {
    if (g.space === 'uv') {
      if (!planos.has('uv')) planos.set('uv', cuadro([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], [0, 0, 1]));
      return /** @type {THREE.BufferGeometry} */ (planos.get('uv'));
    }
    const pl = /** @type {NonNullable<typeof g.plane>} */ (g.plane)(params);
    const k = JSON.stringify(pl);
    if (!planos.has(k)) planos.set(k, cuadro(pl.corners, pl.normal));
    return /** @type {THREE.BufferGeometry} */ (planos.get(k));
  }
  /** @param {number[][]} c esquinas (0,0) (1,0) (1,1) (0,1) @param {number[]} n */
  function cuadro(c, n) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(c.flat(), 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute([...n, ...n, ...n, ...n], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    return geo;
  }

  /** Pisa los .value de los uniforms del programa (mismo objeto, para no recompilar). */
  function copiar(dst, src) {
    if (dst?.copy && src) return dst.copy(src);
    if (Array.isArray(dst) && Array.isArray(src)) { src.forEach((s, i) => { dst[i] = copiar(dst[i], s); }); return dst; }
    return src;
  }

  /**
   * Hornea una salida de un generador al tamaño w×h (con sobremuestreo).
   * @param {{ name: string, params: Record<string, unknown> }} src @param {string} salida @param {number} w @param {number} h @param {number} ss
   * @param {{ repeat: number[], offset: number[], rotation: number }} tr
   */
  function hornearGenerador(src, salida, w, h, ss, tr) {
    const g = getGenerator(src.name);
    if (!g.outputs.includes(salida)) throw new Error(`${g.name} no da '${salida}' (da ${g.outputs.join(', ')}): elegí otra salida con output, o usalo en otro canal`);
    const params = resolveParams(g, src.params);
    const p = programa(g);
    const u = p.mat.uniforms;
    for (const [k, spec] of Object.entries(g.params)) {
      if (spec.type === 'color') u[`p_${k}`].value.set(params[k]);
      else if (`p_${k}` in u) u[`p_${k}`].value = params[k];
    }
    if (g.uniforms) {
      const extra = g.uniforms(params, { width: w, height: h, supersample: ss });
      for (const [k, v] of Object.entries(extra)) {
        if (!u[k]) u[k] = { value: v.value };
        else u[k].value = copiar(u[k].value, v.value);
      }
    }
    u.mtl_out.value = OUTPUTS.indexOf(salida);
    u.mtl_repeat.value.set(tr.repeat[0], tr.repeat[1]);
    u.mtl_offset.value.set(tr.offset[0], tr.offset[1]);
    u.mtl_rot.value = (tr.rotation * Math.PI) / 180;
    const srgb = salida === 'color' || salida === 'emissive';
    mallaGen.geometry = planoDe(g, params);
    mallaGen.material = p.mat;
    const grande = target(w * ss, h * ss, srgb);
    renderer.setRenderTarget(grande);
    renderer.render(escenaGen, camara);
    const rt = target(w, h, srgb);
    reducir.uniforms.tSrc.value = grande.texture;
    reducir.uniforms.ss.value = ss;
    reducir.uniforms.esNormal.value = salida === 'normal';
    reducir.uniforms.srcTexel.value.set(1 / (w * ss), 1 / (h * ss));
    dibujar(reducir, rt);
    grande.dispose();
    return rt;
  }

  // ---------- imágenes ----------
  const cargador = new THREE.TextureLoader();
  /** @type {Map<string, Promise<THREE.Texture>>} */
  const imagenes = new Map();
  /** @param {string} url @param {boolean} srgb */
  function imagen(url, srgb) {
    const k = `${srgb ? 'srgb' : 'lin'}:${url}`;
    if (!imagenes.has(k)) {
      imagenes.set(k, cargador.loadAsync(url).then((t) => {
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = aniso;
        return t;
      }).catch((e) => { imagenes.delete(k); throw new Error(`no se pudo cargar la imagen ${url}: ${e?.message ?? e}`); }));
    }
    return /** @type {Promise<THREE.Texture>} */ (imagenes.get(k));
  }

  // ---------- el horneado de un canal ----------
  /**
   * Un pase de composición. @param {object} o
   * @returns {THREE.WebGLRenderTarget}
   */
  function pase({ tipo, srgb, w, h, prev = null, tex = null, constante = null, transform = IDENTIDAD, read = 'rgb', invert = false, remap = null, tint = null, blend = 'normal', opacity = 1, mask = null, final = false }) {
    const u = componer.uniforms;
    u.tipo.value = TIPO[tipo];
    u.hasPrev.value = !!prev; u.tPrev.value = prev?.texture ?? null;
    u.hasSrc.value = !!tex; u.tSrc.value = tex;
    if (constante) u.srcConst.value.copy(constante);
    u.repeatUV.value.set(transform.repeat[0], transform.repeat[1]);
    u.offsetUV.value.set(transform.offset[0], transform.offset[1]);
    u.rotacion.value = (transform.rotation * Math.PI) / 180;
    u.wrapMode.value = WRAP[transform.wrap];
    u.readMode.value = READ[read];
    u.invertir.value = invert;
    u.hasRemap.value = !!remap; if (remap) u.remap.value.set(remap[0], remap[1]);
    u.hasTint.value = !!tint; if (tint) u.tinte.value.set(tint);
    u.blendMode.value = BLEND_MODES.indexOf(blend);
    u.opacidad.value = opacity;
    u.hasMask.value = !!mask; u.tMask.value = mask?.texture ?? null;
    const rt = target(w, h, srgb, final);
    dibujar(componer, rt);
    return rt;
  }

  /** El valor constante de un canal como vec4 lineal. @param {string} tipo @param {string | number} v */
  function constante(tipo, v) {
    if (tipo === 'normal') return new THREE.Vector4(0.5, 0.5, 1, 1);
    if (tipo === 'color') { const c = new THREE.Color(/** @type {string} */ (v)); return new THREE.Vector4(c.r, c.g, c.b, 1); }
    return new THREE.Vector4(/** @type {number} */ (v), v, v, v);
  }

  /** La salida que usa una fuente generador en un canal (o en una máscara). */
  function salidaDe(src, canal) {
    if (src.output) return src.output;
    if (canal) return CHANNELS[canal].output;
    const g = getGenerator(src.name);
    return ['alpha', 'height', 'roughness', 'ao', 'metalness'].find((o) => g.outputs.includes(o)) ?? g.outputs[0];
  }

  /**
   * La textura de una fuente, para un canal (o una máscara si canal es null): una imagen, o un
   * generador horneado (que ya trae su transformación).
   */
  async function texturaDe(capa, canal, w, h, ss, temporales) {
    const src = capa.source;
    if (src.kind === 'image') return { tex: await imagen(src.url, !!canal && !!CHANNELS[canal].srgb), transform: capa.transform };
    if (src.kind === 'generator') {
      const rt = hornearGenerador(src, salidaDe(src, canal), w, h, ss, capa.transform);
      temporales.push(rt);
      return { tex: rt.texture, transform: IDENTIDAD };
    }
    const tipo = canal ? CHANNELS[canal].type : 'scalar';
    return { tex: null, transform: IDENTIDAD, constante: src.kind === 'color' ? constante('color', src.value) : constante(tipo === 'color' ? 'scalar' : tipo, src.value) };
  }

  /** Una máscara horneada (gris, a la resolución del canal). */
  async function mascara(m, w, h, ss) {
    const temporales = [];
    const t = await texturaDe(m, null, w, h, ss, temporales);
    const rt = pase({ tipo: 'scalar', srgb: false, w, h, tex: t.tex, constante: t.constante, transform: t.transform, read: m.read, invert: m.invert, remap: m.remap });
    temporales.forEach((x) => x.dispose());
    return rt;
  }

  /** Los pasos de un canal → un render target. */
  async function ejecutar(ops, canal, w, h, ss) {
    const info = CHANNELS[canal];
    const base = { tipo: info.type, srgb: !!info.srgb, w, h };
    /** @type {THREE.WebGLRenderTarget | null} */
    let acc = null;
    for (const op of ops) {
      /** @type {THREE.WebGLRenderTarget[]} */
      const temporales = [];
      let nuevo;
      if (op.op === 'fill') {
        nuevo = pase({ ...base, constante: constante(info.type, op.value) });
      } else if (op.op === 'layer') {
        const l = op.layer;
        const t = await texturaDe(l, canal, w, h, ss, temporales);
        const m = l.mask ? await mascara(l.mask, w, h, ss) : null;
        if (m) temporales.push(m);
        nuevo = pase({ ...base, prev: acc, tex: t.tex, constante: t.constante, transform: t.transform, read: l.read, invert: l.invert, remap: l.remap, tint: l.tint, blend: l.blend, opacity: l.opacity, mask: m });
      } else {
        const sub = await ejecutar(op.ops, canal, w, h, ss);
        temporales.push(sub);
        const m = op.mask ? await mascara(op.mask, w, h, ss) : null;
        if (m) temporales.push(m);
        nuevo = pase({ ...base, prev: acc, tex: sub.texture, read: info.type === 'scalar' ? 'r' : 'rgb', opacity: op.opacity, mask: m });
      }
      acc?.dispose();
      temporales.forEach((x) => x.dispose());
      acc = nuevo;
    }
    return /** @type {THREE.WebGLRenderTarget} */ (acc);
  }

  /**
   * Baja un target terminado a memoria: una DataTexture con los mismos bytes (los de color ya en
   * sRGB), que se sube sola a cualquier contexto. Las filas quedan de abajo hacia arriba, como en el
   * target (v = 0 abajo), así que va sin flipY.
   * @param {THREE.WebGLRenderTarget} rt
   */
  function aDatos(rt) {
    const { width: w, height: h } = rt;
    const px = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
    const t = new THREE.DataTexture(px, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.colorSpace = rt.texture.colorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = aniso;
    t.needsUpdate = true;
    rt.dispose();
    return t;
  }
  /** El mapa terminado: en memoria (portable) o el del target. */
  const terminar = (rt, targets) => {
    if (portable) return aDatos(rt);
    targets.push(rt);
    return rt.texture;
  };

  // ---------- la caché: lo horneado por hash ----------
  /** @type {Map<string, { textures: Record<string, THREE.Texture>, targets: THREE.WebGLRenderTarget[], propias: THREE.Texture[], material: THREE.MeshPhysicalMaterial | null, plan: ReturnType<typeof planMaterial> }>} */
  const cache = new Map();
  /** @type {Map<string, Promise<any>>} */
  const enCurso = new Map();
  let cola = Promise.resolve();

  /** El hash de un material, con las versiones de sus generadores (cambiar un generador lo invalida). */
  function hashDe(d) {
    return hashMaterial(d, generatorsOf(d).map((n) => `${n}@${getGenerator(n).version}`).join(','));
  }

  async function hornearAhora(d, k, onProgress) {
    const plan = planMaterial(d);
    const [w, h] = d.resolution;
    const ss = d.supersample;
    const prevRT = renderer.getRenderTarget();
    const prevClear = renderer.autoClear;
    renderer.autoClear = true;
    /** @type {Record<string, THREE.Texture>} */
    const textures = {};
    /** @type {THREE.WebGLRenderTarget[]} */
    const targets = [];
    const canales = Object.entries(plan.channels).filter(([c, p]) => p.type === 'texture' && c !== 'normal' && c !== 'bump');
    const total = canales.length + (plan.normal.from?.type === 'texture' || plan.normal.bump ? 1 : 0);
    let hechos = 0;
    try {
      for (const [canal, p] of canales) {
        const acc = await ejecutar(/** @type {any} */ (p).ops, canal, w, h, ss);
        const info = CHANNELS[canal];
        const fin = pase({ tipo: info.type, srgb: !!info.srgb, w, h, tex: acc.texture, read: info.type === 'scalar' ? 'r' : 'rgb', final: true });
        acc.dispose();
        textures[canal] = terminar(fin, targets);
        onProgress?.(++hechos / total, canal);
      }
      if (plan.normal.from?.type === 'texture' || plan.normal.bump) {
        const n = plan.normal.from?.type === 'texture' ? await ejecutar(plan.normal.from.ops, 'normal', w, h, ss) : null;
        let fin;
        if (plan.normal.bump) {
          const alt = await ejecutar(plan.normal.bump.ops, 'bump', w, h, ss);
          const r = relieve.uniforms;
          r.tAltura.value = alt.texture; r.hasNormal.value = !!n; r.tNormal.value = n?.texture ?? null;
          r.texel.value.set(1 / w, 1 / h);
          r.fuerza.value.set(0.02 * d.bumpStrength * w, 0.02 * d.bumpStrength * h);
          fin = target(w, h, false, true);
          dibujar(relieve, fin);
          alt.dispose();
        } else {
          fin = pase({ tipo: 'normal', srgb: false, w, h, tex: /** @type {THREE.WebGLRenderTarget} */ (n).texture, final: true });
        }
        n?.dispose();
        textures.normal = terminar(fin, targets);
        onProgress?.(++hechos / total, 'normal');
      }
    } catch (e) {
      targets.forEach((t) => t.dispose());
      Object.values(textures).forEach((t) => t.dispose());
      throw e;
    } finally {
      renderer.setRenderTarget(prevRT);
      renderer.autoClear = prevClear;
    }
    const entrada = { textures, targets, propias: portable ? Object.values(textures) : [], material: null, plan };
    cache.set(k, entrada);
    return entrada;
  }

  /** Suelta lo de una entrada de la caché: sus targets, sus texturas propias y su material. */
  function soltar(e) {
    e.targets.forEach((t) => t.dispose());
    e.propias.forEach((t) => t.dispose());
    e.material?.dispose();
  }

  /** Hornea (o devuelve de la caché) un material. Una sola cola: la GPU hace una cosa a la vez. */
  function hornear(def, onProgress) {
    const d = defineMaterial(def);
    const k = hashDe(d);
    if (cache.has(k)) return Promise.resolve({ k, entrada: /** @type {any} */ (cache.get(k)) });
    if (!enCurso.has(k)) {
      const run = cola.then(() => hornearAhora(d, k, onProgress));
      cola = run.catch(() => {});
      enCurso.set(k, run.finally(() => enCurso.delete(k)));
    }
    return /** @type {Promise<any>} */ (enCurso.get(k)).then((entrada) => ({ k, entrada }));
  }

  /** El MeshPhysicalMaterial de un plan, con las texturas horneadas. */
  function armar(plan, textures) {
    const d = plan.def;
    const mat = new THREE.MeshPhysicalMaterial({ name: d.name });
    for (const [canal, info] of Object.entries(CHANNELS)) {
      const p = plan.channels[canal];
      if (!p || !info.prop && !info.map) continue;
      const tex = textures[canal];
      if (canal === 'alpha' && d.alphaMode === 'opaque') continue;
      if (tex && info.map) {
        /** @type {any} */ (mat)[info.map] = tex;
        if (info.prop) {
          if (info.type === 'color') /** @type {any} */ (mat)[info.prop].set(NEUTRO.color);
          else /** @type {any} */ (mat)[info.prop] = NEUTRO.scalar;
        }
      } else if (p.type === 'constant' && info.prop) {
        if (info.type === 'color') /** @type {any} */ (mat)[info.prop].set(/** @type {string} */ (p.value));
        else /** @type {any} */ (mat)[info.prop] = p.value;
      }
    }
    if (textures.normal) { mat.normalMap = textures.normal; mat.normalScale.set(d.normalScale, d.normalScale); }
    if (textures.displacement) { mat.displacementScale = d.displacementScale; mat.displacementBias = d.displacementBias; }
    if (textures.ao) mat.aoMapIntensity = d.aoIntensity;
    mat.emissiveIntensity = d.emissiveIntensity;
    mat.ior = d.ior;
    mat.attenuationColor.set(d.attenuationColor);
    mat.attenuationDistance = d.attenuationDistance;
    mat.iridescenceIOR = d.iridescenceIOR;
    mat.anisotropyRotation = (d.anisotropyRotation * Math.PI) / 180;
    mat.side = d.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
    if (d.alphaMode === 'mask') { mat.alphaTest = d.alphaCutoff; mat.transparent = false; }
    else if (d.alphaMode === 'blend') mat.transparent = true;
    else { mat.opacity = 1; mat.transparent = false; }
    if (d.mapping.type === 'triplanar') applyTriplanar(mat, d.mapping);
    mat.userData.materialEngine = { hash: hashDe(d), name: d.name };
    return mat;
  }

  const motor = {
    renderer,
    /** La definición completa y validada (ver defineMaterial). @param {Record<string, unknown>} def */
    define: (def) => defineMaterial(def),
    /** Qué se hornea y qué queda constante. @param {Record<string, unknown>} def */
    plan: (def) => planMaterial(defineMaterial(def)),
    /** El identificador del material, con las versiones de sus generadores. @param {Record<string, unknown>} def */
    hash: (def) => hashDe(defineMaterial(def)),

    /**
     * El MeshPhysicalMaterial de una definición: hornea lo que haga falta (una vez por hash) y lo
     * arma. Devuelve siempre el mismo material para la misma definición; con { clone: true },
     * uno nuevo que comparte las texturas.
     * @param {Record<string, unknown>} def @param {{ clone?: boolean, onProgress?: (f: number, canal: string) => void }} [opts]
     */
    async material(def, { clone = false, onProgress } = {}) {
      const { entrada } = await hornear(def, onProgress);
      entrada.material ??= armar(entrada.plan, entrada.textures);
      if (!clone) return entrada.material;
      // three no copia onBeforeCompile al clonar: el mapeo triplanar se vuelve a poner
      const copia = entrada.material.clone();
      if (entrada.plan.def.mapping.type === 'triplanar') applyTriplanar(copia, entrada.plan.def.mapping);
      return copia;
    },

    /** Solo hornea: { hash, textures: { canal: Texture }, plan }. @param {Record<string, unknown>} def @param {{ onProgress?: (f: number, canal: string) => void }} [opts] */
    async bake(def, { onProgress } = {}) {
      const { k, entrada } = await hornear(def, onProgress);
      return { hash: k, textures: { ...entrada.textures }, plan: entrada.plan };
    },

    /**
     * Los mapas horneados como imágenes (para guardarlos como prehorneados): { hash, files:
     * { canal: Blob } }. La fila de arriba de la imagen es v = 1, como la carga TextureLoader.
     * @param {Record<string, unknown>} def @param {{ type?: string, quality?: number }} [opts]
     */
    async exportBaked(def, { type = 'image/png', quality = 0.92 } = {}) {
      const { k, entrada } = await hornear(def);
      /** @type {Record<string, Blob>} */
      const files = {};
      for (const [canal, tex] of Object.entries(entrada.textures)) {
        const c = document.createElement('canvas');
        const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
        const rt = entrada.targets.find((t) => t.texture === tex);
        if (tex.isDataTexture || rt) {
          // bytes del horneado: filas de abajo hacia arriba, se dan vuelta para la imagen
          const w = rt ? rt.width : tex.image.width, h = rt ? rt.height : tex.image.height;
          let px = tex.isDataTexture ? /** @type {Uint8Array} */ (tex.image.data) : new Uint8Array(w * h * 4);
          if (rt) renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
          c.width = w; c.height = h;
          const img = new ImageData(w, h);
          for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
          g.putImageData(img, 0, 0);
        } else {
          // una imagen cargada (de loadBaked): ya está con v = 1 arriba
          c.width = tex.image.width; c.height = tex.image.height;
          g.drawImage(tex.image, 0, 0);
        }
        files[canal] = await new Promise((ok, mal) => c.toBlob((b) => (b ? ok(b) : mal(new Error(`no se pudo exportar ${canal}`))), type, quality));
      }
      return { hash: k, files };
    },

    /**
     * Un material desde mapas ya horneados (prehorneados), sin hornear: { canal: URL }. Las
     * constantes salen de la definición; los canales con textura, de las imágenes.
     * @param {Record<string, unknown>} def @param {Record<string, string>} files
     */
    async loadBaked(def, files) {
      const d = defineMaterial(def);
      const k = hashDe(d);
      const plan = planMaterial(d);
      /** @type {Record<string, THREE.Texture>} */
      const textures = {};
      for (const [canal, url] of Object.entries(files)) {
        if (!(canal in CHANNELS)) throw new Error(`canal desconocido en los prehorneados: ${canal}`);
        textures[canal] = await imagen(url, !!CHANNELS[canal].srgb);
      }
      const faltan = Object.entries(plan.channels).filter(([c, p]) => p.type === 'texture' && c !== 'bump' && !textures[c] && !(c === 'normal' && textures.normal));
      if (faltan.length) throw new Error(`faltan prehorneados de ${faltan.map(([c]) => c).join(', ')}`);
      // las imágenes son de la caché de imágenes: release no las suelta (propias vacío)
      const entrada = { textures, targets: [], propias: [], material: null, plan };
      entrada.material = armar(plan, textures);
      cache.set(k, entrada);
      return entrada.material;
    },

    /** Agrega un generador (o el plugin de una app). Ver src/generators.js. */
    registerGenerator(gen) {
      const g = registerGenerator(gen);
      programas.get(g.name)?.mat.dispose();
      programas.delete(g.name);
      return g;
    },
    /** Los generadores que hay: { name, version, space, outputs, params, doc }. */
    generators: () => listGenerators(),

    /** Suelta lo horneado de un material (texturas, targets y su MeshPhysicalMaterial). @param {Record<string, unknown>} def */
    release(def) {
      const k = hashDe(defineMaterial(def));
      const e = cache.get(k);
      if (!e) return false;
      soltar(e);
      cache.delete(k);
      return true;
    },

    /** Qué hay en memoria: materiales, texturas y megabytes aproximados (con mipmaps). */
    stats() {
      let texturas = 0, bytes = 0;
      for (const e of cache.values()) for (const t of Object.values(e.textures)) {
        texturas++;
        const { width: w = 0, height: h = 0 } = t.image ?? {};
        bytes += w * h * 4 * (t.generateMipmaps ? 4 / 3 : 1) * (t.isDataTexture ? 2 : 1); // en memoria y en la GPU
      }
      return { materials: cache.size, textures: texturas, megabytes: +(bytes / 2 ** 20).toFixed(1), programs: programas.size };
    },

    /** Lo suelta todo: lo horneado, los programas y las imágenes. */
    dispose() {
      for (const e of cache.values()) soltar(e);
      cache.clear();
      for (const p of programas.values()) p.mat.dispose();
      programas.clear();
      for (const g of planos.values()) g.dispose();
      planos.clear();
      for (const t of imagenes.values()) t.then((x) => x.dispose()).catch(() => {});
      imagenes.clear();
      [componer, relieve, reducir].forEach((m) => m.dispose());
      quad.geometry.dispose();
    },

    /** @param {{ print?: boolean }} [o] */
    help(o) { return help('MaterialEngine — materiales por capas, horneados en la GPU', ENGINE_MEMBERS, o); },
  };
  return motor;
}
