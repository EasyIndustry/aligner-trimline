// threejs-render-engine: cómo se ve una escena de three.js. La app pone lo suyo en
// `motor.scene` (o en `motor.content`) y decide qué está seleccionado; el motor pone el
// resto: luces, sombras, entorno, piso, contornos, modos de vista y el render final.
//
//   const motor = createEngine(document.body, { preset: 'warm', area: 250 });
//   motor.content.add(miMalla);
//   motor.select([miMalla]);             // contorno de selección
//   motor.mode = 'clay';                 // render | clay | wireframe | normals | matcap
//   motor.edges({ enabled: true });      // contorno fino de geometría
//   const png = await motor.render({ samples: 300 });   // path tracing, con un click
//   motor.help();
//
// Cómo se ve sale de un PRESET (ver presets.js): un cliente nuevo es un preset, no código.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { PRESETS, resolvePreset, mergePreset, definePreset } from './presets.js';
import { createEdgePass } from './edges.js';
import { pathTrace } from './pathtracer.js';
import { help } from './help.js';
import { classifyGpu, GPU_KIND_TEXT } from './gpu.js';
import { QUALITY, CUSTOM_QUALITY, resolveQuality, mergeQuality, qualityName, suggestQuality } from './quality.js';
import { createAutoScale } from './resolution.js';
import { ENGINE_MEMBERS } from './members.js';
import { sinAO, sinContorno } from './flags.js';
import { HDRI_DEFAULTS, hdriKind, mergeHdri } from './hdri.js';
import * as V from './view.js';
import * as G from './gestures.js';
import { SCHEMES, KEYS } from './gestures.js';
import { VIEWS } from './view.js';

export { PRESETS, resolvePreset, mergePreset, definePreset, ENGINE_MEMBERS, QUALITY, CUSTOM_QUALITY, resolveQuality, suggestQuality };
export { EASINGS, VIEWS } from './view.js';
export { SCHEMES, KEYS } from './gestures.js';

/** @typedef {import('./presets.js').Preset} Preset */
/** @typedef {'render' | 'clay' | 'wireframe' | 'normals' | 'matcap'} Mode */

/** Los modos de vista. 'render' es la escena con sus materiales; los otros pisan el material de todo. */
export const MODES = /** @type {readonly Mode[]} */ (Object.freeze(['render', 'clay', 'wireframe', 'normals', 'matcap']));

/** Un matcap de estudio, dibujado en un canvas (sin archivos). */
function matcapTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
  const r = g.createRadialGradient(96, 84, 6, 128, 128, 170);
  r.addColorStop(0, '#f6f3ee'); r.addColorStop(0.35, '#c9c3ba'); r.addColorStop(0.7, '#6b665f'); r.addColorStop(1, '#25231f');
  g.fillStyle = r; g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Crea el motor dentro de un contenedor (o sobre un canvas).
 * @param {HTMLElement | HTMLCanvasElement} target
 * @param {{ preset?: string | Record<string, any>, quality?: string | Record<string, any>, area?: number, fov?: number, controls?: boolean, pixelRatio?: number, resolution?: number | 'auto' }} [opts]
 *   `area`: el radio de la zona de trabajo en la unidad de la escena (cm: 250 es un taller).
 *   `quality`: 'baja' | 'media' | 'alta' o sus ajustes (ver quality.js): lo que cuesta GPU. Media por defecto.
 *   `resolution`: escala de los píxeles del visor (1 nativa, 0.5 la mitad) o 'auto' (ver resolution()).
 */
export function createEngine(target, { preset = 'studio', area = 250, fov = 38, controls: conControles = true, pixelRatio, quality = 'media', resolution: resolucionInicial = 1 } = {}) {
  /** La calidad: lo que cuesta GPU (ver quality.js). */
  let Q = resolveQuality(quality);
  if (!(area > 0)) throw new RangeError(`area inválida: ${area} (va el radio de la zona de trabajo, mayor que 0)`);
  const esCanvas = target instanceof HTMLCanvasElement;
  const container = esCanvas ? /** @type {HTMLElement} */ (target.parentElement ?? document.body) : target;
  const medida = () => {
    const w = container === document.body ? window.innerWidth : container.clientWidth;
    const h = container === document.body ? window.innerHeight : container.clientHeight;
    return [Math.max(1, w), Math.max(1, h)];
  };

  // ---------- renderer, escena, cámara ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', ...(esCanvas ? { canvas: target } : {}) });
  /** El pixelRatio con escala 1: el de la pantalla, hasta 2 (o el que se pidió). */
  const prBase = pixelRatio ?? Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(prBase);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  if (!esCanvas) container.appendChild(renderer.domElement);
  const [w0, h0] = medida();
  renderer.setSize(w0, h0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(fov, w0 / h0, area / 250, area * 16);
  camera.position.set(area * 0.6, area * 0.48, area * 0.76);
  /**
   * La ortográfica (view.projection). Su escala sale de la perspectiva: media pantalla de alto
   * mide distancia · tan(fov / 2) en el plano del objetivo. Se para lejos (a `area · 8` por lo
   * menos), así acercarse no corta lo que está entre la cámara y el objetivo.
   */
  const orto = new THREE.OrthographicCamera(-1, 1, 1, -1, area / 250, area * 32);
  /** La cámara que dibuja: la perspectiva o la ortográfica. */
  let activa = /** @type {THREE.PerspectiveCamera | THREE.OrthographicCamera} */ (camera);
  /** En ortográfica, la distancia que da la escala (la cámara de verdad está más lejos). */
  let distanciaOrto = 1;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const entornoBase = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = entornoBase;

  // el entorno HDRI (motor.hdri): la textura equirectangular, su versión PMREM para iluminar y cómo se ve
  /** @type {THREE.Texture | null} */ let hdriTex = null;
  /** @type {THREE.WebGLRenderTarget | null} */ let hdriPmrem = null;
  /** ¿La textura la cargó el motor (y la suelta él) o es de la app? */
  let hdriPropia = false;
  /** @type {string | null} */ let hdriFuente = null;
  let hdriOpts = { ...HDRI_DEFAULTS };
  /** Cada pedido nuevo invalida a los que todavía están cargando. */
  let hdriPedido = 0;

  /** Lo de la app, si no quiere colgarlo directo de la escena. */
  const content = new THREE.Group();
  content.name = 'content';
  scene.add(content);
  /** Lo que va encima de todo y fuera del post-proceso: gizmos, manijas. */
  const overlay = new THREE.Scene();

  // ---------- el "estudio": luces, piso, grilla (salen del preset) ----------
  const estudio = new THREE.Group();
  estudio.name = 'studio';
  scene.add(estudio);
  const hemi = new THREE.HemisphereLight();
  const sun = new THREE.DirectionalLight();
  sun.shadow.bias = -0.0004;
  estudio.add(hemi, sun, sun.target);
  /** @type {THREE.Mesh | null} */ let floor = null;
  /** @type {THREE.GridHelper | null} */ let grid = null;

  /**
   * Una pasada que vuelve a dibujar la escena, con lo que `fuera` dice escondido mientras corre.
   * @param {{ render: (...a: any[]) => void }} pass @param {(o: any) => boolean} fuera
   */
  function escondiendo(pass, fuera) {
    const original = pass.render.bind(pass);
    pass.render = (...args) => {
      /** @type {THREE.Object3D[]} */
      const escondidos = [];
      scene.traverse((o) => { if (o.visible && fuera(o)) { o.visible = false; escondidos.push(o); } });
      try { original(...args); } finally { for (const o of escondidos) o.visible = true; }
    };
  }

  // ---------- post-proceso ----------
  // el post-proceso dibuja a texturas intermedias, que no tienen el antialiasing del canvas: sin
  // MSAA en ellas los bordes de las piezas quedan dentados
  const pr0 = renderer.getPixelRatio();
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(w0 * pr0, h0 * pr0, { type: THREE.HalfFloatType, samples: Q.antialias }));
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(w0, h0);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  // oclusión ambiental (GTAO): los rincones, las uniones y lo que apoya en el piso se oscurecen
  // donde la luz del ambiente casi no llega. Justo después de la escena, antes de contornos y bloom.
  const aoPass = new GTAOPass(scene, camera, w0, h0);
  aoPass.enabled = false;
  // GTAO vuelve a dibujar la escena (normales y profundidad): lo marcado con noAO y los espejos
  // se esconden mientras tanto, o un espejo dibujaría su reflejo una vez más por cuadro
  escondiendo(aoPass, sinAO);
  composer.addPass(aoPass);
  const edgePass = createEdgePass(renderer, scene, camera);
  composer.addPass(edgePass);
  // bloom: lo que pasa de `threshold` (en lineal: un emisivo con intensidad > 1, un reflejo del
  // sol) se derrama alrededor. Antes de los contornos, para que la selección no brille.
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(w0, h0), 0.8, 0.4, 0.9);
  bloomPass.enabled = false;
  composer.addPass(bloomPass);

  /** @param {number} strength @param {number} thickness */
  function outlinePass(strength, thickness) {
    const o = new OutlinePass(new THREE.Vector2(w0, h0), scene, activa);
    o.edgeStrength = strength;
    o.edgeThickness = thickness;
    o.edgeGlow = 0;
    o.pulsePeriod = 0;
    // el overlay entrega color premultiplicado por alfa: con NormalBlending se multiplica dos
    // veces y, con tonemapping, el color vira (cian/magenta). Lo correcto es (One, 1 − alfa).
    o.overlayMaterial.blending = THREE.CustomBlending;
    o.overlayMaterial.blendSrc = THREE.OneFactor;
    o.overlayMaterial.blendDst = THREE.OneMinusSrcAlphaFactor;
    o.overlayMaterial.blendEquation = THREE.AddEquation;
    // la máscara y la profundidad del contorno vuelven a dibujar la escena: sin los espejos
    escondiendo(o, sinContorno);
    if (activa !== camera) contornoPara(o);
    return o;
  }
  const seleccion = outlinePass(3, 1.2);
  composer.addPass(seleccion);
  /** Un contorno angosto por objeto: marca las costuras entre piezas que se tocan. @type {OutlinePass[]} */
  const detalles = [];
  composer.addPass(new OutputPass());

  // ---------- preset ----------
  /** @type {Preset} */ let P = resolvePreset(preset);
  /** Lo que se ve del estudio: se prende y apaga sin cambiar de preset (show). */
  const vis = { grid: true, floor: true, sky: false, fog: true, shadows: true };
  /** @type {THREE.Texture | null} */ let cieloTex = null;

  /** Un cielo degradé (de arriba al horizonte) como fondo equirectangular. @param {{ top: string, bottom: string }} s */
  function cielo(s) {
    const c = document.createElement('canvas');
    c.width = 4; c.height = 256;
    const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, s.top); grad.addColorStop(0.5, s.bottom); grad.addColorStop(1, s.bottom);
    g.fillStyle = grad; g.fillRect(0, 0, 4, 256);
    const t = new THREE.CanvasTexture(c);
    t.mapping = THREE.EquirectangularReflectionMapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  function aplicarVisibilidad() {
    const bg = new THREE.Color(P.background);
    cieloTex?.dispose();
    // el HDRI de fondo tapa al cielo y a la niebla, y se ve solo donde se ve el piso (render y clay)
    const fondoHdri = !!hdriTex && hdriOpts.background && (modo === 'render' || modo === 'clay');
    cieloTex = !fondoHdri && vis.sky && P.sky ? cielo(P.sky) : null;
    scene.background = fondoHdri ? hdriTex : cieloTex ?? bg;
    scene.backgroundBlurriness = fondoHdri ? hdriOpts.blur : 0;
    scene.backgroundIntensity = fondoHdri ? hdriOpts.intensity : 1;
    scene.fog = !fondoHdri && vis.fog && P.fog ? new THREE.Fog(P.sky && vis.sky ? P.sky.bottom : bg, P.fog.near * area, P.fog.far * area) : null;
    sun.castShadow = P.sun.shadows && vis.shadows && Q.shadows;
    if (grid) grid.visible = vis.grid;
    if (floor) floor.visible = vis.floor && (modo === 'render' || modo === 'clay');
  }

  /** Con HDRI, el HDRI ilumina y se refleja; sin él, el entorno de estudio con la intensidad del preset. */
  function aplicarEntorno() {
    scene.environment = hdriTex && hdriPmrem ? hdriPmrem.texture : entornoBase;
    scene.environmentIntensity = hdriTex ? hdriOpts.intensity : P.environment.intensity;
    const rot = THREE.MathUtils.degToRad(hdriTex ? hdriOpts.rotation : 0);
    scene.environmentRotation.set(0, rot, 0);
    scene.backgroundRotation.set(0, rot, 0);
  }

  function aplicarPreset() {
    aplicarEntorno();
    renderer.toneMappingExposure = P.exposure;

    hemi.color.set(P.hemisphere.sky); hemi.groundColor.set(P.hemisphere.ground); hemi.intensity = P.hemisphere.intensity;
    sun.color.set(P.sun.color); sun.intensity = P.sun.intensity;
    const d = new THREE.Vector3(...P.sun.direction).normalize();
    sun.position.copy(d.multiplyScalar(area * 1.1));
    Object.assign(sun.shadow.camera, { left: -area * 0.9, right: area * 0.9, top: area * 0.9, bottom: -area * 0.9, near: area * 0.04, far: area * 2.8 });
    sun.shadow.normalBias = area * 0.0016;
    sun.shadow.camera.updateProjectionMatrix();

    if (floor) { estudio.remove(floor); floor.geometry.dispose(); /** @type {THREE.Material} */ (floor.material).dispose(); floor = null; }
    if (P.floor) {
      floor = new THREE.Mesh(new THREE.PlaneGeometry(area * 16, area * 16), new THREE.MeshStandardMaterial({ color: P.floor.color, roughness: P.floor.roughness }));
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      floor.userData.noEdge = true;
      floor.name = 'floor';
      estudio.add(floor);
    }
    if (grid) { estudio.remove(grid); grid.geometry.dispose(); /** @type {THREE.Material} */ (grid.material).dispose(); grid = null; }
    if (P.grid) {
      grid = new THREE.GridHelper(area * 1.12, P.grid.divisions, P.grid.color, P.grid.color);
      const gm = /** @type {THREE.LineBasicMaterial} */ (grid.material);
      gm.transparent = true; gm.opacity = P.grid.opacity;
      grid.position.y = area * 0.00024;
      grid.userData.noEdge = true;
      grid.name = 'grid';
      estudio.add(grid);
    }

    for (const o of [seleccion, ...detalles]) { o.visibleEdgeColor.set(P.selection.color); o.hiddenEdgeColor.set(P.selection.color); }
    seleccion.edgeStrength = P.selection.strength; seleccion.edgeThickness = P.selection.thickness;
    for (const o of detalles) { o.edgeStrength = P.selection.detailStrength; o.edgeThickness = P.selection.detailThickness; }
    aplicarBordes(P.edges);
    aplicarBloom(P.bloom);
    aplicarAO(P.ao);
    aplicarModo();
  }

  // ---------- HDRI ----------
  function estadoHdri() {
    return { active: !!hdriTex, source: hdriFuente, ...hdriOpts };
  }

  function soltarHdri() {
    hdriPmrem?.dispose();
    if (hdriPropia) hdriTex?.dispose();
    hdriTex = null; hdriPmrem = null; hdriPropia = false; hdriFuente = null;
  }

  /** @param {string} url @param {string} [tipo] @returns {Promise<THREE.Texture>} */
  async function cargarHdri(url, tipo) {
    const kind = hdriKind(url, tipo);
    try {
      if (kind === 'hdr') return await new (await import('three/addons/loaders/RGBELoader.js')).RGBELoader().loadAsync(url);
      if (kind === 'exr') return await new (await import('three/addons/loaders/EXRLoader.js')).EXRLoader().loadAsync(url);
      const t = await new THREE.TextureLoader().loadAsync(url);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message ?? e);
      const importmap = /module|import|specifier/i.test(msg) ? ' (¿"three/addons/" está en el importmap?)' : '';
      throw new Error(`no se pudo cargar el HDRI ${url}${importmap}: ${msg}`);
    }
  }

  /**
   * @param {string | THREE.Texture | null | Partial<import('./hdri.js').HdriOptions>} fuente
   * @param {Partial<import('./hdri.js').HdriOptions> & { type?: string }} [opts]
   */
  async function cambiarHdri(fuente, opts) {
    const pedido = ++hdriPedido;
    const soloOpciones = !!fuente && typeof fuente === 'object' && !(/** @type {THREE.Texture} */ (fuente).isTexture);
    if (soloOpciones) { opts = /** @type {any} */ (fuente); fuente = undefined; }
    // las opciones se validan antes de cargar nada
    const nuevas = mergeHdri(soloOpciones || fuente === undefined ? hdriOpts : { ...HDRI_DEFAULTS }, opts);
    if (!fuente && !hdriTex && fuente !== null) throw new Error('no hay un HDRI puesto: pasá la fuente, hdri(url, opciones)');
    if (fuente === null || fuente === undefined) {
      if (fuente === null) soltarHdri();
      hdriOpts = fuente === null ? { ...HDRI_DEFAULTS } : nuevas;
      aplicarEntorno(); aplicarVisibilidad();
      return estadoHdri();
    }
    if (typeof fuente !== 'string' && !fuente.isTexture) throw new TypeError('hdri(fuente): una URL, una THREE.Texture, null, o solo opciones');
    const propia = typeof fuente === 'string';
    const tex = propia ? await cargarHdri(fuente, opts?.type) : /** @type {THREE.Texture} */ (fuente);
    if (pedido !== hdriPedido) { if (propia) tex.dispose(); return estadoHdri(); }   // llegó otro pedido mientras tanto
    tex.mapping = THREE.EquirectangularReflectionMapping;
    const env = pmrem.fromEquirectangular(tex);
    soltarHdri();
    hdriTex = tex; hdriPmrem = env; hdriPropia = propia; hdriOpts = nuevas;
    hdriFuente = propia ? fuente : null;
    aplicarEntorno(); aplicarVisibilidad();
    return estadoHdri();
  }

  /** El radio va en fracción de `area` (como las sombras): 0.03 de un taller de 250 cm son 7,5 cm. @param {Partial<Preset['ao']>} a */
  function aplicarAO(a) {
    if (a.intensity !== undefined) aoPass.blendIntensity = a.intensity;
    if (a.radius !== undefined) aoPass.updateGtaoMaterial({ radius: a.radius * area, thickness: a.radius * area });
  }

  /** @param {Partial<Preset['bloom']>} b */
  function aplicarBloom(b) {
    if (b.strength !== undefined) bloomPass.strength = b.strength;
    if (b.radius !== undefined) bloomPass.radius = b.radius;
    if (b.threshold !== undefined) bloomPass.threshold = b.threshold;
  }

  // ---------- contorno fino ----------
  /** @param {Partial<Preset['edges']>} e */
  function aplicarBordes(e) {
    if (e.enabled !== undefined) edgePass.enabled = !!e.enabled;
    if (e.normalThreshold !== undefined) edgePass.uniforms.normalThreshold.value = e.normalThreshold;
    if (e.depthThreshold !== undefined) edgePass.uniforms.depthThreshold.value = e.depthThreshold;
    if (e.darken !== undefined) edgePass.uniforms.darkenFactor.value = e.darken;
  }

  // ---------- modos de vista ----------
  /** @type {Mode} */ let modo = 'render';
  /** @type {Record<Exclude<Mode, 'render'>, THREE.Material>} */
  const pisadores = {
    clay: new THREE.MeshStandardMaterial({ color: '#b6b0a6', roughness: 1, metalness: 0 }),
    wireframe: new THREE.MeshBasicMaterial({ color: '#3a3a40', wireframe: true }),
    normals: new THREE.MeshNormalMaterial(),
    matcap: new THREE.MeshMatcapMaterial({ matcap: matcapTexture() }),
  };
  function aplicarModo() {
    aplicarVisibilidad();
  }

  /**
   * Dibuja con el material del modo puesto solo en las mallas de la app (no en el estudio ni en
   * el fondo), y lo devuelve. No va en scene.overrideMaterial: ese pisa también la grilla y el
   * fondo, y los pases de contorno lo usan para sus máscaras y lo dejan en null al terminar.
   * @param {() => void} dibujar
   */
  function conModo(dibujar) {
    if (modo === 'render') return dibujar();
    const pisador = pisadores[modo];
    /** @type {[THREE.Mesh, THREE.Material | THREE.Material[]][]} */
    const cambiados = [];
    scene.traverse((o) => {
      const m = /** @type {THREE.Mesh} */ (o);
      if (!m.isMesh || o.parent === estudio) return;
      cambiados.push([m, m.material]);
      m.material = pisador;
    });
    try { dibujar(); } finally { for (const [m, mat] of cambiados) m.material = mat; }
  }

  // ---------- tamaño ----------
  /** @type {Set<(s: { width: number, height: number, pixelRatio: number, drawingWidth: number, drawingHeight: number }) => void>} */
  const avisosTamano = new Set();
  /** El tamaño del visor ahora: en CSS y en píxeles que se dibujan. */
  function tamano() {
    const [width, height] = medida();
    const gl = renderer.getContext();
    return { width, height, pixelRatio: renderer.getPixelRatio(), drawingWidth: gl.drawingBufferWidth, drawingHeight: gl.drawingBufferHeight };
  }
  function ajustar() {
    const [w, h] = medida();
    renderer.setSize(w, h, !esCanvas);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (activa === orto) ajustarOrto(distanciaOrto);
    if (avisosTamano.size) { const t = tamano(); for (const fn of avisosTamano) fn(t); }
  }
  const ro = new ResizeObserver(ajustar);
  ro.observe(container);

  // ---------- resolución: cuántos píxeles se dibujan (fija o automática) ----------
  let escala = 1;
  /** @type {ReturnType<typeof createAutoScale> | null} */ let auto = null;
  /** @param {number} s */
  function aplicarEscala(s) {
    escala = s;
    const pr = prBase * s;
    renderer.setPixelRatio(pr);
    composer.setPixelRatio(pr);
    ajustar();
  }

  // ---------- el cuadro ----------
  /** @type {Set<(dt: number) => void>} */
  const alCuadro = new Set();
  const reloj = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = reloj.getDelta();
    if (auto) { const n = auto.sample(dt * 1000); if (n !== null) aplicarEscala(n); }
    pasoVista(dt);
    ajustarNiebla();
    for (const fn of alCuadro) fn(dt);
    conModo(() => composer.render());
    if (overlay.children.length) {
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(overlay, activa);
      renderer.autoClear = true;
    }
    avisarVista();
  });

  // ---------- la cámara como valores planos (view.js) ----------
  /** Lo que mira la cámara: alrededor de esto orbita. */
  const objetivo = new THREE.Vector3(0, area * 0.1, 0);
  // sin la entrada del motor, la cámara queda como la deja la app
  if (conControles) camera.lookAt(objetivo);
  /** Los límites como los pidió la app (floor: true es el piso del estudio, en 0). */
  let limitesPedidos = /** @type {Omit<V.ViewLimits, 'floor'> & { floor: number | boolean | null }} */ ({ ...V.NO_LIMITS });
  /** Los límites para la matemática: el piso, en altura de la cámara (más el near, para no cortarlo). */
  function limites() {
    const f = limitesPedidos.floor;
    return /** @type {V.ViewLimits} */ ({ ...limitesPedidos, floor: f === null || f === false ? null : (f === true ? 0 : f) + camera.near });
  }
  const _dir = new THREE.Vector3();
  /** El estado de la cámara ahora. Sin la entrada del motor, el objetivo sale de hacia dónde mira. @returns {V.ViewState} */
  function leer() {
    const c = activa, p = c.position;
    let t = objetivo;
    if (!conControles) t = _dir.set(0, 0, -1).applyQuaternion(c.quaternion).multiplyScalar(p.distanceTo(objetivo) || area).add(p);
    /** @type {V.Vec3} */ let pos = [p.x, p.y, p.z];
    if (c === orto) {
      // la escala es la distancia (si la app tocó el zoom de la cámara, entra ahí)
      const d = distanciaOrto / orto.zoom, k = d / (p.distanceTo(t) || 1);
      pos = [t.x + (p.x - t.x) * k, t.y + (p.y - t.y) * k, t.z + (p.z - t.z) * k];
    }
    return { position: pos, target: [t.x, t.y, t.z], up: [c.up.x, c.up.y, c.up.z], fov: camera.fov, projection: c === orto ? 'orthographic' : 'perspective', zoom: 1 };
  }
  /**
   * La niebla se mide desde la cámara: en ortográfica la cámara está más lejos que la distancia
   * que da la escala, y se corre lo mismo, así la niebla se ve igual que en perspectiva.
   */
  function ajustarNiebla() {
    const f = /** @type {THREE.Fog | null} */ (scene.fog);
    if (!f || !P.fog) return;
    const extra = activa === orto ? orto.position.distanceTo(objetivo) - distanciaOrto : 0;
    f.near = P.fog.near * area + extra;
    f.far = P.fog.far * area + extra;
  }
  /** La ortográfica con la escala de esa distancia, y el aspecto del visor. @param {number} d */
  function ajustarOrto(d) {
    distanciaOrto = d;
    const h = d * Math.tan((camera.fov * Math.PI) / 360), a = camera.aspect;
    Object.assign(orto, { top: h, bottom: -h, left: -h * a, right: h * a, zoom: 1, near: camera.near, far: Math.max(d, area * 8) + area * 16 });
    orto.updateProjectionMatrix();
  }
  /**
   * Cambia la cámara que dibuja, y con ella la de cada pase: los que leen profundidad la
   * linealizan distinto en ortográfica.
   * @param {THREE.PerspectiveCamera | THREE.OrthographicCamera} c
   */
  function usarCamara(c) {
    if (c === activa) return;
    activa = c;
    renderPass.camera = c;
    aoPass.camera = c;
    for (const m of [aoPass.gtaoMaterial, aoPass.depthRenderMaterial]) { m.defines.PERSPECTIVE_CAMERA = c === camera ? 1 : 0; m.needsUpdate = true; }
    edgePass.camera = c;
    for (const o of [seleccion, ...detalles]) contornoPara(o);
  }
  /** @param {OutlinePass} o */
  function contornoPara(o) {
    o.renderCamera = activa;
    // OutlinePass escribe la función de profundidad en su shader al crearse
    const m = o.prepareMaskMaterial;
    const [de, a] = activa === camera ? ['orthographicDepthToViewZ', 'perspectiveDepthToViewZ'] : ['perspectiveDepthToViewZ', 'orthographicDepthToViewZ'];
    if (m.fragmentShader.includes(de)) { m.fragmentShader = m.fragmentShader.replaceAll(de, a); m.needsUpdate = true; }
  }
  /** @param {V.ViewState} s */
  function escribir(s) {
    // la perspectiva sigue el estado también en ortográfica: volver no salta
    camera.position.set(...s.position);
    objetivo.set(...s.target);
    camera.up.set(...s.up);
    if (camera.fov !== s.fov) { camera.fov = s.fov; camera.updateProjectionMatrix(); }
    camera.lookAt(objetivo);
    if (s.projection === 'orthographic') {
      const d = camera.position.distanceTo(objetivo);
      ajustarOrto(d);
      orto.position.copy(camera.position).sub(objetivo).multiplyScalar(Math.max(d, area * 8) / d).add(objetivo);
      orto.up.copy(camera.up);
      orto.lookAt(objetivo);
    }
    usarCamara(s.projection === 'orthographic' ? orto : camera);
  }

  // empieza y termina: una animación o el usuario moviéndola (con la inercia hasta que para)
  /** @type {Set<() => void>} */ const avisosInicio = new Set();
  /** @type {Set<() => void>} */ const avisosFin = new Set();
  /** @type {Set<(s: V.ViewState) => void>} */ const avisosVista = new Set();
  /** @type {Set<string>} */ const moviendo = new Set();
  /** @param {string} k */
  const empieza = (k) => { if (!moviendo.size) for (const fn of avisosInicio) fn(); moviendo.add(k); };
  /** @param {string} k */
  const termina = (k) => { if (moviendo.delete(k) && !moviendo.size) for (const fn of avisosFin) fn(); };
  /** @type {V.ViewState | null} */ let ultimaVista = null;
  function avisarVista() {
    if (!avisosVista.size) return;
    const s = leer();
    if (ultimaVista && V.sameView(s, ultimaVista, 1e-12)) return;
    ultimaVista = s;
    for (const fn of avisosVista) fn(V.clone(s));
  }

  /** @type {{ desde: V.ViewState, hasta: V.ViewState, t: number, ms: number, ease: (t: number) => number, fin: (ok: boolean) => void } | null} */
  let anim = null;
  /** @param {boolean} ok */
  function terminarAnim(ok) {
    if (!anim) return;
    const a = anim; anim = null;
    termina('anim');
    a.fin(ok);
  }
  /** @param {number} dt */
  function pasoVista(dt) {
    if (anim) {
      // un cuadro largo (la pestaña estuvo quieta) no hace saltar la animación
      anim.t = Math.min(1, anim.t + (Math.min(dt, 0.1) * 1000) / anim.ms);
      escribir(V.interpolate(anim.desde, anim.hasta, anim.ease(anim.t)));
      if (anim.t >= 1) terminarAnim(true);
      return;
    }
    // la velocidad es por segundo de verdad, aunque el visor ande lento; un cuadro de más de medio
    // segundo (la pestaña estuvo quieta) no hace saltar la cámara
    if (manejo) aplicarManejo(Math.min(dt, 0.5));
    if (hayPendiente()) aplicarPendiente(dt);
    if (moviendo.has('user') && !punteros.size && !hayPendiente()) termina('user');
  }

  // ---------- la entrada: mouse, touch, teclado (gestures.js) y lo que maneja la app ----------
  const lienzo = renderer.domElement;
  /** Cómo se navega (view.input). */
  const entrada = {
    /** @type {G.Scheme} */ scheme: G.scheme('three'), nombre: 'three',
    zoomToCursor: false,
    /** @type {'target' | 'cursor' | 'selection'} */ orbitAround: 'target',
    /** @type {Readonly<Record<string, G.KeyCommand>> | null} */ teclas: null,
  };
  /** Lo que los gestos todavía no le aplicaron a la cámara: se aplica de a poco (la inercia). */
  const pendiente = { yaw: 0, pitch: 0, panX: 0, panY: 0, zoom: 0, /** @type {[number, number] | undefined} */ at: undefined, /** @type {V.Vec3 | undefined} */ around: undefined };
  const hayPendiente = () => Math.abs(pendiente.yaw) > 1e-4 || Math.abs(pendiente.pitch) > 1e-4 || Math.abs(pendiente.panX) > 1e-3 || Math.abs(pendiente.panY) > 1e-3 || Math.abs(pendiente.zoom) > 1e-6;
  function vaciarPendiente() { Object.assign(pendiente, { yaw: 0, pitch: 0, panX: 0, panY: 0, zoom: 0 }); }
  /** Píxeles del visor a unidades de la escena, en el plano del objetivo. @param {V.ViewState} s */
  const unidadesDe = (s) => (2 * V.angles(s).distance * Math.tan((s.fov * Math.PI) / 360)) / medida()[1];
  /** @param {number} dt */
  function aplicarPendiente(dt) {
    const k = G.dampingStep(P.camera.damping, dt), lim = limites();
    let s = leer();
    const yaw = pendiente.yaw * k, pitch = pendiente.pitch * k, z = pendiente.zoom * k;
    if (yaw || pitch) s = V.orbit(s, yaw, pitch, { around: pendiente.around, limits: lim });
    if (pendiente.panX || pendiente.panY) { const u = unidadesDe(s); s = V.pan(s, pendiente.panX * k * u, pendiente.panY * k * u, { limits: lim }); }
    if (z) s = V.zoom(s, Math.exp(z), { at: pendiente.at, aspect: camera.aspect, limits: lim });
    escribir(s);
    for (const c of /** @type {const} */ (['yaw', 'pitch', 'panX', 'panY', 'zoom'])) pendiente[c] *= 1 - k;
    if (!hayPendiente()) vaciarPendiente();
  }

  /** La entrada directa de la app (view.drive): velocidades por segundo. @type {{ orbit: [number, number], pan: [number, number], zoom: number } | null} */
  let manejo = null;
  /** @param {number} dt */
  function aplicarManejo(dt) {
    if (!manejo) return;
    const lim = limites();
    let s = leer();
    if (manejo.orbit[0] || manejo.orbit[1]) s = V.orbit(s, manejo.orbit[0] * dt, manejo.orbit[1] * dt, { limits: lim });
    if (manejo.pan[0] || manejo.pan[1]) { const u = unidadesDe(s); s = V.pan(s, manejo.pan[0] * dt * u, manejo.pan[1] * dt * u, { limits: lim }); }
    if (manejo.zoom !== 1) s = V.zoom(s, manejo.zoom ** dt, { limits: lim });
    escribir(s);
  }

  /** Los punteros del gesto de la cámara en curso, en píxeles del visor. @type {Map<number, { x: number, y: number }>} */
  const punteros = new Map();
  /** Los punteros que la app reclamó (view.claim): su gesto entero no es de la cámara. @type {Set<number>} */
  const ajenos = new Set();
  /** @type {{ action: G.Action | 'pan-zoom' } | null} */ let gesto = null;
  /** @type {Set<(e: PointerEvent | WheelEvent) => unknown>} */ const filtros = new Set();
  /** Los bloqueos de la app (view.suspend), con su nombre. @type {Map<symbol, string>} */ const bloqueos = new Map();
  /** @param {{ clientX: number, clientY: number }} e */
  const enLienzo = (e) => { const r = lienzo.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  /** @param {{ x: number, y: number }} p @returns {[number, number]} */
  const ndc = (p) => { const r = lienzo.getBoundingClientRect(); return [(p.x / r.width) * 2 - 1, 1 - (p.y / r.height) * 2]; };
  /** ¿La app se queda con este gesto? Un filtro que falla no rompe la cámara. @param {PointerEvent | WheelEvent} e */
  function reclamado(e) {
    for (const fn of filtros) {
      try { if (fn(e) === 'app') return true; } catch (err) { console.error('view.claim: el filtro falló; el gesto queda para la cámara', err); }
    }
    return false;
  }
  function empiezaUsuario() { empieza('user'); terminarAnim(false); }
  /** Corta el gesto en curso, limpio: sin lo pendiente, así al volver no salta. */
  function cortarGesto() {
    for (const id of punteros.keys()) { try { lienzo.releasePointerCapture(id); } catch { /* ya no estaba */ } }
    punteros.clear();
    gesto = null;
    vaciarPendiente();
  }

  const _rayo = new THREE.Raycaster();
  /** Lo que hay de la app bajo un punto del visor, o undefined. @param {{ x: number, y: number }} p @returns {V.Vec3 | undefined} */
  function bajoElCursor(p) {
    const [x, y] = ndc(p);
    _rayo.setFromCamera(new THREE.Vector2(x, y), activa);
    /** @param {THREE.Object3D | null} o */
    const cuenta = (o) => { for (; o; o = o.parent) if (!o.visible || o.userData.noRender || o === estudio) return false; return true; };
    const hit = _rayo.intersectObjects(scene.children, true).find((h) => /** @type {THREE.Mesh} */ (h.object).isMesh && cuenta(h.object));
    return hit ? /** @type {V.Vec3} */ (hit.point.toArray()) : undefined;
  }
  /** Alrededor de qué orbita un gesto que empieza en `p`. @param {{ x: number, y: number }} p @returns {V.Vec3 | undefined} */
  function pivote(p) {
    if (entrada.orbitAround === 'cursor') return bajoElCursor(p);
    if (entrada.orbitAround === 'selection' && seleccion.selectedObjects.length) {
      const c = cajaDe(seleccion.selectedObjects);
      if (!c.isEmpty()) return /** @type {V.Vec3} */ (c.getCenter(new THREE.Vector3()).toArray());
    }
    return undefined;
  }

  /** @param {PointerEvent} e */
  function alBajar(e) {
    if (bloqueos.size || !lienzo.isConnected) return;
    if (reclamado(e)) { ajenos.add(e.pointerId); return; }
    const p = enLienzo(e);
    if (e.pointerType === 'touch') {
      if (punteros.size >= 2) return;
      const accion = punteros.size === 0 ? entrada.scheme.touch[1] : entrada.scheme.touch[2];
      if (!accion) return;
      punteros.set(e.pointerId, p);
      gesto = { action: accion };
    } else {
      if (gesto) return; // ya hay un gesto con otro botón
      const accion = G.mouseAction(entrada.scheme, e);
      if (!accion) return;
      punteros.set(e.pointerId, p);
      gesto = { action: accion };
      if (accion === 'dolly') pendiente.at = entrada.zoomToCursor ? ndc(p) : undefined;
    }
    if (gesto.action === 'orbit') pendiente.around = pivote(p);
    // con el puntero capturado el pointerup llega siempre, aunque se suelte afuera del visor
    try { lienzo.setPointerCapture(e.pointerId); } catch { /* el puntero ya no está */ }
    empiezaUsuario();
  }
  /** @param {PointerEvent} e */
  function alMover(e) {
    const antes = punteros.get(e.pointerId);
    if (!antes || !gesto) return;
    const p = enLienzo(e);
    const h = medida()[1];
    if (gesto.action === 'pan-zoom' && punteros.size === 2) {
      const [a, b] = [...punteros.values()];
      const medio0 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, d0 = Math.hypot(a.x - b.x, a.y - b.y);
      punteros.set(e.pointerId, p);
      const [c, d] = [...punteros.values()];
      const medio = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 }, d1 = Math.hypot(c.x - d.x, c.y - d.y);
      pendiente.panX -= medio.x - medio0.x; pendiente.panY += medio.y - medio0.y;
      if (d0 > 0 && d1 > 0) { pendiente.zoom += Math.log(d1 / d0); pendiente.at = ndc(medio); }
      return;
    }
    punteros.set(e.pointerId, p);
    const dx = p.x - antes.x, dy = p.y - antes.y;
    if (gesto.action === 'orbit') { const [y, pt] = G.dragToOrbit(dx, dy, h); pendiente.yaw += y; pendiente.pitch += pt; }
    else if (gesto.action === 'pan') { pendiente.panX -= dx; pendiente.panY += dy; }
    else if (gesto.action === 'dolly') pendiente.zoom += Math.log(G.dragToZoom(dy, h));
  }
  /** @param {PointerEvent} e */
  function alSoltar(e) {
    if (ajenos.delete(e.pointerId)) return;
    if (!punteros.delete(e.pointerId)) return;
    if (!punteros.size) { gesto = null; return; }
    // de dos dedos a uno: sigue con lo que hace un dedo
    const accion = entrada.scheme.touch[1];
    gesto = accion ? { action: accion } : null;
    if (accion === 'orbit') pendiente.around = pivote([...punteros.values()][0]);
  }
  /** @param {WheelEvent} e */
  function alRueda(e) {
    if (bloqueos.size || entrada.scheme.wheel !== 'zoom' || reclamado(e)) return;
    e.preventDefault();
    pendiente.zoom += Math.log(G.wheelToZoom(e.deltaY, e.deltaMode, medida()[1]));
    pendiente.at = entrada.zoomToCursor ? ndc(enLienzo(e)) : undefined;
    empiezaUsuario();
  }
  /** El menú del botón derecho, solo si el derecho es de la cámara. @param {MouseEvent} e */
  function alMenu(e) { if (G.mouseAction(entrada.scheme, { button: 2, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey })) e.preventDefault(); }
  /** @param {KeyboardEvent} e */
  function alTeclado(e) {
    if (!entrada.teclas || bloqueos.size) return;
    const cmd = G.keyAction(entrada.teclas, e);
    if (!cmd) return;
    e.preventDefault();
    const animate = true;
    if (cmd.orbit) view.orbit(cmd.orbit[0], cmd.orbit[1], { animate });
    else if (cmd.pan) view.pan(cmd.pan[0], cmd.pan[1], { animate });
    else if (cmd.zoom) view.zoom(cmd.zoom, { animate });
    else if (cmd.go) view.go(cmd.go, { fit: false, animate });
    else if (cmd.projection) view.projection(cmd.projection === 'toggle' ? (activa === orto ? 'perspective' : 'orthographic') : cmd.projection);
  }
  /** Prende o apaga el teclado: apagado, no hay ningún listener de teclado. @param {Readonly<Record<string, G.KeyCommand>> | null} t */
  function ponerTeclas(t) {
    if (!conControles) { entrada.teclas = t; return; }
    if (t && !entrada.teclas) { lienzo.addEventListener('keydown', alTeclado); if (!lienzo.hasAttribute('tabindex')) { lienzo.tabIndex = 0; lienzo.dataset.motorTabindex = ''; } }
    if (!t && entrada.teclas) { lienzo.removeEventListener('keydown', alTeclado); if ('motorTabindex' in lienzo.dataset) { lienzo.removeAttribute('tabindex'); delete lienzo.dataset.motorTabindex; } }
    entrada.teclas = t;
  }
  const touchActionPrevio = lienzo.style.touchAction;
  if (conControles) {
    // el navegador no desplaza ni hace zoom de la página con los gestos sobre el visor
    lienzo.style.touchAction = 'none';
    lienzo.addEventListener('pointerdown', alBajar);
    lienzo.addEventListener('pointermove', alMover);
    lienzo.addEventListener('pointerup', alSoltar);
    lienzo.addEventListener('pointercancel', alSoltar);
    lienzo.addEventListener('lostpointercapture', alSoltar);
    lienzo.addEventListener('wheel', alRueda, { passive: false });
    lienzo.addEventListener('contextmenu', alMenu);
  }

  /** Lo que sigue a los relativos: si hay una animación, se suman a donde iba. */
  const base = () => (anim ? V.clone(anim.hasta) : leer());
  /**
   * Lleva la cámara a `s`, de una o animada. La Promise dice si llegó (true) o si otro comando o
   * el usuario la cortó en el camino (false).
   * @param {V.ViewState} s @param {boolean | { duration?: number, easing?: string } | undefined} animate
   * @returns {Promise<boolean>}
   */
  function mover(s, animate) {
    const cfg = animate === true ? {} : animate || null;
    const ms = cfg ? cfg.duration ?? P.camera.duration : 0;
    if (typeof ms !== 'number' || !(ms >= 0)) throw new RangeError(`duration va en ms, 0 o más (llegó ${ms})`);
    const ease = V.easing(cfg?.easing ?? P.camera.easing);
    if (!(ms > 0)) { terminarAnim(false); escribir(s); return Promise.resolve(true); }
    const desde = leer();
    return new Promise((fin) => {
      const previa = anim;
      anim = { desde, hasta: s, t: 0, ms, ease, fin };
      if (previa) previa.fin(false); else empieza('anim');
    });
  }
  const unidadesPorPixel = () => unidadesDe(base());

  /**
   * Lo que se encuadra: una caja { min, max } de la app, unos objetos, o todo el contenido.
   * @param {V.Box | THREE.Object3D[] | undefined} f @returns {V.Box | null}
   */
  function cajaPlana(f) {
    if (f !== undefined && !Array.isArray(f)) return V.box(f);
    const c = cajaDe(f);
    return c.isEmpty() ? null : { min: c.min.toArray(), max: c.max.toArray() };
  }
  /** @param {number | undefined} m */
  const margen = (m) => m ?? P.camera.margin;

  /** @typedef {{ animate?: boolean | { duration?: number, easing?: string } }} Animar */
  const view = {
    /** El estado de la cámara, con valores planos (se guarda como JSON). */
    get() { return leer(); },
    /**
     * Lleva la cámara a un estado: lo que no se pasa queda como está. Exacto: después, get()
     * devuelve lo mismo (salvo que los límites lo corrijan).
     * @param {Partial<V.ViewState>} s @param {Animar} [o]
     */
    set(s, { animate } = {}) { return mover(V.constrain(V.merge(base(), s), limites()), animate); },
    /**
     * Orbitar, en grados: yaw positivo lleva la cámara a su derecha, pitch positivo hacia arriba.
     * `around`: el punto alrededor del que gira (por defecto el objetivo).
     * @param {number} dYaw @param {number} dPitch @param {Animar & { around?: V.Vec3 }} [o]
     */
    orbit(dYaw, dPitch, { around, animate } = {}) {
      return mover(V.orbit(base(), dYaw, dPitch, { around: around && V.vec3(around, 'around'), limits: limites() }), animate);
    },
    /**
     * Desplazar cámara y objetivo en el plano de la pantalla: dx positivo a la derecha, dy hacia
     * arriba. En píxeles del visor (unit: 'px', por defecto) o en unidades de la escena ('world').
     * @param {number} dx @param {number} dy @param {Animar & { unit?: 'px' | 'world' }} [o]
     */
    pan(dx, dy, { unit = 'px', animate } = {}) {
      if (unit !== 'px' && unit !== 'world') throw new Error(`unit va 'px' o 'world' (llegó ${unit})`);
      const k = unit === 'px' ? unidadesPorPixel() : 1;
      return mover(V.pan(base(), dx * k, dy * k, { limits: limites() }), animate);
    },
    /**
     * Acercar: 2 deja todo el doble de grande, 0.5 la mitad. `at`: un punto del visor en píxeles
     * ([x, y] desde arriba a la izquierda) que queda quieto, para acercar hacia el cursor.
     * @param {number} factor @param {Animar & { at?: [number, number] }} [o]
     */
    zoom(factor, { at, animate } = {}) {
      const [w, h] = medida();
      if (at !== undefined && !(Array.isArray(at) && at.length === 2 && at.every(Number.isFinite))) throw new TypeError(`at va como [x, y] en píxeles del visor (llegó ${JSON.stringify(at)})`);
      /** @type {[number, number] | undefined} */
      const ndc = at ? [(at[0] / w) * 2 - 1, 1 - (at[1] / h) * 2] : undefined;
      return mover(V.zoom(base(), factor, { at: ndc, aspect: w / h, limits: limites() }), animate);
    },
    /** Avanzar hacia el objetivo (negativo: retroceder), en unidades de la escena, sin pasarlo. @param {number} distance @param {Animar} [o] */
    dolly(distance, { animate } = {}) { return mover(V.dolly(base(), distance, { limits: limites() }), animate); },
    /** Mirar a un punto sin mover la cámara. @param {V.Vec3} point @param {Animar} [o] */
    lookAt(point, { animate } = {}) { return mover(V.lookAt(base(), point, { limits: limites() }), animate); },
    /**
     * El rayo que sale por un punto del visor ([x, y] en píxeles, desde arriba a la izquierda),
     * con la cámara que dibuja: { origin, dir } (dir unitaria). En ortográfica, todos paralelos,
     * desde el plano cercano. Para elegir con el puntero sin tocar three.
     * @param {[number, number]} at
     */
    ray(at) {
      const [w, h] = medida(), p = enPixeles(at, 'ray');
      const r = V.ray(leer(), [(p[0] / w) * 2 - 1, 1 - (p[1] / h) * 2], camera.aspect);
      // en ortográfica la cámara de verdad está más atrás que la de la escala
      if (activa === orto) { const atras = orto.position.distanceTo(objetivo) - distanciaOrto - orto.near; r.origin = /** @type {V.Vec3} */ (r.origin.map((x, i) => x - r.dir[i] * atras)); }
      return r;
    },
    /**
     * Dónde cae un punto del mundo en el visor: [x, y, depth], x e y en píxeles desde arriba a la
     * izquierda, depth de 0 (plano cercano) a 1 (lejano); afuera de 0..1, detrás o fuera de alcance.
     * @param {V.Vec3} point
     */
    project(point) {
      const [w, h] = medida();
      const [x, y, z] = V.project(leer(), V.vec3(point, 'project(punto)'), camera.aspect);
      const atras = activa === orto ? orto.position.distanceTo(objetivo) - distanciaOrto : 0;
      return /** @type {[number, number, number]} */ ([((x + 1) / 2) * w, ((1 - y) / 2) * h, (z + atras - activa.near) / (activa.far - activa.near)]);
    },
    /**
     * Cuántas unidades de la escena mide un píxel del visor en ese punto (en ortográfica, lo
     * mismo en todos lados): para una manija o un gizmo de tamaño constante en pantalla.
     * @param {V.Vec3} point
     */
    worldPerPixel(point) { return V.worldPerPixel(leer(), V.vec3(point, 'worldPerPixel(punto)'), medida()[1]); },
    /**
     * La proyección: 'perspective' u 'orthographic'. El cambio no salta: el plano del objetivo
     * se ve del mismo tamaño en las dos. Contornos, selección, overlay, snapshot() y render()
     * siguen andando. Sin argumentos, cuál está.
     * @param {V.Projection} [p]
     */
    projection(p) {
      if (p !== undefined) mover(V.merge(base(), { projection: p }), false);
      return activa === orto ? 'orthographic' : 'perspective';
    },
    /**
     * Ir a una vista: un nombre de VIEWS ('front', 'top', 'iso', …) o un { dir, up } propio, y
     * encuadrar: `fit` es una caja { min, max } o unos objetos (por defecto, todo el contenido;
     * false: sin encuadrar, a la misma distancia). `margin`: 1.15 deja la caja en 1/1.15 de la pantalla.
     * `projection`: además, cambiar de proyección al llegar ('orthographic' para una vista de plano).
     * @param {string | V.ViewDirection} name @param {Animar & { fit?: V.Box | THREE.Object3D[] | false, margin?: number, projection?: V.Projection }} [o]
     */
    go(name, { fit, margin, projection, animate } = {}) {
      const s = projection === undefined ? base() : V.merge(base(), { projection });
      if (fit === false) return mover(V.go(s, name, { limits: limites() }), animate);
      const b = cajaPlana(fit);
      if (!b) return mover(V.go(s, name, { limits: limites() }), animate);
      return mover(V.fit(s, b, { aspect: camera.aspect, margin: margen(margin), near: camera.near * 2, view: name, limits: limites() }), animate);
    },
    /**
     * Encuadrar sin cambiar de dirección: una caja { min, max }, unos objetos, o todo el contenido.
     * Usa el fov que limite (vertical u horizontal) y la caja entera, no una esfera.
     * @param {V.Box | THREE.Object3D[]} [what] @param {Animar & { margin?: number }} [o]
     */
    fit(what, { margin, animate } = {}) {
      const b = cajaPlana(what);
      if (!b) return Promise.resolve(true);
      return mover(V.fit(base(), b, { aspect: camera.aspect, margin: margen(margin), near: camera.near * 2, limits: limites() }), animate);
    },
    /**
     * Hasta dónde se mueve la cámara, en todos los caminos (mouse, comandos y animaciones):
     * { minDistance, maxDistance, minPitch, maxPitch (grados), floor }. floor: true no deja
     * pasar debajo del piso; un número, debajo de esa altura. Sin argumentos, cómo están.
     * @param {Partial<Omit<V.ViewLimits, 'floor'> & { floor: number | boolean | null }>} [l]
     */
    limits(l) {
      if (l) {
        const { floor, ...resto } = l;
        if (floor !== undefined && floor !== null && typeof floor !== 'boolean' && !Number.isFinite(floor)) throw new TypeError('floor va true, false, una altura o null');
        const { floor: _f, ...validados } = V.mergeLimits({ ...limitesPedidos, floor: null }, resto);
        limitesPedidos = { ...validados, floor: floor === undefined ? limitesPedidos.floor : floor };
        const s = base(), c = V.constrain(s, limites());
        if (c !== s) mover(c, false);
      }
      return { ...limitesPedidos };
    },
    /** Algo que corre cuando cambia la cámara (una vez por cuadro, con el estado). Devuelve cómo sacarlo. @param {(s: V.ViewState) => void} fn */
    onChange(fn) { if (!avisosVista.size) ultimaVista = leer(); avisosVista.add(fn); return () => avisosVista.delete(fn); },
    /** Algo que corre cuando la cámara empieza a moverse (el usuario o una animación). Devuelve cómo sacarlo. @param {() => void} fn */
    onStart(fn) { avisosInicio.add(fn); return () => avisosInicio.delete(fn); },
    /** Algo que corre cuando la cámara se queda quieta (con la inercia ya terminada). Devuelve cómo sacarlo. @param {() => void} fn */
    onEnd(fn) { avisosFin.add(fn); return () => avisosFin.delete(fn); },

    /**
     * Cómo navega el usuario: `scheme` ('three' por defecto, 'cad', 'blender' o una tabla propia,
     * ver SCHEMES), `zoomToCursor` (la rueda acerca hacia el cursor), `orbitAround` ('target', o
     * 'cursor': lo que hay bajo el puntero, o 'selection': el centro de lo seleccionado) y
     * `keyboard` (false por defecto: ningún listener; true: las teclas de KEYS, con el foco en el
     * visor; o una tabla propia). Sin argumentos, cómo está.
     * @param {{ scheme?: string | G.Scheme, zoomToCursor?: boolean, orbitAround?: 'target' | 'cursor' | 'selection', keyboard?: boolean | Record<string, G.KeyCommand> }} [o]
     */
    input(o) {
      if (o) {
        const conocidas = ['scheme', 'zoomToCursor', 'orbitAround', 'keyboard'];
        for (const k of Object.keys(o)) if (!conocidas.includes(k)) throw new Error(`opción de entrada desconocida: ${k} (van ${conocidas.join(', ')})`);
        if (o.orbitAround !== undefined && !['target', 'cursor', 'selection'].includes(o.orbitAround)) throw new Error(`orbitAround va 'target', 'cursor' o 'selection' (llegó ${o.orbitAround})`);
        if (o.zoomToCursor !== undefined && typeof o.zoomToCursor !== 'boolean') throw new TypeError('zoomToCursor va true o false');
        const sc = o.scheme === undefined ? null : G.scheme(o.scheme);
        const teclas = o.keyboard === undefined ? undefined : o.keyboard === true ? G.KEYS : o.keyboard === false ? null : G.keyBindings(o.keyboard);
        if (sc) { cortarGesto(); entrada.scheme = sc; entrada.nombre = typeof o.scheme === 'string' ? o.scheme : 'custom'; }
        if (o.zoomToCursor !== undefined) entrada.zoomToCursor = o.zoomToCursor;
        if (o.orbitAround !== undefined) entrada.orbitAround = o.orbitAround;
        if (teclas !== undefined) ponerTeclas(teclas);
      }
      return { scheme: entrada.nombre, zoomToCursor: entrada.zoomToCursor, orbitAround: entrada.orbitAround, keyboard: !!entrada.teclas };
    },
    /**
     * Entrada directa continua, para un joystick, una SpaceMouse o un botón mantenido: velocidades
     * por segundo, `orbit` en grados, `pan` en píxeles del visor y `zoom` como factor (2: el
     * doble de grande por segundo). Siguen hasta otro drive(); drive(null) frena. La app lee el
     * dispositivo; el motor no.
     * @param {{ orbit?: [number, number], pan?: [number, number], zoom?: number } | null} v
     */
    drive(v) {
      if (v === null) { if (manejo) { manejo = null; termina('drive'); } return; }
      const d = directa(v, 'drive');
      if (!(d.zoom > 0)) throw new RangeError(`zoom va como un factor por segundo, mayor que 0 (llegó ${d.zoom})`);
      const quieto = !d.orbit[0] && !d.orbit[1] && !d.pan[0] && !d.pan[1] && d.zoom === 1;
      if (quieto) { view.drive(null); return; }
      if (!manejo) { empieza('drive'); terminarAnim(false); }
      manejo = d;
    },
    /**
     * Un impulso de un solo paso: { orbit: [grados, grados], pan: [px, px], zoom: factor }.
     * @param {{ orbit?: [number, number], pan?: [number, number], zoom?: number }} v @param {Animar} [o]
     */
    nudge(v, { animate } = {}) {
      const d = directa(v, 'nudge');
      const lim = limites();
      let s = base();
      if (d.orbit[0] || d.orbit[1]) s = V.orbit(s, d.orbit[0], d.orbit[1], { limits: lim });
      if (d.pan[0] || d.pan[1]) { const u = unidadesDe(s); s = V.pan(s, d.pan[0] * u, d.pan[1] * u, { limits: lim }); }
      if (d.zoom !== 1) s = V.zoom(s, d.zoom, { limits: lim });
      return mover(s, animate);
    },
    /**
     * Un filtro que el motor consulta antes de empezar un gesto (pointerdown o rueda): si
     * devuelve 'app', ese gesto entero es de la app y la cámara no se mueve. Si tira un error,
     * el gesto es de la cámara. Devuelve cómo sacarlo.
     * @param {(e: PointerEvent | WheelEvent) => 'app' | 'camera' | undefined | null | void} fn
     */
    claim(fn) {
      if (typeof fn !== 'function') throw new TypeError("claim(fn): fn devuelve 'app' o 'camera'");
      filtros.add(fn);
      return () => { filtros.delete(fn); };
    },
    /**
     * Bloquea la cámara para el usuario (mouse, touch, teclado) hasta soltar: dos bloqueos a la
     * vez no se pisan. Si había un gesto en curso termina limpio, sin salto al volver. Los
     * comandos y drive() siguen andando. Devuelve cómo soltarlo (llamarlo dos veces no suelta otro).
     * @param {string} [name] para ver en `suspended` quién bloquea
     */
    suspend(name = 'suspend') {
      const k = Symbol(name);
      bloqueos.set(k, String(name));
      cortarGesto();
      return () => { bloqueos.delete(k); };
    },
    /** Los nombres de los bloqueos que hay (vacío: el usuario mueve la cámara). */
    get suspended() { return [...bloqueos.values()]; },
  };

  /** Un punto del visor en píxeles, validado. @param {unknown} at @param {string} quien @returns {[number, number]} */
  function enPixeles(at, quien) {
    if (!Array.isArray(at) || at.length !== 2 || !at.every(Number.isFinite)) throw new TypeError(`${quien}([x, y]) va en píxeles del visor (llegó ${JSON.stringify(at)})`);
    return [at[0], at[1]];
  }

  /**
   * Un drive o un nudge, validado y con lo que falta en cero.
   * @param {unknown} v @param {string} quien
   * @returns {{ orbit: [number, number], pan: [number, number], zoom: number }}
   */
  function directa(v, quien) {
    if (!v || typeof v !== 'object') throw new TypeError(`${quien}() va con { orbit?, pan?, zoom? }`);
    const o = /** @type {Record<string, any>} */ (v);
    for (const k of Object.keys(o)) {
      if (k === 'roll') throw new Error(`${quien}: roll no está (orbitar es girar la mesa, sin inclinar el horizonte)`);
      if (!['orbit', 'pan', 'zoom'].includes(k)) throw new Error(`${quien}: clave desconocida ${k} (van orbit, pan, zoom)`);
    }
    /** @param {unknown} x @param {string} n @returns {[number, number]} */
    const par = (x, n) => {
      if (x === undefined) return [0, 0];
      if (!Array.isArray(x) || x.length !== 2 || !x.every(Number.isFinite)) throw new TypeError(`${quien}: ${n} va como [x, y] con números finitos`);
      return [x[0], x[1]];
    };
    const zoom = o.zoom ?? 1;
    if (!Number.isFinite(zoom)) throw new TypeError(`${quien}: zoom va como un número`);
    return { orbit: par(o.orbit, 'orbit'), pan: par(o.pan, 'pan'), zoom };
  }

  /**
   * Lo que queda de los OrbitControls, para lo que la app ya hacía con ellos: `target` (el
   * objetivo, un Vector3: cambiarlo y llamar a update()), `enabled` (false bloquea como
   * view.suspend) y `update()`. Mejor usar motor.view.
   */
  let soltarControles = /** @type {(() => void) | null} */ (null);
  const controls = conControles ? {
    target: objetivo,
    get enabled() { return !soltarControles; },
    set enabled(v) {
      if (!v && !soltarControles) soltarControles = view.suspend('controls.enabled');
      else if (v && soltarControles) { soltarControles(); soltarControles = null; }
    },
    /** Apunta la cámara al target (si la app lo cambió a mano). */
    update() { terminarAnim(false); escribir(V.merge(leer(), {})); return false; },
    dispose() {},
  } : null;

  aplicarPreset();

  /**
   * La caja de unos objetos, o de todo el contenido (sin el estudio).
   * @param {THREE.Object3D[] | undefined} objs
   */
  function cajaDe(objs) {
    const caja = new THREE.Box3();
    if (objs?.length) { for (const o of objs) caja.expandByObject(o); return caja; }
    // todo lo de la app: las mallas visibles, sin el estudio ni lo marcado con noRender (guías, cotas)
    scene.updateMatrixWorld();
    const b = new THREE.Box3();
    /** @param {THREE.Object3D} o */
    const juntar = (o) => {
      if (!o.visible || o === estudio || o.userData.noRender) return;
      const m = /** @type {THREE.Mesh & { isInstancedMesh?: boolean, boundingBox?: THREE.Box3 | null, computeBoundingBox?: () => void }} */ (o);
      if (m.isMesh) {
        // la malla sola, sin sus hijos: un hijo marcado con noRender no cuenta
        const fuente = m.isInstancedMesh ? m : m.geometry;
        if (!fuente.boundingBox) fuente.computeBoundingBox?.();
        if (fuente.boundingBox) caja.union(b.copy(fuente.boundingBox).applyMatrix4(m.matrixWorld));
      }
      for (const h of o.children) juntar(h);
    };
    for (const o of scene.children) juntar(o);
    return caja;
  }

  // ---------- calidad ----------
  /** @type {Set<(q: any) => void>} */
  const avisosCalidad = new Set();
  /** Aplica la calidad actual: antialiasing, sombras, AO, bloom. */
  function aplicarCalidad() {
    for (const t of [composer.renderTarget1, composer.renderTarget2]) {
      if (t.samples !== Q.antialias) { t.samples = Q.antialias; t.dispose(); }
    }
    if (sun.shadow.mapSize.x !== Q.shadowMapSize) { sun.shadow.mapSize.set(Q.shadowMapSize, Q.shadowMapSize); sun.shadow.map?.dispose(); sun.shadow.map = null; }
    sun.castShadow = P.sun.shadows && vis.shadows && Q.shadows;
    aoPass.enabled = Q.ao;
    aoPass.updateGtaoMaterial({ samples: Q.aoSamples });
    bloomPass.enabled = Q.bloom;
  }
  /** @param {import('./quality.js').Quality} nueva */
  function ponerCalidad(nueva) {
    Q = nueva;
    aplicarCalidad();
    const info = { name: qualityName(Q), ...Q };
    for (const fn of avisosCalidad) fn(info);
  }
  /** Un ajuste suelto (prender el AO, el bloom…): la calidad queda personalizada. @param {Record<string, unknown>} q */
  const cambiarCalidad = (q) => ponerCalidad(mergeQuality(Q, q));

  const motor = {
    renderer, scene, controls, content, overlay, composer, view, VIEWS, SCHEMES, KEYS,

    /** La cámara que dibuja: la PerspectiveCamera, o la OrthographicCamera con view.projection('orthographic'). */
    get camera() { return activa; },

    /** El preset que está puesto (una copia: para cambiarlo, setPreset). */
    get preset() { return structuredClone(P); },
    /**
     * Cambia cómo se ve: un nombre de PRESETS, un objeto completo, o `{ extends, … }`.
     * @param {string | Record<string, any>} p
     */
    setPreset(p) { P = resolvePreset(p); aplicarPreset(); return motor; },
    /** Pisa algunos valores del preset actual: `motor.tweak({ sun: { intensity: 3 } })`. @param {Record<string, any>} over */
    tweak(over) { P = mergePreset(P, over); aplicarPreset(); return motor; },

    get mode() { return modo; },
    set mode(m) { motor.setMode(m); },
    /** @param {Mode} m */
    setMode(m) {
      if (!MODES.includes(m)) throw new Error(`modo desconocido: ${String(m)} (van ${MODES.join(', ')})`);
      modo = m; aplicarModo(); return motor;
    },

    /**
     * Contorno de selección: la silueta de lo que se pasa (vacío: nada). Con `{ detail: true }`,
     * además una línea fina por objeto, para ver las costuras entre los que se tocan.
     * @param {THREE.Object3D[]} [objects] @param {{ detail?: boolean }} [opts]
     */
    select(objects = [], { detail = false } = {}) {
      seleccion.selectedObjects = [...objects];
      const n = detail ? objects.length : 0;
      while (detalles.length < n) {
        const o = outlinePass(P.selection.detailStrength, P.selection.detailThickness);
        o.visibleEdgeColor.set(P.selection.color); o.hiddenEdgeColor.set(P.selection.color);
        o.setSize(...medida());
        detalles.push(o);
        composer.insertPass(o, composer.passes.indexOf(seleccion));
      }
      detalles.forEach((o, i) => { o.selectedObjects = i < n ? [objects[i]] : []; });
      return motor;
    },
    /** Lo que está seleccionado. */
    get selected() { return [...seleccion.selectedObjects]; },

    /**
     * El entorno HDRI: un panorama equirectangular que ilumina, se refleja en los materiales y
     * (con `background`) se ve de fondo, en el visor y en el render final.
     *
     *   await motor.hdri('galpon.hdr');                          // .hdr, .exr o una imagen equirectangular
     *   await motor.hdri('galpon.hdr', { blur: 0.2, rotation: 90, intensity: 1.2 });
     *   await motor.hdri({ rotation: 180 });                     // solo opciones, sobre el que está
     *   await motor.hdri(null);                                  // volver al entorno de estudio
     *
     * La fuente es una URL o una `THREE.Texture` ya cargada (la textura es de la app: el motor no
     * la suelta). Opciones: `background` (true: se dibuja de fondo), `intensity` (1), `blur` (de 0
     * a 1, del fondo), `rotation` (grados alrededor de Y) y `type` ('hdr' | 'exr' | 'image'; por
     * defecto sale de la extensión). Los cargadores vienen de `three/addons/` y se piden recién
     * acá. Si la carga falla, queda el entorno que había. Sin argumentos, devuelve cómo está.
     * @param {string | THREE.Texture | null | Partial<import('./hdri.js').HdriOptions>} [fuente]
     * @param {Partial<import('./hdri.js').HdriOptions> & { type?: string }} [opts]
     * @returns {Promise<ReturnType<typeof estadoHdri>> | ReturnType<typeof estadoHdri>}
     */
    hdri(fuente, opts) {
      if (fuente === undefined && opts === undefined) return estadoHdri();
      return cambiarHdri(fuente, opts);
    },

    /**
     * Prender o apagar partes del estudio sin cambiar de preset: grilla, piso, cielo (degradé de
     * fondo, en vez del color liso), niebla y sombras. Sin argumentos, devuelve cómo está.
     * @param {Partial<{ grid: boolean, floor: boolean, sky: boolean, fog: boolean, shadows: boolean }>} [s]
     */
    show(s) {
      if (s) {
        for (const [k, v] of Object.entries(s)) {
          if (!(k in vis)) throw new Error(`no hay ${k} para mostrar (van ${Object.keys(vis).join(', ')})`);
          /** @type {Record<string, boolean>} */ (vis)[k] = !!v;
        }
        aplicarVisibilidad();
      }
      return { ...vis };
    },

    /**
     * El contorno fino de geometría: `{ enabled, normalThreshold, depthThreshold, darken }`. Sin
     * argumentos, devuelve cómo está.
     * @param {Partial<Preset['edges']>} [e]
     */
    edges(e) {
      if (e) { P = mergePreset(P, { edges: e }); aplicarBordes(e); }
      return { enabled: edgePass.enabled, normalThreshold: edgePass.uniforms.normalThreshold.value, depthThreshold: edgePass.uniforms.depthThreshold.value, darken: edgePass.uniforms.darkenFactor.value };
    },

    /**
     * El bloom: lo que pasa de `threshold` se derrama alrededor (la luz de un emisivo, un reflejo
     * fuerte). `{ enabled, strength, radius, threshold }`; sin argumentos, devuelve cómo está.
     * @param {Partial<Preset['bloom']>} [b]
     */
    bloom(b) {
      if (b) {
        const { enabled, ...look } = b;
        if (enabled !== undefined) cambiarCalidad({ bloom: !!enabled });
        if (Object.keys(look).length) { P = mergePreset(P, { bloom: look }); aplicarBloom(look); }
      }
      return { enabled: bloomPass.enabled, strength: bloomPass.strength, radius: bloomPass.radius, threshold: bloomPass.threshold };
    },

    /**
     * La oclusión ambiental (GTAO): los rincones, las uniones y el contacto con el piso se
     * oscurecen. `{ enabled, radius (fracción de area), intensity, samples }`; sin argumentos,
     * devuelve cómo está.
     * @param {Partial<Preset['ao']>} [a]
     */
    ao(a) {
      if (a) {
        const { enabled, samples, ...look } = a;
        /** @type {Record<string, unknown>} */
        const q = {};
        if (enabled !== undefined) q.ao = !!enabled;
        if (samples !== undefined) q.aoSamples = samples;
        if (Object.keys(q).length) cambiarCalidad(q);
        if (Object.keys(look).length) { P = mergePreset(P, { ao: look }); aplicarAO(look); }
      }
      return { ...P.ao, enabled: aoPass.enabled, samples: Q.aoSamples };
    },

    /**
     * La calidad, como en un juego: 'baja' | 'media' | 'alta' (ver QUALITY), o ajustes sueltos
     * ({ antialias, shadows, shadowMapSize, ao, aoSamples, bloom, renderSamples, textures }) que
     * pisan la actual y la vuelven 'personalizada'. Sin argumentos, devuelve { name, …ajustes }:
     * un objeto plano, para guardarlo y volver a pasarlo. La resolución va aparte (resolution).
     * @param {string | Record<string, unknown>} [q]
     */
    quality(q) {
      if (typeof q === 'string') ponerCalidad(resolveQuality(q));
      else if (q) {
        const { name, ...ajustes } = q;
        ponerCalidad(/** @type {any} */ (q).extends ? resolveQuality(ajustes) : mergeQuality(Q, ajustes));
      }
      return { name: qualityName(Q), ...Q };
    },
    /** La calidad para arrancar según la placa: dedicada 'alta', integrada o software 'baja'. */
    suggestQuality() { return suggestQuality(motor.gpu({ print: false }).kind); },
    /** Algo que corre cuando cambia la calidad (la app cambia sus texturas SD/HD). Devuelve cómo sacarlo. @param {(q: ReturnType<typeof motor.quality>) => void} fn */
    onQualityChange(fn) { avisosCalidad.add(fn); return () => avisosCalidad.delete(fn); },

    /**
     * Encuadra la cámara en unos objetos, o en todo lo que hay.
     * @param {THREE.Object3D[]} [objects]
     */
    frame(objects) { view.fit(objects); return motor; },

    /**
     * Una foto rápida del visor (rasterizada, con lo que se ve ahora), como data URL.
     * @param {{ width?: number, height?: number, type?: string, quality?: number }} [opts]
     */
    snapshot({ width, height, type = 'image/png', quality = 0.92 } = {}) {
      const [w, h] = medida();
      const W = width ?? w, H = height ?? h;
      const prev = renderer.getPixelRatio();
      try {
        renderer.setPixelRatio(1);
        renderer.setSize(W, H, false);
        composer.setPixelRatio(1);
        composer.setSize(W, H);
        camera.aspect = W / H; camera.updateProjectionMatrix();
        if (activa === orto) ajustarOrto(distanciaOrto);
        conModo(() => composer.render());
        return renderer.domElement.toDataURL(type, quality);
      } finally {
        renderer.setPixelRatio(prev);
        composer.setPixelRatio(prev);
        ajustar();
      }
    },

    /**
     * El render final: path tracing de la escena como está, a una imagen (Blob). Carga
     * three-gpu-pathtracer la primera vez. `onProgress(fracción, muestras)`; `signal` lo corta.
     * @param {import('./pathtracer.js').RenderOptions} [opts]
     */
    render(opts) { return pathTrace({ scene, camera: activa, renderer, preset: () => P, samples: Q.renderSamples, hdri: () => (hdriTex ? { texture: hdriTex, intensity: hdriOpts.intensity } : null) }, opts); },

    /**
     * En qué placa se está dibujando: { name, vendor, kind, buffer, pixelRatio, maxMSAA, antialias }.
     * `kind`: 'discrete' | 'integrated' | 'software' | 'unknown'. Lo imprime en la consola (con
     * { print: false }, solo lo devuelve).
     * @param {{ print?: boolean }} [o]
     */
    gpu({ print = true } = {}) {
      const gl = renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      const vendor = String(ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR));
      const kind = classifyGpu(name);
      const info = Object.freeze({
        name, vendor, kind,
        buffer: `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`,
        pixelRatio: renderer.getPixelRatio(),
        maxMSAA: /** @type {number} */ (gl.getParameter(/** @type {WebGL2RenderingContext} */ (gl).MAX_SAMPLES) ?? 0),
        antialias: composer.renderTarget1.samples,
      });
      if (print) {
        const color = kind === 'discrete' ? '#2e7d32' : kind === 'unknown' ? '#666' : '#c62828';
        console.log(`%cGPU%c ${name}  —  %c${GPU_KIND_TEXT[kind]}`, 'font-weight:700', '', `color:${color};font-weight:600`);
        console.log(`   ${info.buffer} px (pixelRatio ${info.pixelRatio}, resolución ${auto ? 'auto, ' : ''}${Math.round(escala * 100)}%), MSAA ${info.antialias} de ${info.maxMSAA} posibles`);
      }
      return info;
    },

    /**
     * Con cuántos píxeles se dibuja el visor, en vivo. Un número es la escala respecto de la
     * resolución nativa (1; 0.5 es la mitad de ancho y de alto: un cuarto de los píxeles), y el
     * navegador estira la imagen a la ventana. 'auto' la ajusta sola según lo que tarda cada
     * cuadro, entre `min` y `max`, para llegar a `fps`. Sin argumentos, devuelve cómo está.
     * No toca el render final (render() tiene su propio tamaño).
     * @param {number | 'auto'} [value] @param {import('./resolution.js').AutoOptions} [opts]
     */
    resolution(value, opts = {}) {
      if (value === 'auto') {
        auto = createAutoScale({ ...opts, start: escala });
        aplicarEscala(auto.scale);
      } else if (value !== undefined) {
        if (typeof value !== 'number' || !(value >= 0.1 && value <= 2)) throw new RangeError(`resolución inválida: ${String(value)} (va un número entre 0.1 y 2, o 'auto')`);
        auto = null;
        aplicarEscala(value);
      }
      const gl = renderer.getContext();
      return Object.freeze({
        mode: auto ? 'auto' : 'fixed', scale: escala, pixelRatio: +renderer.getPixelRatio().toFixed(3),
        buffer: `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`, ...(auto ? auto.options : {}),
      });
    },

    /** Algo que corre en cada cuadro, antes de dibujar (etiquetas, animaciones). Devuelve cómo sacarlo. @param {(dt: number) => void} fn */
    onFrame(fn) { alCuadro.add(fn); return () => alCuadro.delete(fn); },

    /**
     * Algo que corre cuando cambian los píxeles del visor: la ventana, el contenedor o la
     * resolución (resolution, también la automática). Recibe { width, height, pixelRatio,
     * drawingWidth, drawingHeight }: lo que la app dimensiona según el visor (el render target
     * de un espejo) se ajusta acá. Devuelve cómo sacarlo.
     * @param {(s: ReturnType<typeof tamano>) => void} fn
     */
    onResize(fn) { avisosTamano.add(fn); return () => avisosTamano.delete(fn); },

    /** Lo suelta todo: el loop, el post-proceso, el renderer. */
    dispose() {
      renderer.setAnimationLoop(null);
      terminarAnim(false);
      ro.disconnect();
      cortarGesto();
      view.drive(null);
      if (conControles) {
        ponerTeclas(null);
        for (const [t, fn] of /** @type {[string, any][]} */ ([['pointerdown', alBajar], ['pointermove', alMover], ['pointerup', alSoltar], ['pointercancel', alSoltar], ['lostpointercapture', alSoltar], ['wheel', alRueda], ['contextmenu', alMenu]])) lienzo.removeEventListener(t, fn);
        lienzo.style.touchAction = touchActionPrevio;
      }
      composer.passes.forEach((p) => p.dispose?.());
      Object.values(pisadores).forEach((m) => m.dispose());
      soltarHdri();
      pmrem.dispose();
      renderer.dispose();
      if (!esCanvas) renderer.domElement.remove();
    },

    /** @param {{ print?: boolean }} [o] */
    help(o) { return help('Engine — cómo se ve la escena', ENGINE_MEMBERS, o); },
  };
  aplicarCalidad();
  if (resolucionInicial !== 1) motor.resolution(resolucionInicial);
  return motor;
}
