// Resolución dinámica: con cuántos píxeles se dibuja el visor, según cuánto tarda cada cuadro.
// Si no se llega a los fps pedidos se baja (la imagen se estira y se ve más blanda); si sobra
// margen un rato, se vuelve a subir. Ayuda cuando el cuello de botella es la GPU (pantallas
// grandes, placas integradas); si lo que tarda es el procesador, bajar píxeles no cambia nada,
// y por eso hay un mínimo.
//
// Mira el percentil 75 de una ventana de cuadros (no un cuadro suelto: un tirón no cuenta), y
// sube despacio y baja rápido. Con vsync el cuadro nunca baja de 1000/Hz, así que no se puede
// medir cuánto margen sobra: solo si llega o no. Por eso recuerda el TECHO, la escala que
// resultó lenta, y por un rato (`memory` mediciones) no vuelve a pasar del 95% de ella; si no,
// subiría hasta pasarse, bajaría, y otra vez. Pasado ese rato vuelve a probar, por si la escena
// se aligeró.
//
// Puro: no importa three ni DOM.

/** @typedef {{ min?: number, max?: number, fps?: number, start?: number, window?: number, calm?: number, memory?: number }} AutoOptions */

/**
 * @param {AutoOptions} [opts] `min`/`max`: límites de la escala (0.35 y 1); `fps`: objetivo (60);
 *   `window`: cuadros por medición (30); `calm`: mediciones seguidas sin tirones para subir (4);
 *   `memory`: cuántas mediciones se respeta el techo (20, unos 10 s a 60 fps).
 */
export function createAutoScale({ min = 0.35, max = 1, fps = 60, start = 1, window = 30, calm = 4, memory = 20 } = {}) {
  if (!(min > 0) || !(max >= min)) throw new RangeError(`límites inválidos: min ${min}, max ${max}`);
  if (!(fps > 0)) throw new RangeError(`fps inválido: ${fps}`);
  const presupuesto = 1000 / fps;
  const limitar = (/** @type {number} */ s) => Math.round(Math.min(max, Math.max(min, s)) * 100) / 100;
  let scale = limitar(start);
  /** @type {number[]} */
  let muestras = [];
  let tranquilo = 0;
  /** Hasta dónde se puede subir por ahora, cuántas mediciones más dura, y cuánto esperar la próxima vez. */
  let techo = Infinity, vidaTecho = 0, espera = memory;
  /** ¿La última decisión fue subir? Si después no llega, esa prueba falló. */
  let recienSubio = false;
  return {
    get scale() { return scale; },
    get options() { return { min, max, fps }; },
    /**
     * Un cuadro más, con lo que tardó en ms. Devuelve la escala nueva si cambió, o null.
     * @param {number} ms
     */
    sample(ms) {
      if (!(ms > 0) || ms > 250) return null; // pestaña oculta, pausa o un corte: no cuenta
      muestras.push(ms);
      if (muestras.length < window) return null;
      muestras.sort((a, b) => a - b);
      const p75 = muestras[Math.floor(muestras.length * 0.75)];
      muestras = [];
      if (vidaTecho > 0 && --vidaTecho === 0) techo = Infinity;
      let nueva = scale;
      if (p75 > presupuesto * 1.1) {
        // baja a la escala que llegaría justo (los píxeles van con el cuadrado de la escala), y no
        // la pasa por un rato; si esto vino de una subida, la próxima prueba espera el doble
        nueva = scale * Math.max(0.7, Math.sqrt(presupuesto / p75));
        if (recienSubio) espera = Math.min(espera * 2, memory * 8);
        techo = limitar(nueva);
        vidaTecho = espera;
        recienSubio = false;
        tranquilo = 0;
      } else if (p75 <= presupuesto * 1.04) {
        if (++tranquilo >= calm) {
          tranquilo = 0;
          if (recienSubio) espera = memory; // la última subida aguantó: paciencia normal
          const tope = Math.min(scale * 1.1, techo);
          recienSubio = tope > scale + 0.005;
          if (recienSubio) nueva = tope;
        }
      } else {
        tranquilo = 0;
      }
      nueva = limitar(nueva);
      if (nueva === scale) return null;
      scale = nueva;
      return scale;
    },
  };
}
