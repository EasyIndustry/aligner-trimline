// Contorno fino de geometría: las aristas reales de los sólidos, comparando profundidad y
// normal entre píxeles vecinos (operador tipo Sobel en pantalla, ~1px). Distinto del contorno
// de selección, que solo marca la silueta de lo elegido.
//
// La línea es el color del material del píxel, oscurecido (`darken`): se lee como un grabado,
// no como un contorno negro parejo. Lo que tenga `userData.noEdge` (piso, grilla, cotas,
// guías) no se contornea, y los espejos tampoco (ver flags.js).
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { sinAristas } from './flags.js';

const EdgeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    tNormal: { value: null },
    resolution: { value: new THREE.Vector2(1, 1) },
    cameraNear: { value: 1 },
    cameraFar: { value: 4000 },
    depthThreshold: { value: 0.6 },
    normalThreshold: { value: 0.7 },
    darkenFactor: { value: 0.55 },
    opacity: { value: 1 },
    debugMode: { value: 0 }, // 0 normal, 1 normales, 2 profundidad, 3 score crudo
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    #include <packing>
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform sampler2D tNormal;
    uniform vec2 resolution;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform float depthThreshold;
    uniform float normalThreshold;
    uniform float darkenFactor;
    uniform float opacity;
    uniform int debugMode;
    varying vec2 vUv;

    // la profundidad del búfer a z de vista: en ortográfica es lineal
    float viewZ(float d) {
      #ifdef ORTHOGRAPHIC
        return orthographicDepthToViewZ(d, cameraNear, cameraFar);
      #else
        return perspectiveDepthToViewZ(d, cameraNear, cameraFar);
      #endif
    }

    // cuánto saltan profundidad y normal respecto de los 4 vecinos, contra los umbrales (>=1: arista)
    float edgeScore(vec2 uv, vec2 texel) {
      float d0 = texture2D(tDepth, uv).x;
      float z0 = viewZ(d0);
      vec3 n0 = normalize(texture2D(tNormal, uv).xyz * 2.0 - 1.0);
      float depthDiff = 0.0;
      float normalDiff = 0.0;
      vec2 offs[4];
      offs[0] = vec2(texel.x, 0.0);
      offs[1] = vec2(-texel.x, 0.0);
      offs[2] = vec2(0.0, texel.y);
      offs[3] = vec2(0.0, -texel.y);
      for (int i = 0; i < 4; i++) {
        vec2 uv2 = uv + offs[i];
        float z = viewZ(texture2D(tDepth, uv2).x);
        vec3 n = normalize(texture2D(tNormal, uv2).xyz * 2.0 - 1.0);
        depthDiff += abs(z0 - z);
        normalDiff += 1.0 - dot(n0, n);
      }
      // una superficie rasante cambia mucho de profundidad por texel sin que haya arista
      float facing = max(abs(n0.z), 0.08);
      // cerca del plano lejano el ruido de cuantización de la profundidad parece un borde
      float farMask = 1.0 - smoothstep(0.985, 0.998, d0);
      float dScore = (depthDiff / (depthThreshold / facing)) * farMask;
      float nScore = normalDiff / normalThreshold;
      return max(dScore, nScore);
    }

    void main() {
      if (debugMode == 1) { gl_FragColor = vec4(texture2D(tNormal, vUv).rgb, 1.0); return; }
      if (debugMode == 2) { gl_FragColor = vec4(vec3(texture2D(tDepth, vUv).x), 1.0); return; }
      vec2 texel = 1.0 / resolution;
      float score0 = edgeScore(vUv, texel);
      if (debugMode == 3) { gl_FragColor = vec4(min(score0, 1.0), 0.0, 0.0, 1.0); return; }
      // una arista dispara a los dos lados (2px): queda solo el máximo local, para 1px
      float edge = 0.0;
      if (score0 >= 1.0) {
        float sR = edgeScore(vUv + vec2(texel.x, 0.0), texel);
        float sL = edgeScore(vUv - vec2(texel.x, 0.0), texel);
        float sU = edgeScore(vUv + vec2(0.0, texel.y), texel);
        float sD = edgeScore(vUv - vec2(0.0, texel.y), texel);
        float m = max(max(sR, sL), max(sU, sD));
        edge = (score0 + 1e-4 >= m) ? 1.0 : 0.0;
      }
      vec4 base = texture2D(tDiffuse, vUv);
      gl_FragColor = vec4(mix(base.rgb, base.rgb * darkenFactor, edge * opacity), base.a);
    }
  `,
};

/**
 * @param {THREE.WebGLRenderer} renderer @param {THREE.Scene} scene @param {THREE.Camera & { near: number, far: number }} camera
 */
export function createEdgePass(renderer, scene, camera) {
  const size = renderer.getSize(new THREE.Vector2());
  const pr = renderer.getPixelRatio();
  const w = Math.max(1, Math.floor(size.x * pr)), h = Math.max(1, Math.floor(size.y * pr));

  // una DepthTexture con filtrado lineal da lecturas basura en WebGL: solo NEAREST es seguro
  const depthTexture = new THREE.DepthTexture(w, h);
  depthTexture.minFilter = THREE.NearestFilter;
  depthTexture.magFilter = THREE.NearestFilter;
  const normalTarget = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthTexture });
  const normalMaterial = new THREE.MeshNormalMaterial();
  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(EdgeShader.uniforms),
    vertexShader: EdgeShader.vertexShader,
    fragmentShader: EdgeShader.fragmentShader,
  });
  material.uniforms.tNormal.value = normalTarget.texture;
  material.uniforms.tDepth.value = depthTexture;
  material.uniforms.resolution.value.set(w, h);
  const fsQuad = new FullScreenQuad(material);

  const pass = /** @type {Pass & { uniforms: Record<string, THREE.IUniform>, setSize: (w: number, h: number) => void, camera: THREE.Camera & { near: number, far: number } }} */ (new Pass());
  /** La cámara con la que se dibuja (el motor la cambia al pasar a ortográfica). */
  pass.camera = camera;
  pass.name = 'EdgesPass';
  pass.needsSwap = true;
  pass.enabled = false;
  pass.uniforms = material.uniforms;

  // el EffectComposer ya le pasa a cada pase el tamaño en píxeles reales (CSS × pixelRatio)
  pass.setSize = (width, height) => {
    const nw = Math.max(1, Math.floor(width)), nh = Math.max(1, Math.floor(height));
    normalTarget.setSize(nw, nh);
    material.uniforms.resolution.value.set(nw, nh);
  };

  pass.render = (r, writeBuffer, readBuffer) => {
    const camera = pass.camera;
    const orto = !!(/** @type {any} */ (camera).isOrthographicCamera);
    if (orto !== ('ORTHOGRAPHIC' in material.defines)) {
      if (orto) material.defines.ORTHOGRAPHIC = ''; else delete material.defines.ORTHOGRAPHIC;
      material.needsUpdate = true;
    }
    material.uniforms.cameraNear.value = camera.near;
    material.uniforms.cameraFar.value = camera.far;
    // lo que no es geometría de trabajo se esconde solo para este render interno
    /** @type {THREE.Object3D[]} */
    const escondidos = [];
    scene.traverse((o) => { if (o.visible && sinAristas(o)) { o.visible = false; escondidos.push(o); } });
    const prevOverride = scene.overrideMaterial;
    const prevTarget = r.getRenderTarget();
    scene.overrideMaterial = normalMaterial;
    r.setRenderTarget(normalTarget);
    r.clear();
    r.render(scene, camera);
    scene.overrideMaterial = prevOverride;
    r.setRenderTarget(prevTarget);
    for (const o of escondidos) o.visible = true;

    material.uniforms.tDiffuse.value = readBuffer.texture;
    r.setRenderTarget(pass.renderToScreen ? null : writeBuffer);
    if (!pass.renderToScreen && pass.clear) r.clear();
    fsQuad.render(r);
  };

  pass.dispose = () => { normalTarget.dispose(); normalMaterial.dispose(); material.dispose(); fsQuad.dispose(); };
  return pass;
}
