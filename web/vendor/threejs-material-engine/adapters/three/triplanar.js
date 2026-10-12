// Mapeo triplanar para un material de three: en vez de las UV de la malla, cada mapa se proyecta
// desde los tres ejes del objeto y las tres muestras se mezclan según la normal (peso =
// |n|^sharpness, normalizado). Donde la malla dobla, la textura pasa de una proyección a la otra
// mezclándose, sin costura. Sirve para mallas sin UV buenas: esferas, piezas talladas, recortes.
//
// - Los mapas de color y de números (map, roughnessMap, alphaMap, aoMap, emissiveMap…) se mezclan
//   tal cual.
// - El de normales: cada proyección con su propio marco tangente (getTangentFrame de three, por
//   derivadas de su uv), y se suman los vectores ya en el espacio de la vista.
// - El desplazamiento se mezcla en el vértice, con la normal de la malla: no abre grietas donde
//   cambia la proyección.
//
// Es un parche del shader (onBeforeCompile): el path tracer, que no corre los shaders de three,
// no lo ve (usa las UV de la malla).
import * as THREE from 'three';

const PARS = /* glsl */ `
uniform float mtlTpScale;
uniform float mtlTpSharp;
vec3 mtlTpPesos(vec3 n) { vec3 w = pow(abs(normalize(n)) + 1e-5, vec3(mtlTpSharp)); return w / (w.x + w.y + w.z); }
vec4 mtlTp(sampler2D t, vec3 p, vec3 n) {
  vec3 w = mtlTpPesos(n), q = p / mtlTpScale;
  return texture2D(t, q.zy) * w.x + texture2D(t, q.xz) * w.y + texture2D(t, q.xy) * w.z;
}`;

const NORMALES = /* glsl */ `
#ifdef USE_NORMALMAP_TANGENTSPACE
{
  vec3 w = mtlTpPesos(vTpN), q = vTpPos / mtlTpScale;
  vec2 ua = q.zy, ub = q.xz, uc = q.xy;
  vec3 na = texture2D(normalMap, ua).xyz * 2.0 - 1.0;
  vec3 nb = texture2D(normalMap, ub).xyz * 2.0 - 1.0;
  vec3 nc = texture2D(normalMap, uc).xyz * 2.0 - 1.0;
  na.xy *= normalScale; nb.xy *= normalScale; nc.xy *= normalScale;
  mat3 ta = getTangentFrame(-vViewPosition, normal, ua);
  mat3 tb = getTangentFrame(-vViewPosition, normal, ub);
  mat3 tc = getTangentFrame(-vViewPosition, normal, uc);
  normal = normalize(w.x * (ta * na) + w.y * (tb * nb) + w.z * (tc * nc));
}
#endif`;

const DESPLAZAR = /* glsl */ `
#ifdef USE_DISPLACEMENTMAP
  transformed += normalize(objectNormal) * (mtlTp(displacementMap, position, normal).x * displacementScale + displacementBias);
#endif`;

/** Los #include de un shader, resueltos (como hace three), para poder cambiar sus muestreos. @param {string} s */
function resolver(s) {
  return s.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_, nombre) => {
    const chunk = /** @type {Record<string, string>} */ (/** @type {unknown} */ (THREE.ShaderChunk))[nombre];
    if (chunk === undefined) throw new Error(`no existe el chunk ${nombre}`);
    return resolver(chunk);
  });
}

/**
 * Le pone mapeo triplanar a un material de three (estándar o físico).
 * @param {THREE.Material} mat @param {{ scale: number, sharpness: number }} opts
 */
export function applyTriplanar(mat, { scale, sharpness }) {
  const uniforms = { mtlTpScale: { value: scale }, mtlTpSharp: { value: sharpness } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vTpPos;\nvarying vec3 vTpN;\n${PARS}`)
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvTpPos = position;\nvTpN = normal;')
      .replace('#include <displacementmap_vertex>', DESPLAZAR);
    let f = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vTpPos;\nvarying vec3 vTpN;\n${PARS}`)
      .replace('#include <normal_fragment_maps>', NORMALES);
    // el resto de los mapas: cada texture2D(xMap, vXMapUv) pasa a la mezcla de las tres proyecciones
    f = resolver(f).replace(/texture2D\(\s*(map|\w+Map)\s*,\s*v\w*Uv\s*\)/g, (todo, nombre) => (
      nombre === 'normalMap' || nombre === 'clearcoatNormalMap' ? todo : `mtlTp(${nombre}, vTpPos, vTpN)`
    ));
    sh.fragmentShader = f;
  };
  mat.customProgramCacheKey = () => 'mtl-triplanar';
  mat.userData.triplanar = uniforms;
  mat.needsUpdate = true;
  return mat;
}
