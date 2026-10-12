// Qué objetos se dejan afuera de cada cosa que dibuja el motor, además del cuadro principal.
//
//   userData.noEdge     no sale en el contorno fino (piso, grilla, cotas, guías)
//   userData.noAO       no entra en la oclusión ambiental
//   userData.noRender   no sale en el render final (path tracing)
//
// Un espejo (`Reflector` de three, `isReflector`) dibuja la escena reflejada en su
// onBeforeRender, o sea en CADA render que lo incluye: en las pasadas auxiliares (aristas, AO,
// contornos de selección) se lo deja afuera solo, así cuesta un render extra por cuadro y no uno
// por pasada. Para el path tracer tampoco existe: igual que cualquier material de shader propio,
// no lo puede representar (el espejo de verdad, ahí, es un material estándar con metalness 1 y
// roughness 0).
//
// Puro: no importa three ni DOM (trabaja con las banderas de los objetos).

/** @typedef {{ userData: Record<string, any>, isReflector?: boolean, isLine?: boolean, isPoints?: boolean, isSprite?: boolean, isMesh?: boolean, material?: any }} Objeto */

/** ¿Un material que el path tracer no entiende (de shader propio)? @param {any} m */
const deShader = (m) => !!(m && (m.isShaderMaterial || m.isRawShaderMaterial));

/** Fuera de la pasada de aristas. @param {Objeto} o */
export const sinAristas = (o) => !!(o.userData.noEdge || o.isReflector);

/** Fuera de los contornos de selección (su máscara y su profundidad). @param {Objeto} o */
export const sinContorno = (o) => !!o.isReflector;

/** Fuera de la oclusión ambiental. @param {Objeto} o */
export const sinAO = (o) => !!(o.userData.noAO || o.isReflector);

/** Fuera del render final: lo marcado, lo que no es superficie y lo de shader propio. @param {Objeto} o */
export function sinRender(o) {
  if (o.userData.noRender || o.isReflector || o.isLine || o.isPoints || o.isSprite) return true;
  if (!o.isMesh) return false;
  return Array.isArray(o.material) ? o.material.some(deShader) : deShader(o.material);
}
