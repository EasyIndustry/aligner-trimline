// El render final, con un click: path tracing de la escena tal como está (three-gpu-pathtracer),
// a una imagen. Corre en un renderer aparte, del tamaño pedido, así el visor sigue andando y
// el tamaño de la imagen no depende del de la ventana.
//
// three-gpu-pathtracer se carga recién la primera vez que se pide un render (import dinámico):
// una app que nunca renderiza no lo necesita en su importmap.
//
// Lo que el path tracer no entiende se resuelve acá:
//   - el entorno del visor (PMREM) no es equirectangular: durante el render va el HDRI
//     (motor.hdri) si hay, y si no un degradé cielo/suelo del preset;
//   - la luz hemisférica no existe para él: ese relleno lo da el entorno;
//   - líneas, grillas, sprites, espejos (Reflector), lo de material de shader propio y lo marcado
//     con `userData.noRender` no salen en la imagen (ver flags.js).
import * as THREE from 'three';
import { sinRender } from './flags.js';

/** @typedef {import('./presets.js').Preset} Preset */
/**
 * @typedef {{ samples?: number, width?: number, height?: number, bounces?: number,
 *   camera?: THREE.Camera, onProgress?: (fraction: number, samples: number) => void,
 *   signal?: AbortSignal, type?: string }} RenderOptions
 */

/** @type {Promise<any> | null} */
let modulo = null;
const cargar = () => (modulo ??= import('three-gpu-pathtracer').catch((e) => {
  modulo = null;
  throw new Error(`no se pudo cargar three-gpu-pathtracer (¿está en el importmap, junto con "three/examples/jsm/"?): ${e.message}`);
}));

/** El navegador pinta entre tanda y tanda de muestras. */
const cuadro = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

/**
 * Una malla con varios materiales, partida en una malla por grupo, cada una con su material.
 * three-gpu-pathtracer (hasta la 0.0.23 al menos) numera los grupos de la escena junta por
 * malla pero despliega los arrays de materiales, así que una malla con varios materiales corre
 * los índices de todas las que vienen después: una pieza toma el material de otra. De a una
 * por grupo, cada malla tiene un solo material y la cuenta da.
 * Devuelve null si no hace falta (o no se puede: atributos intercalados).
 * @param {THREE.Mesh} o
 */
function porGrupo(o) {
  const mats = /** @type {THREE.Material[]} */ (o.material);
  const g = o.geometry;
  if (Object.values(g.attributes).some((a) => /** @type {any} */ (a).isInterleavedBufferAttribute)) return null;
  const total = g.index ? g.index.count : g.attributes.position.count;
  const grupos = g.groups.length ? g.groups : [{ start: 0, count: total, materialIndex: 0 }];
  /** @type {THREE.Mesh[]} */
  const partes = [];
  for (const gr of grupos) {
    const mat = mats[gr.materialIndex ?? 0];
    if (!mat) continue;
    const fin = Math.min(total, gr.start + gr.count);
    const sub = new THREE.BufferGeometry();
    if (g.index) {
      for (const [k, a] of Object.entries(g.attributes)) sub.setAttribute(k, a);
      sub.setIndex(new THREE.BufferAttribute(g.index.array.slice(gr.start, fin), 1));
    } else {
      for (const [k, a] of Object.entries(g.attributes)) {
        const ba = /** @type {THREE.BufferAttribute} */ (a);
        sub.setAttribute(k, new THREE.BufferAttribute(ba.array.slice(gr.start * ba.itemSize, fin * ba.itemSize), ba.itemSize, ba.normalized));
      }
    }
    const m = new THREE.Mesh(sub, mat);
    m.matrixAutoUpdate = false;
    m.matrix.copy(o.matrixWorld);
    partes.push(m);
  }
  return partes;
}

/**
 * @param {{ scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer, preset: () => Preset, samples?: number, hdri?: () => { texture: THREE.Texture, intensity: number } | null }} ctx
 * @param {RenderOptions} [opts]
 * @returns {Promise<Blob>}
 */
export async function pathTrace(ctx, opts = {}) {
  const { scene, renderer: visor } = ctx;
  const p = ctx.preset();
  const tam = visor.getSize(new THREE.Vector2());
  const { samples = ctx.samples ?? 256, bounces = p.render.bounces, onProgress, signal, type = 'image/png' } = opts;
  const width = Math.round(opts.width ?? tam.x), height = Math.round(opts.height ?? tam.y);
  if (!(samples >= 1) || !(width >= 1) || !(height >= 1)) throw new RangeError('samples, width y height van mayores que 0');

  const { WebGLPathTracer, GradientEquirectTexture } = await cargar();

  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.toneMapping = visor.toneMapping;
  renderer.toneMappingExposure = visor.toneMappingExposure;
  renderer.outputColorSpace = visor.outputColorSpace;

  const base = /** @type {THREE.PerspectiveCamera} */ (opts.camera ?? ctx.camera);
  const camera = base.clone();
  if (camera.isPerspectiveCamera) { camera.aspect = width / height; camera.updateProjectionMatrix(); }
  else if (/** @type {any} */ (camera).isOrthographicCamera) {
    // la misma altura, con el ancho de la imagen pedida
    const o = /** @type {THREE.OrthographicCamera} */ (/** @type {unknown} */ (camera));
    const h = (o.top - o.bottom) / 2, cy = (o.top + o.bottom) / 2, cx = (o.left + o.right) / 2;
    o.left = cx - (h * width) / height; o.right = cx + (h * width) / height; o.top = cy + h; o.bottom = cy - h;
    o.updateProjectionMatrix();
  }

  const cielo = new GradientEquirectTexture(256);
  cielo.topColor.set(p.render.sky);
  cielo.bottomColor.set(p.render.ground);
  cielo.update();

  const tracer = new WebGLPathTracer(renderer);
  tracer.renderDelay = 0;
  tracer.fadeDuration = 0;
  tracer.minSamples = 0;
  tracer.bounces = bounces;
  tracer.tiles.set(2, 2);

  // la escena se toma como está; lo que no va a la imagen se esconde solo mientras se arma
  const antes = { environment: scene.environment, intensity: scene.environmentIntensity, fog: scene.fog };
  scene.updateMatrixWorld(true);
  /** @type {THREE.Object3D[]} */
  const escondidos = [];
  /** @type {THREE.Mesh[]} */
  const multis = [];
  scene.traverse((o) => {
    if (o.visible && sinRender(/** @type {any} */ (o))) { o.visible = false; escondidos.push(o); return; }
    const mesh = /** @type {THREE.Mesh} */ (o);
    if (mesh.isMesh && o.visible && Array.isArray(mesh.material)) multis.push(mesh);
  });
  // las de varios materiales, de a una por grupo (ver porGrupo), en un grupo temporal
  const reemplazos = new THREE.Group();
  for (const m of multis) {
    let visible = true;
    for (let n = /** @type {THREE.Object3D | null} */ (m); n; n = n.parent) visible &&= n.visible;
    if (!visible) continue;
    const partes = porGrupo(m);
    if (!partes) continue;
    m.visible = false;
    escondidos.push(m);
    reemplazos.add(...partes);
  }
  if (reemplazos.children.length) scene.add(reemplazos);
  // con HDRI, el panorama entero (la rotación y el fondo ya están en la escena); sin él, el degradé
  const hdri = ctx.hdri?.();
  scene.environment = hdri ? hdri.texture : cielo;
  scene.environmentIntensity = hdri ? hdri.intensity : p.render.environmentIntensity;
  scene.fog = null;
  try {
    // síncrono: setSceneAsync pide un worker de BVH aparte, y para un render a pedido no vale la pena
    tracer.setScene(scene, camera);
  } finally {
    scene.remove(reemplazos);
    // solo la geometría propia de cada parte: los atributos son los de la malla original
    for (const p of /** @type {THREE.Mesh[]} */ (reemplazos.children)) p.geometry.dispose();
    for (const o of escondidos) o.visible = true;
    scene.environment = antes.environment;
    scene.environmentIntensity = antes.intensity;
    scene.fog = antes.fog;
  }

  try {
    // varias muestras por cuadro en imágenes chicas (esperar un cuadro por muestra es lo que más
    // tarda); en grandes, una, para no trabar la GPU (cada muestra ya es mucho trabajo)
    const porCuadro = Math.max(1, Math.min(16, Math.floor(2e6 / (width * height))));
    while (tracer.samples < samples) {
      if (signal?.aborted) throw new DOMException('render cancelado', 'AbortError');
      for (let i = 0; i < porCuadro && tracer.samples < samples; i++) tracer.renderSample();
      onProgress?.(Math.min(1, tracer.samples / samples), Math.floor(tracer.samples));
      await cuadro();
    }
    return await new Promise((ok, mal) => renderer.domElement.toBlob((b) => (b ? ok(b) : mal(new Error('no se pudo sacar la imagen'))), type));
  } finally {
    // tracer.dispose() de la 0.0.23 falla (usa un _renderQuad que no existe), y no hace falta:
    // perder el contexto de este renderer propio suelta todo lo que el tracer subió a la GPU
    cielo.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
