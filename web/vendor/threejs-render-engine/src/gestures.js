// Qué hace cada gesto con la cámara: tablas puras (qué botón y qué modificadores orbitan,
// desplazan o acercan; qué tecla hace qué), y la cuenta de pasar un arrastre en píxeles a
// grados, desplazamiento o factor de zoom. El motor (index.js) escucha el puntero y aplica.
//
// Un esquema es { mouse, wheel, touch }:
//   mouse   reglas en orden, la primera que coincide gana: { button, shift?, ctrl?, alt?, meta?, action }.
//           Un modificador que la regla no nombra no importa. button: 0 izquierdo, 1 medio, 2 derecho.
//   wheel   'zoom' o null.
//   touch   { 1: acción con un dedo, 2: 'pan-zoom' (desplazar y pellizcar) o null }.
// Acciones: 'orbit', 'pan', 'dolly' (arrastrar para acercar) o null (el gesto es de la app).
//
// Puro: no importa three ni DOM.

/** @typedef {'orbit' | 'pan' | 'dolly'} Action */
/** @typedef {{ button: number, shift?: boolean, ctrl?: boolean, alt?: boolean, meta?: boolean, action: Action | null }} MouseRule */
/** @typedef {{ mouse: MouseRule[], wheel: 'zoom' | null, touch: { 1: Action | null, 2: 'pan-zoom' | null } }} Scheme */
/** @typedef {{ button: number, shiftKey?: boolean, ctrlKey?: boolean, altKey?: boolean, metaKey?: boolean }} Buttons */

const TOUCH = Object.freeze({ 1: 'orbit', 2: 'pan-zoom' });

/** Los esquemas que trae el motor. Uno propio es un objeto con la misma forma. */
export const SCHEMES = /** @type {Readonly<Record<string, Readonly<Scheme>>>} */ (Object.freeze({
  // el de three (OrbitControls): izquierdo orbita (con Ctrl, Cmd o Shift desplaza), medio
  // acerca, derecho desplaza
  three: Object.freeze({
    mouse: Object.freeze([
      { button: 0, ctrl: true, action: 'pan' }, { button: 0, meta: true, action: 'pan' }, { button: 0, shift: true, action: 'pan' },
      { button: 0, action: 'orbit' }, { button: 1, action: 'dolly' }, { button: 2, action: 'pan' },
    ]),
    wheel: 'zoom', touch: TOUCH,
  }),
  // el de los CAD (SolidWorks, Fusion, Rhino): medio orbita, Shift + medio desplaza; el
  // izquierdo y el derecho quedan para la app (seleccionar, arrastrar, menú)
  cad: Object.freeze({
    mouse: Object.freeze([{ button: 1, shift: true, action: 'pan' }, { button: 1, ctrl: true, action: 'dolly' }, { button: 1, action: 'orbit' }]),
    wheel: 'zoom', touch: TOUCH,
  }),
  // el de Blender: como cad, con Ctrl + medio para acercar arrastrando
  blender: Object.freeze({
    mouse: Object.freeze([{ button: 1, shift: true, action: 'pan' }, { button: 1, ctrl: true, action: 'dolly' }, { button: 1, action: 'orbit' }]),
    wheel: 'zoom', touch: TOUCH,
  }),
}));

const ACCIONES = ['orbit', 'pan', 'dolly', null];

/**
 * Un esquema por nombre, o uno propio validado.
 * @param {string | Scheme} s @returns {Scheme}
 */
export function scheme(s) {
  if (typeof s === 'string') {
    const found = SCHEMES[s];
    if (!found) throw new Error(`esquema desconocido: ${s} (van ${Object.keys(SCHEMES).join(', ')}, o una tabla { mouse, wheel, touch })`);
    return found;
  }
  if (!s || typeof s !== 'object' || !Array.isArray(s.mouse)) throw new TypeError('el esquema va como un nombre o { mouse: [reglas], wheel, touch }');
  for (const r of s.mouse) {
    if (![0, 1, 2].includes(r.button)) throw new Error(`regla con un botón inválido: ${JSON.stringify(r)} (van 0, 1, 2)`);
    if (!ACCIONES.includes(r.action)) throw new Error(`acción desconocida: ${r.action} (van orbit, pan, dolly, null)`);
  }
  if (s.wheel !== undefined && s.wheel !== null && s.wheel !== 'zoom') throw new Error("wheel va 'zoom' o null");
  const touch = { ...TOUCH, ...(s.touch ?? {}) };
  if (!ACCIONES.includes(touch[1])) throw new Error(`touch[1] va orbit, pan, dolly o null (llegó ${touch[1]})`);
  if (touch[2] !== null && touch[2] !== 'pan-zoom') throw new Error("touch[2] va 'pan-zoom' o null");
  return { mouse: s.mouse.map((r) => ({ ...r })), wheel: s.wheel === undefined ? 'zoom' : s.wheel, touch };
}

/**
 * Qué hace un botón del mouse con esos modificadores: una acción, o null (es de la app).
 * @param {Scheme} s @param {Buttons} e @returns {Action | null}
 */
export function mouseAction(s, e) {
  const mods = /** @type {const} */ ([['shift', 'shiftKey'], ['ctrl', 'ctrlKey'], ['alt', 'altKey'], ['meta', 'metaKey']]);
  for (const r of s.mouse) {
    if (r.button !== e.button) continue;
    if (mods.every(([k, ek]) => r[k] === undefined || r[k] === !!e[ek])) return r.action;
  }
  return null;
}

/** Los grados que orbita un arrastre de toda la altura del visor (como OrbitControls). */
export const DEGREES_PER_HEIGHT = 360;

/**
 * Un arrastre (en píxeles; y hacia abajo) en grados de órbita: arrastrar a la derecha lleva la
 * cámara a la izquierda (el objeto sigue a la mano), y hacia abajo la sube.
 * @param {number} dx @param {number} dy @param {number} height
 * @returns {[number, number]}
 */
export function dragToOrbit(dx, dy, height) {
  const k = DEGREES_PER_HEIGHT / Math.max(1, height);
  return [-dx * k, dy * k];
}

/**
 * Un arrastre de acercar (hacia arriba acerca) en factor de zoom.
 * @param {number} dy @param {number} height
 */
export function dragToZoom(dy, height) {
  return Math.exp((-dy * 3) / Math.max(1, height));
}

/**
 * La rueda en factor de zoom: hacia adelante (deltaY negativo) acerca. `deltaMode`: 0 píxeles,
 * 1 líneas, 2 páginas, como el evento del navegador.
 * @param {number} deltaY @param {number} [deltaMode] @param {number} [height]
 */
export function wheelToZoom(deltaY, deltaMode = 0, height = 800) {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * height : deltaY;
  return 0.95 ** (px / 100);
}

// ---------- teclado ----------

/** @typedef {{ orbit?: [number, number], pan?: [number, number], zoom?: number, go?: string, projection?: 'toggle' | 'perspective' | 'orthographic' }} KeyCommand */

/**
 * Las teclas por defecto, por `code` del evento (la tecla física: anda igual con cualquier
 * distribución): flechas orbitan 15°, con Shift desplazan 40 px; + y − acercan; el numpad va
 * a las vistas como en Blender (1 frente, 3 derecha, 7 arriba; con Ctrl, del otro lado) y 5
 * cambia de proyección. Encuadrar (F) no está: qué se encuadra lo decide la app.
 */
export const KEYS = /** @type {Readonly<Record<string, KeyCommand>>} */ (Object.freeze({
  ArrowLeft: { orbit: [-15, 0] }, ArrowRight: { orbit: [15, 0] }, ArrowUp: { orbit: [0, 15] }, ArrowDown: { orbit: [0, -15] },
  'shift+ArrowLeft': { pan: [-40, 0] }, 'shift+ArrowRight': { pan: [40, 0] }, 'shift+ArrowUp': { pan: [0, 40] }, 'shift+ArrowDown': { pan: [0, -40] },
  Equal: { zoom: 1.25 }, NumpadAdd: { zoom: 1.25 }, Minus: { zoom: 0.8 }, NumpadSubtract: { zoom: 0.8 },
  Numpad1: { go: 'front' }, 'ctrl+Numpad1': { go: 'back' }, Numpad3: { go: 'right' }, 'ctrl+Numpad3': { go: 'left' },
  Numpad7: { go: 'top' }, 'ctrl+Numpad7': { go: 'bottom' }, Numpad5: { projection: 'toggle' },
}));

/**
 * La combinación de un evento de teclado como la escriben las tablas: 'ctrl+alt+shift+meta+Code'.
 * @param {{ code: string, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean, metaKey?: boolean }} e
 */
export function keyCombo(e) {
  return [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'meta', e.code].filter(Boolean).join('+');
}

/**
 * Qué hace una tecla con esa tabla, o null.
 * @param {Readonly<Record<string, KeyCommand>>} bindings @param {Parameters<typeof keyCombo>[0]} e @returns {KeyCommand | null}
 */
export function keyAction(bindings, e) {
  return bindings[keyCombo(e)] ?? null;
}

/**
 * Una tabla de teclas propia, validada (con las combinaciones en el orden de keyCombo).
 * @param {Record<string, KeyCommand>} t @returns {Record<string, KeyCommand>}
 */
export function keyBindings(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new TypeError("las teclas van como { 'shift+ArrowLeft': { pan: [-40, 0] }, … }");
  /** @type {Record<string, KeyCommand>} */
  const out = {};
  const orden = ['ctrl', 'alt', 'shift', 'meta'];
  for (const [k, cmd] of Object.entries(t)) {
    const partes = k.split('+');
    const code = /** @type {string} */ (partes.pop());
    for (const m of partes) if (!orden.includes(m)) throw new Error(`modificador desconocido en ${k}: ${m} (van ${orden.join(', ')})`);
    const claves = Object.keys(cmd ?? {});
    if (claves.length !== 1 || !['orbit', 'pan', 'zoom', 'go', 'projection'].includes(claves[0])) throw new Error(`la tecla ${k} va con un comando: { orbit } | { pan } | { zoom } | { go } | { projection }`);
    out[keyCombo({ code, ctrlKey: partes.includes('ctrl'), altKey: partes.includes('alt'), shiftKey: partes.includes('shift'), metaKey: partes.includes('meta') })] = cmd;
  }
  return out;
}

// ---------- inercia ----------

/**
 * Cuánto de lo pendiente se aplica en un cuadro de `dt` segundos, con `damping` (la fracción
 * por cuadro a 60 fps, como OrbitControls): igual a cualquier fps. Sin damping, todo.
 * @param {number} damping @param {number} dt
 */
export function dampingStep(damping, dt) {
  if (!(damping > 0) || damping >= 1) return 1;
  return 1 - (1 - damping) ** (Math.max(0, dt) * 60);
}
