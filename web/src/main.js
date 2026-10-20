// La aplicación: el estado del trabajo y lo que hace cada gesto. El visor dibuja, el HUD
// muestra la línea de tiempo y los deslizadores, y el servidor resuelve las curvas.
import { Point3d } from '../vendor/threejs-cad-sdk/src/index.js';
import * as api from './api.js';
import { crearVisor } from './visor.js';
import { crearHud } from './hud.js';

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const MAXILARES = { sup: 'Superior', inf: 'Inferior' };
const MODOS = { v: 'vestibular', l: 'lingual', e: 'extremo' };
const DESLIZADORES = [
  { id: 'offset', titulo: 'Offset', min: -5, max: 5, paso: 0.05, unidad: 'mm' },
  { id: 'amplitud', titulo: 'Festoneado', min: -3, max: 6, paso: 0.05, unidad: 'mm' },
  // el largo de las tangentes Bézier: festones anchos y uniones afiladas, o al revés
  { id: 'ancho', titulo: 'Ancho de festón', min: 0.1, max: 0.7, paso: 0.01, sinSigno: true },
];

// inversas: lo que se corrió a mano cada punto intermedio, { 'c1|c2': [dx, dy, dz] }
const nuevoMaxilar = () => ({ offset: 0, amplitud: 0, ancho: 0.4, controladores: [], inversas: {} });
const estado = {
  /** @type {{ malla: string, nombre: string, maxilar: string | null, mov: string, usar: boolean, arriba: number[] }[]} */
  archivos: [],
  maxilares: { sup: nuevoMaxilar(), inf: nuevoMaxilar() },
  maxilar: /** @type {'sup' | 'inf' | null} */ (null),
  num: /** @type {string | null} */ (null),
  /** El modo de marcar puntos; null: apagado, los clics no agregan nada. */
  modo: /** @type {'v' | 'l' | 'e' | null} */ ('v'),
  /** El punto elegido: un controlador, o `i:<clave>` si es un punto intermedio. */
  seleccion: /** @type {string | null} */ (null),
  /** Los controladores elegidos (shift + clic suma): a ellos van las casillas de offset y festoneado. */
  elegidos: /** @type {Set<string>} */ (new Set()),
};
const esInversa = (id) => !!id?.startsWith('i:');
/** Lo que resolvió el servidor: curvas[maxilar][num]. */
const curvas = { sup: {}, inf: {} };
/** Los modelos de un trabajo abierto que no estaban en su ruta: se buscan en otra carpeta. */
let pendientes = /** @type {any[]} */ ([]);
/** Curvas de referencia importadas de un .pts, por 'maxilar|mov': [x, y, z, ...]. Solo se miran. */
let referencias = /** @type {Record<string, number[]>} */ ({});
// El archivo del proyecto. Ya guardado una vez, Guardar vuelve a escribir el mismo (si sigue
// siendo el mismo caso); "Guardar como…" pregunta dónde.
let rutaTrabajo = /** @type {string | null} */ (null);
let idTrabajo = '';
/** El nombre del último guardado o abierto (también sin ruta, si fue desde el navegador). */
let nombreTrabajo = '';
/** Cómo estaba el proyecto al guardarlo o abrirlo: si cambió, hay cambios sin guardar. */
let firmaGuardada = '';
/** El respaldo que se escribe solo (<ID>.trimline.bak): dónde y cómo estaba el proyecto. */
let rutaRespaldo = /** @type {string | null} */ (null);
let firmaRespaldo = '';
/** Con qué se escribió el último respaldo (su ruta, o su nombre si lo ubica el servidor). */
let claveRespaldo = '';
let esperaRespaldo = 0;

const visor = await crearVisor($('visor'));
const hud = crearHud(visor.motor, {
  alMovimiento: irA, alDeslizar: deslizar, alBoton: (id) => { if (id === 'candado') candado(); },
  // el ⋯ arriba del cursor: el mismo menú que el clic derecho (un segundo clic lo cierra)
  alMenu: (num, x, y) => {
    if (menuRecienCerrado === num) return;
    const r = visor.lienzo.getBoundingClientRect();
    abrirMenuMov(num, { clientX: r.left + x, clientY: r.top + y }, true);
  },
});

// ---------- avisos ----------
let borrarAviso = 0;
function avisar(texto, error = false) {
  const e = $('estado');
  e.textContent = texto; e.classList.toggle('error', error);
  clearTimeout(borrarAviso);
  if (texto) borrarAviso = setTimeout(() => { e.textContent = ''; }, error ? 8000 : 3500);
}

// ---------- el cartel de carga (abrir o crear un proyecto) ----------
const carga = /** @type {HTMLDialogElement} */ ($('carga'));
carga.addEventListener('cancel', (ev) => ev.preventDefault());   // Esc no lo cierra: termina solo
function mostrarCarga(titulo) {
  $('carga-titulo').textContent = titulo;
  progresoCarga('');
  if (!carga.open) carga.showModal();
}
/** Sin `total`, la barra va y viene (no se sabe cuánto falta). */
function progresoCarga(texto, hechos = 0, total = 0) {
  const barra = /** @type {HTMLProgressElement} */ (carga.querySelector('progress'));
  if (total) { barra.max = total; barra.value = hechos; } else barra.removeAttribute('value');
  $('carga-texto').textContent = texto;
}
function cerrarCarga() { if (carga.open) carga.close(); }

// ---------- lo que se deriva del estado ----------
/** Los movimientos elegidos de un maxilar, en orden: [{ num, malla }]. */
function movimientos(maxilar) {
  return estado.archivos
    .filter((a) => a.usar && a.maxilar === maxilar && a.mov !== '')
    .sort((a, b) => a.mov.localeCompare(b.mov, undefined, { numeric: true }))
    .filter((a, i, t) => i === 0 || t[i - 1].mov !== a.mov)
    .map((a) => ({ num: a.mov, malla: a.malla }));
}
const base = (maxilar) => movimientos(maxilar)[0]?.num ?? null;
/** Lo que no lleva un movimiento del maxilar: { offset?: false, festoneado?: false }. */
const sinAjusteDe = (maxilar, num) => estado.maxilares[maxilar]?.sinAjuste?.[num] ?? {};
/** Pone o saca una excepción (corte seco) en unos movimientos. Los puntos no se tocan. */
function ponerAjuste(maxilar, nums, campo, lleva) {
  const max = estado.maxilares[maxilar];
  if (!max) return;
  recordar();
  const sa = { ...max.sinAjuste };
  for (const num of nums) {
    const e = { ...sa[num] };
    if (lleva) delete e[campo]; else e[campo] = false;
    if (Object.keys(e).length) sa[num] = e; else delete sa[num];
  }
  if (Object.keys(sa).length) max.sinAjuste = sa; else delete max.sinAjuste;
  pintarPanel();
  if (maxilar === estado.maxilar) resolverTodo();
}
const actual = () => (estado.maxilar ? estado.maxilares[estado.maxilar] : null);
/** El maxilar como lo entiende el servidor. */
const paraServidor = (maxilar) => ({ ...estado.maxilares[maxilar], movimientos: movimientos(maxilar) });

// ---------- carga de modelos ----------
// Los modelos los lee siempre el servidor desde el disco: así el proyecto anota la ruta completa
// de cada uno. Se eligen al crear el proyecto (el asistente); después solo se buscan los que
// faltan al abrir uno.

/** Lo que se suelta sobre la página: los .pts de referencia. Los modelos van por Nuevo proyecto. */
async function soltarArchivos(lista) {
  const pts = [...lista].filter((a) => /\.pts$/i.test(a.name));
  if (pts.length) await cargarReferencias(pts);
  if ([...lista].some((a) => /\.(stl|ply|obj)$/i.test(a.name))) {
    avisar('Los modelos se eligen desde su carpeta, para que el proyecto sepa dónde están: Trabajo → Nuevo proyecto.', true);
  }
}

/** Los modelos que no estaban donde decía el proyecto, desde otra carpeta. */
async function buscarFaltantes() {
  try {
    const { carpeta } = await api.elegirCarpeta(carpetaDe(rutaTrabajo) ?? carpetaDe(estado.archivos.find((a) => a.ruta)?.ruta), 'Carpeta con los modelos que faltan');
    if (!carpeta) return;
    avisar('Buscando…');
    const r = await api.mallasDeCarpeta(carpeta, pendientes.map((p) => p.nombre));
    if (!r.mallas.length) { avisar(`En ${carpeta} no está ninguno de los que faltan.`, true); return; }
    for (const m of r.mallas) await agregarMalla(m);
    finCarga();
  } catch (e) { avisar(e.message, true); }
}

async function agregarMalla(r) {
  if (!visor.tiene(r.id)) visor.registrar(r.id, await api.bajarMalla(r.id));
  if (estado.archivos.some((a) => a.malla === r.id && a.nombre === r.nombre)) return;
  const previo = pendientes.find((p) => p.malla === r.id && p.nombre === r.nombre) ?? pendientes.find((p) => p.nombre === r.nombre);
  if (previo) pendientes = pendientes.filter((p) => p !== previo);
  estado.archivos.push({
    malla: r.id, nombre: r.nombre, arriba: r.arriba, ruta: r.ruta ?? previo?.ruta,
    maxilar: previo?.maxilar ?? r.archivo.maxilar, mov: previo?.mov ?? r.archivo.movimiento ?? '', usar: previo?.usar ?? true,
  });
  const caso = /** @type {HTMLInputElement} */ ($('caso'));
  if (!caso.value && r.archivo.id) caso.value = r.archivo.id;
}

function finCarga() {
  estado.archivos.sort((a, b) => (a.maxilar ?? 'z').localeCompare(b.maxilar ?? 'z') || a.mov.localeCompare(b.mov, undefined, { numeric: true }));
  avisar(pendientes.length ? `${estado.archivos.length} modelos cargados; faltan ${pendientes.length}` : `${estado.archivos.length} modelos cargados`);
  alCambiarArchivos();
}

/** Lee .pts y los deja de referencia; uno sin maxilar ni movimiento en el nombre va al que se mira. */
async function cargarReferencias(lista) {
  for (const archivo of lista) {
    try {
      const { curvas: cs } = await api.referencia(archivo);
      for (const c of cs) {
        const maxilar = c.maxilar ?? estado.maxilar, mov = c.mov ?? estado.num;
        if (!maxilar || !mov) throw new Error(`${archivo.name}: no dice de qué maxilar y movimiento es; abrí primero el modelo`);
        referencias[`${maxilar}|${mov}`] = c.puntos;
      }
      avisar(`Referencia: ${archivo.name}`);
    } catch (e) { avisar(String(e.message ?? e), true); }
  }
  pintarPanel(); mostrar();
}

/** Cuánto se separa la referencia de la curva: para cada punto de la referencia, la distancia a la curva. */
function separacion(clave) {
  const [maxilar, num] = clave.split('|');
  const ref = referencias[clave], r = curvas[maxilar]?.[num];
  if (!ref || !r) return null;
  const nuestra = r.tramos.flatMap((t) => t.puntos);
  if (nuestra.length < 6) return null;
  // distancia a cada segmento de nuestra curva (densa: 300 puntos), punto por punto de la referencia
  const ds = [];
  for (let i = 0; i < ref.length; i += 3) {
    let mejor = Infinity;
    for (let j = 0; j + 5 < nuestra.length; j += 3) {
      const ax = nuestra[j], ay = nuestra[j + 1], az = nuestra[j + 2];
      const bx = nuestra[j + 3] - ax, by = nuestra[j + 4] - ay, bz = nuestra[j + 5] - az;
      const px = ref[i] - ax, py = ref[i + 1] - ay, pz = ref[i + 2] - az;
      const t = Math.min(1, Math.max(0, (px * bx + py * by + pz * bz) / (bx * bx + by * by + bz * bz || 1)));
      mejor = Math.min(mejor, Math.hypot(px - t * bx, py - t * by, pz - t * bz));
    }
    ds.push(mejor);
  }
  return { media: ds.reduce((a, b) => a + b, 0) / ds.length, max: Math.max(...ds) };
}

/** Después de cargar o de tocar la tabla: qué maxilares hay y cuál se mira. */
function alCambiarArchivos() {
  const hay = Object.keys(MAXILARES).filter((m) => movimientos(m).length);
  if (!estado.maxilar || !hay.includes(estado.maxilar)) elegirMaxilar(hay[0] ?? null, true);
  else if (!movimientos(estado.maxilar).some((m) => m.num === estado.num)) irA(base(estado.maxilar));
  pintarPanel();
  resolverTodo();
}

function elegirMaxilar(maxilar, encuadrar = false) {
  estado.maxilar = maxilar;
  estado.seleccion = null;
  estado.elegidos = new Set();
  estado.num = maxilar ? base(maxilar) : null;
  if (maxilar) {
    const m = movimientos(maxilar)[0];
    const archivo = estado.archivos.find((a) => a.malla === m.malla);
    visor.orientar(m.malla, archivo?.arriba ?? [0, 0, 1]);
  }
  mostrar();
  if (encuadrar || maxilar) visor.encuadrar();
  pintarPanel();
  resolverTodo();
}

/** Cambia el movimiento que se mira: otra malla y su curva. */
function irA(num) {
  if (!estado.maxilar || num === null) return;
  estado.num = num;
  mostrar();
  pintarPanel();
}

function mostrar() {
  const mov = estado.maxilar ? movimientos(estado.maxilar).find((m) => m.num === estado.num) : null;
  visor.mostrar(mov?.malla ?? null);
  visor.dibujar(mov ? curvas[estado.maxilar][estado.num] ?? null : null, estado.seleccion, estado.elegidos);
  visor.referencia(mov ? referencias[`${estado.maxilar}|${estado.num}`] ?? null : null);
  pintarHud();
}

// ---------- el servidor resuelve las curvas ----------
let turno = 0, espera = 0;
/** Pide la curva del movimiento que se mira ya, y la del resto un momento después. */
function resolverTodo({ soloActual = false } = {}) {
  const maxilar = estado.maxilar;
  if (!maxilar || !estado.num) return;
  const cuerpo = paraServidor(maxilar);
  const mio = ++turno;
  const recibir = (r) => {
    if (mio !== turno && soloActual) return;                 // llegó tarde: ya hay algo más nuevo
    Object.assign(curvas[maxilar], r.movimientos);
    if (Object.keys(referencias).length) pintarReferencias();
    if (maxilar === estado.maxilar && !arrastre) mostrar();
    else if (maxilar === estado.maxilar) visor.dibujar(curvas[maxilar][estado.num] ?? null, estado.seleccion, estado.elegidos);
  };
  api.resolver(cuerpo, [estado.num]).then(recibir).catch((e) => avisar(e.message, true));
  clearTimeout(espera);
  if (soloActual) return;
  espera = setTimeout(() => {
    if (mio !== turno) return;
    api.resolver(cuerpo, null).then((r) => { if (mio === turno) recibir(r); }).catch((e) => avisar(e.message, true));
  }, 120);
}

// ---------- deshacer y rehacer ----------
// Se guardan fotos de los maxilares (puntos, keyframes, manijas, deslizadores). Un arrastre
// entero es un solo paso: la foto se toma al empezar y se apila al soltar si algo cambió.
const historial = { atras: /** @type {string[]} */ ([]), adelante: /** @type {string[]} */ ([]) };
const foto = () => JSON.stringify(estado.maxilares);
/** Apila cómo estaba todo antes de un cambio (por defecto, ahora mismo). */
function recordar(antes = foto()) {
  if (historial.atras.at(-1) === antes) return;
  historial.atras.push(antes);
  if (historial.atras.length > 200) historial.atras.shift();
  historial.adelante.length = 0;
}
function olvidarHistorial() { historial.atras.length = 0; historial.adelante.length = 0; }
/** Deshace (desde = atras) o rehace (desde = adelante) un paso. */
function viajar(desde, hacia, texto) {
  const ahora = foto();
  while (desde.length && desde.at(-1) === ahora) desde.pop();          // pasos que no cambiaron nada
  if (!desde.length) { avisar(`No hay nada para ${texto}.`); return; }
  hacia.push(ahora);
  estado.maxilares = JSON.parse(/** @type {string} */ (desde.pop()));
  const max = actual();
  const ids = new Set(max?.controladores.map((c) => c.id) ?? []);
  if (estado.seleccion && !esInversa(estado.seleccion) && !ids.has(estado.seleccion)) estado.seleccion = null;
  estado.elegidos = new Set([...estado.elegidos].filter((id) => ids.has(id)));
  for (const m of Object.keys(MAXILARES)) curvas[m] = {};
  pintarPanel(); resolverTodo();
}
const deshacer = () => viajar(historial.atras, historial.adelante, 'deshacer');
const rehacer = () => viajar(historial.adelante, historial.atras, 'rehacer');

// ---------- gestos sobre el visor ----------
let arrastre = /** @type {{ id: string, movio: boolean, antes?: string, manija?: { lado: string, clave: number[], pos: number[] }, inversa?: { clave: string, desde: number[], previo: number[] } } | null} */ (null);
let ultimoPedido = 0;
/** Shift + arrastrar en un lugar vacío: el rectángulo que elige muchos puntos de una. */
let caja = /** @type {{ x0: number, y0: number } | null} */ (null);
function pintarCaja(x, y) {
  const e = $('caja');
  e.hidden = !caja;
  if (!caja) return;
  Object.assign(e.style, {
    left: `${Math.min(caja.x0, x)}px`, top: `${Math.min(caja.y0, y)}px`,
    width: `${Math.abs(x - caja.x0)}px`, height: `${Math.abs(y - caja.y0)}px`,
  });
}
const enLienzo = (ev) => { const r = visor.lienzo.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };

visor.lienzo.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;                               // el derecho es de la cámara
  const [x, y] = enLienzo(ev);
  visor.lienzo.setPointerCapture(ev.pointerId);
  if (hud.bajar(x, y)) return;
  const max = actual();
  if (!max || !estado.num) return;
  // primero las manijas del punto elegido: agarrarlas ajusta ese festón a mano
  const manija = estado.seleccion ? visor.manijaEn(x, y) : null;
  if (manija) {
    arrastre = { id: estado.seleccion, movio: false, manija, antes: foto() };
    return;
  }
  const id = visor.controladorEn(x, y);
  if (id && ev.shiftKey && !esInversa(id)) {
    // shift suma o saca el punto de la selección, sin arrastrar
    if (estado.elegidos.has(id)) {
      estado.elegidos.delete(id);
      estado.seleccion = [...estado.elegidos].at(-1) ?? null;
    } else {
      estado.elegidos.add(id);
      estado.seleccion = id;
    }
    mostrar(); pintarPanel();
    return;
  }
  if (id) {
    // agarrar uno que ya estaba elegido no deshace la selección
    if (!estado.elegidos.has(id)) estado.elegidos = esInversa(id) ? new Set() : new Set([id]);
    estado.seleccion = id;
    arrastre = { id, movio: false, antes: foto() };
    if (esInversa(id)) {
      const clave = id.slice(2);
      arrastre.inversa = { clave, desde: visor.posicion(id) ?? [0, 0, 0], previo: max.inversas?.[clave] ?? [0, 0, 0] };
    }
    mostrar(); pintarPanel();
    return;
  }
  if (ev.shiftKey) {
    caja = { x0: x, y0: y };
    pintarCaja(x, y);
    return;
  }
  if (!estado.modo) {
    // sin modo de marcar, un clic afuera de los puntos suelta la selección
    if (estado.seleccion || estado.elegidos.size) {
      estado.seleccion = null; estado.elegidos = new Set();
      mostrar(); pintarPanel();
    }
    return;
  }
  const golpe = visor.picar(x, y);
  if (!golpe) return;
  if (estado.num !== base(estado.maxilar)) {
    avisar(`Los puntos se marcan en el primer movimiento (${base(estado.maxilar)}). Acá se mueven los que ya están.`, true);
    return;
  }
  if (estado.modo === 'e' && max.controladores.filter((c) => c.tipo === 'e').length >= 2) {
    avisar('Ya están los dos extremos: movelos o borrá uno.', true);
    return;
  }
  const aca = Point3d.from(golpe.pos);
  if (max.controladores.some((c) => c.claves[estado.num] && aca.distanceTo(c.claves[estado.num]) < 0.3)) return;
  const nuevo = { id: `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e3)}`, tipo: estado.modo, claves: { [estado.num]: golpe.pos } };
  recordar();
  max.controladores.push(nuevo);
  estado.seleccion = nuevo.id;
  estado.elegidos = new Set([nuevo.id]);
  pintarPanel();
  resolverTodo();
});

visor.lienzo.addEventListener('pointermove', (ev) => {
  const [x, y] = enLienzo(ev);
  if (hud.arrastrando) { hud.mover(x); visor.lienzo.style.cursor = 'grabbing'; return; }
  if (caja) { pintarCaja(x, y); return; }
  if (!arrastre) {
    // sobre un control del visor (línea de tiempo, deslizadores, ⋯): la mano o el dedo
    const mano = ev.buttons === 0 ? hud.encima(x, y) : null;
    if (mano) { visor.resaltar(null); visor.lienzo.style.cursor = mano; return; }
    // sin arrastrar: el punto cercano se agranda, para saber que el clic lo agarra
    if (ev.buttons === 0) {
      const manija = estado.seleccion ? visor.manijaEn(x, y) : null;
      visor.resaltar(manija ? null : visor.controladorEn(x, y), !!manija || undefined);
    }
    return;
  }
  if (arrastre.inversa) {
    // el punto intermedio guarda cuánto se corrió de donde lo pone la curva: sigue a sus dientes
    const golpe = visor.picar(x, y);
    if (!golpe) return;
    const { clave, desde, previo } = arrastre.inversa;
    const max = actual();
    max.inversas = { ...max.inversas, [clave]: previo.map((v, k) => v + golpe.pos[k] - desde[k]) };
    arrastre.movio = true;
    visor.moverPunto(arrastre.id, golpe.pos);
    const ahora = performance.now();
    if (ahora - ultimoPedido > 60) { ultimoPedido = ahora; resolverTodo({ soloActual: true }); }
    return;
  }
  const c = actual().controladores.find((k) => k.id === arrastre.id);
  if (!c) return;
  if (arrastre.manija) {
    // la manija se guarda como vector desde su cresta: vale para todos los movimientos
    const { lado, clave } = arrastre.manija;
    const p = visor.enPlano(x, y, arrastre.manija.pos);
    c.manijas = { ...c.manijas, [lado]: [p[0] - clave[0], p[1] - clave[1], p[2] - clave[2]] };
    arrastre.movio = true;
    visor.moverManija(lado, p);
    const ahora = performance.now();
    if (ahora - ultimoPedido > 60) { ultimoPedido = ahora; resolverTodo({ soloActual: true }); }
    return;
  }
  const golpe = visor.picar(x, y);
  if (!golpe) return;
  // mover un punto en un movimiento le deja un keyframe ahí; los demás keyframes no se tocan
  c.claves[estado.num] = golpe.pos;
  arrastre.movio = true;
  visor.moverPunto(c.id, golpe.pos);
  const ahora = performance.now();
  if (ahora - ultimoPedido > 60) { ultimoPedido = ahora; resolverTodo({ soloActual: true }); }
});

function soltar(ev) {
  const [x, y] = enLienzo(ev);
  if (hud.arrastrando) { hud.soltar(x); visor.lienzo.style.cursor = hud.encima(x, y) ?? ''; return; }
  if (caja) {
    // los de adentro se suman a la selección
    const ids = visor.controladoresEn(caja.x0, caja.y0, x, y);
    caja = null;
    pintarCaja(x, y);
    if (!ids.length) return;
    if (esInversa(estado.seleccion)) estado.seleccion = null;
    for (const id of ids) estado.elegidos.add(id);
    estado.seleccion ??= ids.at(-1) ?? null;
    mostrar(); pintarPanel();
    avisar(`${estado.elegidos.size} puntos elegidos`);
    return;
  }
  if (!arrastre) return;
  const { movio, antes } = arrastre;
  arrastre = null;
  if (movio && antes) recordar(antes);
  if (movio) resolverTodo(); else mostrar();
  pintarPanel();
}
visor.lienzo.addEventListener('pointerup', soltar);
visor.lienzo.addEventListener('pointercancel', soltar);
visor.lienzo.addEventListener('pointerleave', () => { hud.encima(-1e4, -1e4); visor.lienzo.style.cursor = ''; });
// el menú del navegador no: en Windows el clic derecho llega al soltar, y para entonces el
// mouse ya está sobre nuestro menú (no sobre el lienzo)
document.querySelector('main')?.addEventListener('contextmenu', (ev) => ev.preventDefault());

// clic derecho sobre un movimiento de la línea de tiempo: si lleva offset y festoneado. Se
// atrapa antes que la cámara (que orbita con el derecho).
const menuMov = $('menu-mov');
let menuNum = /** @type {string | null} */ (null);
/** El movimiento cuyo menú se cerró con este mismo clic (para que el ⋯ abra y cierre). */
let menuRecienCerrado = /** @type {string | null} */ (null);
/** `arriba`: desde el ⋯ (en `ev`, su borde de abajo): el menú va encima, sin taparlo. */
function abrirMenuMov(num, ev, arriba = false) {
  menuNum = num;
  pintarMenuMov();
  const caja = $('visor').getBoundingClientRect();
  menuMov.hidden = false;
  const x = Math.min(ev.clientX - caja.left - (arriba ? menuMov.offsetWidth / 2 : 0), caja.width - menuMov.offsetWidth - 8);
  const y = arriba ? ev.clientY - caja.top - 30 - menuMov.offsetHeight
    : Math.min(ev.clientY - caja.top, caja.height - menuMov.offsetHeight - 8);
  Object.assign(menuMov.style, { left: `${Math.max(8, x)}px`, top: `${Math.max(8, y)}px` });
}
function cerrarMenuMov() { menuMov.hidden = true; menuNum = null; }
function pintarMenuMov() {
  if (!menuNum || !estado.maxilar) return;
  const s = sinAjusteDe(estado.maxilar, menuNum);
  /** @type {HTMLElement} */ (menuMov.querySelector('.titulo-menu')).textContent = `${MAXILARES[estado.maxilar]} · movimiento ${menuNum}`;
  for (const caja of /** @type {NodeListOf<HTMLInputElement>} */ (menuMov.querySelectorAll('input[data-campo]'))) {
    caja.checked = s[/** @type {string} */ (caja.dataset.campo)] !== false;
  }
  const nums = movimientos(estado.maxilar).map((m) => m.num);
  const despues = nums.slice(nums.indexOf(menuNum) + 1);
  const hasta = /** @type {HTMLSelectElement} */ ($('menu-hasta'));
  hasta.replaceChildren(new Option('—', ''), ...despues.map((n) => new Option(n, n)));
  /** @type {HTMLElement} */ (hasta.closest('label')).hidden = !despues.length;
}
$('visor').addEventListener('pointerdown', (ev) => {
  menuRecienCerrado = null;
  if (!menuMov.hidden && !menuMov.contains(/** @type {Node} */ (ev.target))) { menuRecienCerrado = menuNum; cerrarMenuMov(); }
  if (ev.button !== 2 || !estado.maxilar) return;
  const [x, y] = enLienzo(ev);
  const num = hud.movimientoEn(x, y);
  if (!num) return;
  ev.stopPropagation();                                       // que no orbite
  abrirMenuMov(num, ev);
}, { capture: true });
for (const caja of /** @type {NodeListOf<HTMLInputElement>} */ (menuMov.querySelectorAll('input[data-campo]'))) {
  caja.addEventListener('change', () => {
    if (menuNum && estado.maxilar) ponerAjuste(estado.maxilar, [menuNum], /** @type {string} */ (caja.dataset.campo), caja.checked);
    pintarMenuMov();
  });
}
// "igual hasta el": copia lo de este movimiento a los siguientes, hasta el elegido
$('menu-hasta').addEventListener('change', (ev) => {
  const hasta = /** @type {HTMLSelectElement} */ (ev.target).value;
  if (!hasta || !menuNum || !estado.maxilar) return;
  const nums = movimientos(estado.maxilar).map((m) => m.num);
  const tramo = nums.slice(nums.indexOf(menuNum), nums.indexOf(hasta) + 1);
  const s = sinAjusteDe(estado.maxilar, menuNum);
  const max = estado.maxilares[estado.maxilar];
  recordar();
  const sa = { ...max.sinAjuste };
  for (const n of tramo) { if (Object.keys(s).length) sa[n] = { ...s }; else delete sa[n]; }
  if (Object.keys(sa).length) max.sinAjuste = sa; else delete max.sinAjuste;
  avisar(`Movimientos ${menuNum} a ${hasta}: ${s.offset === false || s.festoneado === false ? `sin ${[s.offset === false && 'offset', s.festoneado === false && 'festoneado'].filter(Boolean).join(' ni ')}` : 'con offset y festoneado'}.`);
  cerrarMenuMov();
  pintarPanel(); resolverTodo();
});

let antesDeDeslizar = /** @type {string | null} */ (null);
function deslizar(id, valor, final) {
  const max = actual();
  if (!max) return;
  antesDeDeslizar ??= foto();
  // 'l.<campo>': el del lado lingual (con el candado abierto); si no, el general / vestibular
  if (id.startsWith('l.')) { if (max.lingual) max.lingual[id.slice(2)] = valor; } else max[id] = valor;
  if (final) { recordar(antesDeDeslizar); antesDeDeslizar = null; }
  pintarHud();
  const ahora = performance.now();
  if (final) resolverTodo();
  else if (ahora - ultimoPedido > 60) { ultimoPedido = ahora; resolverTodo({ soloActual: true }); }
}

/**
 * El candado de los deslizadores: cerrado, offset, festoneado y ancho valen igual para vestibular
 * y lingual; abierto, el lingual tiene los suyos (arrancan iguales). Al cerrarlo quedan los vestibulares.
 */
function candado() {
  const max = actual();
  if (!max) return;
  recordar();
  if (max.lingual) delete max.lingual;
  else max.lingual = { offset: max.offset, amplitud: max.amplitud, ancho: max.ancho };
  pintarHud(); resolverTodo();
}

/** Saca lo que se le hizo a mano a un punto intermedio: vuelve adonde lo pone la curva. */
function restablecerInversa() {
  const max = actual();
  const clave = estado.seleccion?.slice(2);
  if (!max || !clave || !max.inversas?.[clave]) return;
  recordar();
  const { [clave]: _, ...resto } = max.inversas;
  max.inversas = resto;
  pintarPanel(); resolverTodo();
}

function borrarPunto() {
  const max = actual();
  if (!max || !estado.seleccion) return;
  if (esInversa(estado.seleccion)) { restablecerInversa(); return; }
  recordar();
  const borrar = new Set([...estado.elegidos, estado.seleccion]);
  max.controladores = max.controladores.filter((c) => !borrar.has(c.id));
  // los ajustes de los puntos intermedios de esos dientes ya no tienen a quién seguir
  max.inversas = Object.fromEntries(Object.entries(max.inversas ?? {}).filter(([k]) => !k.split('|').some((id) => borrar.has(id))));
  estado.seleccion = null;
  estado.elegidos = new Set();
  curvas[estado.maxilar] = {};
  pintarPanel(); resolverTodo();
}

function restablecerFeston() {
  if (esInversa(estado.seleccion)) { restablecerInversa(); return; }
  const c = actual()?.controladores.find((k) => k.id === estado.seleccion);
  if (!c?.manijas) return;
  recordar();
  delete c.manijas;
  pintarPanel(); resolverTodo();
}

function quitarClave() {
  const max = actual();
  const c = max?.controladores.find((k) => k.id === estado.seleccion);
  if (!c || !estado.num) return;
  if (!c.claves[estado.num]) { avisar('Ese punto no tiene keyframe en este movimiento.'); return; }
  if (Object.keys(c.claves).filter((k) => movimientos(estado.maxilar).some((m) => m.num === k)).length <= 1) {
    avisar('Es el único keyframe del punto: para sacarlo, borrá el punto.', true);
    return;
  }
  recordar();
  delete c.claves[estado.num];
  pintarPanel(); resolverTodo();
}

window.addEventListener('keydown', (ev) => {
  const ctrl = ev.ctrlKey || ev.metaKey, tecla = ev.key.toLowerCase();
  if (asistente.open) { if (ctrl && tecla === 's') ev.preventDefault(); return; }
  if (ctrl && tecla === 's') { ev.preventDefault(); guardar(ev.shiftKey); return; }
  if (/** @type {HTMLElement} */ (ev.target).matches('input, select, textarea')) return;
  if (ctrl && (tecla === 'z' || tecla === 'y')) {
    ev.preventDefault();
    if (tecla === 'y' || ev.shiftKey) rehacer(); else deshacer();
    return;
  }
  if (ctrl) return;
  const nums = estado.maxilar ? movimientos(estado.maxilar).map((m) => m.num) : [];
  const i = nums.indexOf(estado.num ?? '');
  if (ev.key === 'ArrowRight' && i >= 0 && i < nums.length - 1) irA(nums[i + 1]);
  else if (ev.key === 'ArrowLeft' && i > 0) irA(nums[i - 1]);
  else if (ev.key === 'Delete' || ev.key === 'Backspace') borrarPunto();
  else if (ev.key === 'k' || ev.key === 'K') quitarClave();
  else if (ev.key === '1') elegirModo('v');
  else if (ev.key === '2') elegirModo('l');
  else if (ev.key === '3') elegirModo('e');
  else if (ev.key === 'Escape') { if (!menuMov.hidden) cerrarMenuMov(); else { estado.modo = null; pintarPanel(); } }
  else return;
  ev.preventDefault();
});

/** Los modos son interruptores: elegir el que ya está prendido lo apaga. */
function elegirModo(modo) { estado.modo = estado.modo === modo ? null : modo; pintarPanel(); }

// ---------- el HUD ----------
function pintarHud() {
  const max = actual();
  if (!max || !estado.maxilar) { hud.definir(null); pintarProyecto(); return; }
  const nums = movimientos(estado.maxilar).map((m) => m.num);
  const claves = new Set(max.controladores.flatMap((c) => Object.keys(c.claves)));
  const sel = max.controladores.find((c) => c.id === estado.seleccion);
  // los movimientos que van sin offset (o) o sin festoneado (f)
  const marcas = Object.fromEntries(nums.map((n) => {
    const s = sinAjusteDe(estado.maxilar, n);
    return [n, `${s.offset === false ? 'o' : ''}${s.festoneado === false ? 'f' : ''}`];
  }).filter(([, m]) => m));
  const aca = sinAjusteDe(estado.maxilar, estado.num);
  const sinAca = [aca.offset === false && 'offset', aca.festoneado === false && 'festoneado'].filter(Boolean);
  const apagado = (id) => (id === 'offset' && aca.offset === false) || (id === 'amplitud' && aca.festoneado === false);
  hud.definir({
    linea: {
      titulo: `${MAXILARES[estado.maxilar]} · movimiento ${estado.num}${estado.num === nums[0] ? ' (base)' : ''}${sinAca.length ? ` · sin ${sinAca.join(' ni ')}` : ''}`,
      nums, actual: estado.num, claves, clavesSel: new Set(sel ? Object.keys(sel.claves) : []), marcas,
    },
    deslizadores: max.lingual
      ? [...DESLIZADORES.map((d) => ({ ...d, titulo: `${d.titulo} V`, valor: max[d.id], fila: 1, apagado: apagado(d.id) })),
         ...DESLIZADORES.map((d) => ({ ...d, id: `l.${d.id}`, titulo: `${d.titulo} L`, valor: max.lingual[d.id] ?? max[d.id], fila: 0, apagado: apagado(d.id) }))]
      : DESLIZADORES.map((d) => ({ ...d, valor: max[d.id], apagado: apagado(d.id) })),
    botones: [{
      id: 'candado', texto: max.lingual ? '🔓' : '🔒', activo: !max.lingual,
      leyenda: max.lingual ? 'V ≠ L' : 'V = L',
    }],
  });
  pintarProyecto();
}

// ---------- el panel ----------
function pintarPanel() {
  const cuerpo = /** @type {HTMLElement} */ (document.querySelector('#tabla tbody'));
  cuerpo.replaceChildren(...estado.archivos.map((a, i) => {
    const tr = document.createElement('tr');
    tr.className = [a.usar ? '' : 'sin', a.usar && a.maxilar && base(a.maxilar) === a.mov ? 'base' : ''].join(' ').trim();
    tr.innerHTML = `<td><input type="checkbox" data-i="${i}" data-campo="usar" ${a.usar ? 'checked' : ''}></td>
      <td class="nombre"></td>
      <td><select data-i="${i}" data-campo="maxilar"><option value="">?</option>${Object.entries(MAXILARES).map(([k, t]) => `<option value="${k}" ${a.maxilar === k ? 'selected' : ''}>${t.slice(0, 3)}</option>`).join('')}</select></td>
      <td><input type="text" data-i="${i}" data-campo="mov" value="${a.mov}" maxlength="3"></td>
      ${['offset', 'festoneado'].map((campo) => {
        const sin = a.maxilar && a.mov ? sinAjusteDe(a.maxilar, a.mov)[campo] === false : false;
        return `<td class="aj"><input type="checkbox" data-i="${i}" data-campo="aj-${campo}" ${sin ? '' : 'checked'} ${a.usar && a.maxilar && a.mov ? '' : 'disabled'}></td>`;
      }).join('')}`;
    const nombre = /** @type {HTMLElement} */ (tr.querySelector('.nombre'));
    nombre.textContent = a.nombre; nombre.title = a.nombre;
    return tr;
  }));

  $('maxilares').replaceChildren(...Object.entries(MAXILARES).filter(([k]) => movimientos(k).length).map(([k, titulo]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = `${titulo} (${movimientos(k).length} mov.)`;
    b.classList.toggle('activo', k === estado.maxilar);
    b.addEventListener('click', () => elegirMaxilar(k));
    return b;
  }));

  for (const b of document.querySelectorAll('#modos button')) b.classList.toggle('activo', /** @type {HTMLElement} */ (b).dataset.modo === estado.modo);
  const max = actual();
  const cuenta = (t) => max?.controladores.filter((c) => c.tipo === t).length ?? 0;
  $('cuenta').textContent = max
    ? `Vestibulares ${cuenta('v')} · linguales ${cuenta('l')} · extremos ${cuenta('e')}/2. ${estado.modo ? `Marcando: ${MODOS[estado.modo]}.` : 'Sin marcar: prendé un modo para agregar puntos.'}`
    : 'Cargá los modelos para empezar.';
  /** @type {HTMLButtonElement} */ ($('borrar-punto')).disabled = !estado.seleccion;
  const sel = max?.controladores.find((c) => c.id === estado.seleccion);
  /** @type {HTMLButtonElement} */ ($('borrar-clave')).disabled = !(sel && estado.num && sel.claves[estado.num] && estado.num !== base(estado.maxilar));
  const inversa = esInversa(estado.seleccion) ? max?.inversas?.[estado.seleccion.slice(2)] : null;
  /** @type {HTMLButtonElement} */ ($('restablecer')).disabled = !(sel?.manijas || inversa);
  // las casillas muestran a los elegidos: tildada si todos siguen, a medias si algunos
  const elegidos = max?.controladores.filter((c) => estado.elegidos.has(c.id)) ?? [];
  for (const campo of ['offset', 'festoneado']) {
    const caja = /** @type {HTMLInputElement} */ ($(`usa-${campo}`));
    const siguen = elegidos.filter((c) => c[campo] !== false).length;
    caja.disabled = !elegidos.length;
    caja.checked = elegidos.length > 0 && siguen === elegidos.length;
    caja.indeterminate = siguen > 0 && siguen < elegidos.length;
  }
  $('sin-modelos').hidden = estado.archivos.length > 0;
  $('faltantes').hidden = !pendientes.length;
  $('faltan-texto').textContent = pendientes.length
    ? `Faltan ${pendientes.length} modelos (no estaban en su ruta): ${pendientes.map((p) => p.nombre).join(', ')}.` : '';
  pintarReferencias();
  pintarHud();
}

function pintarReferencias() {
  $('referencias').replaceChildren(...Object.keys(referencias).sort().map((clave) => {
    const li = document.createElement('li');
    const [maxilar, mov] = clave.split('|'), sep = separacion(clave);
    li.textContent = `${MAXILARES[maxilar] ?? maxilar} ${mov}: ${sep ? `separación media ${sep.media.toFixed(2)} mm, máxima ${sep.max.toFixed(2)} mm` : 'todavía sin curva para comparar'}`;
    return li;
  }));
  /** @type {HTMLButtonElement} */ ($('quitar-referencias')).disabled = !Object.keys(referencias).length;
}

$('tabla').addEventListener('change', (ev) => {
  const el = /** @type {HTMLInputElement} */ (ev.target);
  const a = estado.archivos[Number(el.dataset.i)];
  if (!a) return;
  if (el.dataset.campo?.startsWith('aj-')) {
    if (a.maxilar && a.mov) ponerAjuste(a.maxilar, [a.mov], el.dataset.campo.slice(3), el.checked);
    return;
  }
  if (el.dataset.campo === 'usar') a.usar = el.checked;
  else if (el.dataset.campo === 'maxilar') a.maxilar = el.value || null;
  else if (el.dataset.campo === 'mov') a.mov = el.value.trim() === '' ? '' : el.value.trim().padStart(2, '0');
  curvas.sup = {}; curvas.inf = {};
  alCambiarArchivos();
});

for (const b of document.querySelectorAll('#modos button')) b.addEventListener('click', () => elegirModo(/** @type {HTMLElement} */ (b).dataset.modo));
$('borrar-punto').addEventListener('click', borrarPunto);
$('borrar-clave').addEventListener('click', quitarClave);
$('restablecer').addEventListener('click', restablecerFeston);
for (const campo of ['offset', 'festoneado']) {
  $(`usa-${campo}`).addEventListener('change', (ev) => {
    const sigue = /** @type {HTMLInputElement} */ (ev.target).checked;
    recordar();
    for (const c of actual()?.controladores ?? []) {
      if (!estado.elegidos.has(c.id)) continue;
      if (sigue) delete c[campo]; else c[campo] = false;
    }
    pintarPanel(); resolverTodo();
  });
}

// ---------- el panel: un paso por vez, con pestañas y anterior / siguiente ----------
const guardado = (clave, valor) => {
  try { if (valor === undefined) return localStorage.getItem(clave); localStorage.setItem(clave, valor); } catch { /* sin almacenamiento */ }
  return null;
};
const pasos = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('#pasos section')]);
const pestanas = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('#pestanas button')]);
function irAPaso(nombre) {
  const i = Math.max(0, pasos.findIndex((p) => p.dataset.paso === nombre));
  pasos.forEach((p, k) => { p.hidden = k !== i; });
  pestanas.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.paso === pasos[i].dataset.paso)));
  pestanas.find((b) => b.dataset.paso === pasos[i].dataset.paso)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  /** @type {HTMLButtonElement} */ ($('anterior')).disabled = i === 0;
  /** @type {HTMLButtonElement} */ ($('siguiente')).disabled = i === pasos.length - 1;
  $('paso-actual').textContent = `${i + 1} de ${pasos.length} · ${pasos[i].dataset.titulo}`;
  $('pasos').scrollTop = 0;
  guardado('trimline.paso', pasos[i].dataset.paso);
}
const pasoActual = () => pasos.findIndex((p) => !p.hidden);
for (const b of pestanas) b.addEventListener('click', () => irAPaso(b.dataset.paso));
$('anterior').addEventListener('click', () => irAPaso(pasos[Math.max(0, pasoActual() - 1)].dataset.paso));
$('siguiente').addEventListener('click', () => irAPaso(pasos[Math.min(pasos.length - 1, pasoActual() + 1)].dataset.paso));
irAPaso(guardado('trimline.paso') ?? pasos[0].dataset.paso);

// el ancho del panel se cambia arrastrando el borde, y se puede esconder del todo
const ANCHO_PANEL = [320, 720];
function anchoPanel(px) {
  const w = Math.round(Math.min(ANCHO_PANEL[1], Math.max(ANCHO_PANEL[0], px)));
  document.documentElement.style.setProperty('--panel', `${w}px`);
  return w;
}
anchoPanel(Number(guardado('trimline.panel')) || 340);
const borde = $('borde');
borde.addEventListener('pointerdown', (ev) => {
  borde.setPointerCapture(ev.pointerId);
  borde.classList.add('arrastrando');
});
borde.addEventListener('pointermove', (ev) => {
  if (borde.classList.contains('arrastrando')) anchoPanel(window.innerWidth - ev.clientX);
});
borde.addEventListener('pointerup', (ev) => {
  borde.classList.remove('arrastrando');
  guardado('trimline.panel', String(anchoPanel(window.innerWidth - ev.clientX)));
});
borde.addEventListener('dblclick', () => guardado('trimline.panel', String(anchoPanel(340))));
function verPanel(ver) {
  document.body.classList.toggle('sin-panel', !ver);
  $('mostrar-panel').hidden = ver;
  guardado('trimline.sin-panel', ver ? '0' : '1');
}
$('esconder-panel').addEventListener('click', () => verPanel(false));
$('mostrar-panel').addEventListener('click', () => verPanel(true));
verPanel(guardado('trimline.sin-panel') !== '1');

// la transparencia del modelo, por si la curva queda detrás
const opacidad = /** @type {HTMLInputElement} */ ($('opacidad-modelo'));
function ponerOpacidad(v) {
  opacidad.value = String(v);
  $('opacidad-valor').textContent = `${Math.round(v * 100)}%`;
  visor.opacidad(v);
}
opacidad.addEventListener('input', () => { ponerOpacidad(Number(opacidad.value)); guardado('trimline.opacidad', opacidad.value); });
ponerOpacidad(Number(guardado('trimline.opacidad')) || 1);

$('elegir-referencia').addEventListener('click', () => $('archivo-referencia').click());
$('archivo-referencia').addEventListener('change', (ev) => { const el = /** @type {HTMLInputElement} */ (ev.target); cargarReferencias([...(el.files ?? [])]); el.value = ''; });
$('quitar-referencias').addEventListener('click', () => { referencias = {}; pintarPanel(); mostrar(); });
$('buscar-faltantes').addEventListener('click', buscarFaltantes);
for (const tipo of ['dragenter', 'dragover', 'dragleave']) document.addEventListener(tipo, (ev) => ev.preventDefault());
document.addEventListener('drop', (ev) => {
  ev.preventDefault();
  $('asistente-soltar').classList.remove('encima');
  // con el asistente abierto, lo que se suelta (en cualquier parte) son los modelos del proyecto nuevo
  if (asistente.open) soltarEnAsistente(ev.dataTransfer?.files ?? []);
  else soltarArchivos(ev.dataTransfer?.files ?? []);
});
document.addEventListener('dragover', () => $('asistente-soltar').classList.toggle('encima', asistente.open));
document.addEventListener('dragleave', (ev) => { if (!ev.relatedTarget) $('asistente-soltar').classList.remove('encima'); });

// ---------- exportar, guardar y abrir ----------
/** Descarga común, para los navegadores que no dejan elegir dónde guardar. */
function bajar(nombre, contenido, tipo = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(contenido instanceof Blob ? contenido : new Blob([contenido], { type: tipo }));
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const idCaso = () => /** @type {HTMLInputElement} */ ($('caso')).value.trim() || 'caso';
const elegirDonde = 'showSaveFilePicker' in window;

// Exportar: los .pts para la máquina. Los escribe el servidor en la carpeta elegida: el
// selector del navegador no deja elegir carpetas "del sistema" (Escritorio, Descargas...).
const campoCarpeta = /** @type {HTMLInputElement} */ ($('carpeta'));
try { campoCarpeta.value = localStorage.getItem('trimline.carpeta') ?? ''; } catch { /* sin almacenamiento */ }
function ponerCarpeta(carpeta) {
  campoCarpeta.value = carpeta ?? '';
  campoCarpeta.title = campoCarpeta.value;
  try { localStorage.setItem('trimline.carpeta', campoCarpeta.value); } catch { /* idem */ }
}
campoCarpeta.addEventListener('change', () => ponerCarpeta(campoCarpeta.value.trim()));
ponerCarpeta(campoCarpeta.value);

async function elegirCarpeta() {
  avisar('Elegí la carpeta en la ventana que se abrió…');
  try {
    const { carpeta } = await api.elegirCarpeta(campoCarpeta.value.trim() || null, 'Carpeta donde exportar');
    avisar('');
    if (carpeta) ponerCarpeta(carpeta);
    return carpeta;
  } catch (e) { avisar(e.message, true); return null; }
}
$('elegir-carpeta').addEventListener('click', elegirCarpeta);

$('exportar').addEventListener('click', async () => {
  const carpeta = campoCarpeta.value.trim() || await elegirCarpeta();
  if (!carpeta) return;
  const pedido = {
    id: idCaso(), formato: /** @type {HTMLSelectElement} */ ($('formato')).value,
    n: Number(/** @type {HTMLInputElement} */ ($('puntos')).value) || 300, carpeta,
    maxilares: Object.fromEntries(Object.keys(MAXILARES).filter((m) => movimientos(m).length && estado.maxilares[m].controladores.length).map((m) => [m, paraServidor(m)])),
  };
  try {
    avisar('Exportando…');
    let r;
    try { r = await api.exportar(pedido); } catch (e) {
      if (e.status !== 409) throw e;
      if (!confirm(`${e.message[0].toUpperCase()}${e.message.slice(1)}.\n¿Reemplazarlos?`)) { avisar(''); return; }
      r = await api.exportar({ ...pedido, pisar: true });
    }
    avisar(`Exportado en ${r.carpeta}: ${r.archivos.map((f) => f.nombre).join(', ')}`);
  } catch (e) { avisar(e.message, true); }
});

// Guardar: una foto del trabajo en un .trimline. Las mallas no van: solo la ruta de cada STL.
// La primera vez, Guardar pregunta el nombre y dónde; después vuelve a escribir ese archivo (si
// sigue siendo el mismo caso). Aparte, un respaldo se escribe solo (ver más abajo).
const carpetaDe = (ruta) => ruta?.replace(/[\\/][^\\/]*$/, '') || null;
const enCarpeta = (carpeta, nombre) => `${carpeta}${carpeta.includes('\\') ? '\\' : '/'}${nombre}`;
const hayProyecto = () => estado.archivos.length > 0 || pendientes.length > 0;
/** Lo que cuenta como cambio: el caso, los modelos elegidos y los maxilares (no la vista). */
const firma = () => JSON.stringify({
  id: idCaso(), archivos: estado.archivos.map(({ malla, maxilar, mov, usar }) => [malla, maxilar, mov, usar]), maxilares: estado.maxilares,
});
const hayCambios = () => hayProyecto() && firma() !== firmaGuardada;

function marcarGuardado(ruta, nombre = ruta?.split(/[\\/]/).pop() ?? '') {
  rutaTrabajo = ruta; idTrabajo = idCaso(); nombreTrabajo = nombre;
  firmaGuardada = firma();
  pintarProyecto();
}

/** Abajo del panel: qué proyecto es y si tiene cambios sin guardar. */
function pintarProyecto() {
  const e = $('nombre-proyecto');
  const cambios = hayCambios();
  e.textContent = !hayProyecto() ? 'Sin proyecto'
    : nombreTrabajo ? `${cambios ? '● ' : ''}${nombreTrabajo}` : `${idCaso()} · sin guardar`;
  e.title = [rutaTrabajo ?? nombreTrabajo, cambios ? 'Hay cambios sin guardar' : '', rutaRespaldo ? `Respaldo: ${rutaRespaldo}` : '']
    .filter(Boolean).join('\n');
  e.classList.toggle('cambios', cambios);
  /** @type {HTMLButtonElement} */ ($('guardar')).disabled = !hayProyecto();
  /** @type {HTMLButtonElement} */ ($('guardar-como')).disabled = !hayProyecto();
  $('vacio').hidden = hayProyecto();
  if (hayProyecto() && firma() !== firmaRespaldo) programarRespaldo();
}

/** Antes de cambiar de proyecto: true si se puede seguir (no hay cambios, o se descartan). */
const descartarCambios = (que) => !hayCambios() || confirm(`El proyecto tiene cambios sin guardar. ¿Descartarlos y ${que}?`);

/** Suelta las mallas que ya no usa el proyecto, en el visor y en el servidor. */
function soltarMallasSobrantes(conservar = [...estado.archivos, ...pendientes].map((a) => a.malla)) {
  visor.olvidar(conservar);
  api.olvidarMallas(conservar).catch(() => {});
}

/** Empieza de cero. `conservar`: mallas ya leídas que van a ser del proyecto nuevo. */
function nuevoProyecto(conservar = []) {
  turno++;                                                    // las curvas que estén en camino no sirven
  clearTimeout(esperaRespaldo);
  Object.assign(estado, {
    archivos: [], maxilares: { sup: nuevoMaxilar(), inf: nuevoMaxilar() }, maxilar: null, num: null, seleccion: null, elegidos: new Set(),
  });
  curvas.sup = {}; curvas.inf = {};
  pendientes = []; referencias = {};
  /** @type {HTMLInputElement} */ ($('caso')).value = '';
  rutaTrabajo = null; idTrabajo = ''; nombreTrabajo = ''; firmaGuardada = '';
  rutaRespaldo = null; firmaRespaldo = ''; claveRespaldo = '';
  olvidarHistorial();
  soltarMallasSobrantes(conservar);
  mostrar(); pintarPanel();
}

// ---------- el respaldo ----------
// <ID>.trimline.bak en la carpeta de los modelos: se escribe solo al crear el proyecto y un
// momento después de cada cambio. No es guardar: el proyecto sigue "sin guardar" hasta que se
// usa Guardar. Si algo se cierra mal, el .bak se puede abrir con Abrir…
function programarRespaldo() {
  clearTimeout(esperaRespaldo);
  esperaRespaldo = setTimeout(respaldar, 2000);
}
async function respaldar() {
  clearTimeout(esperaRespaldo);
  if (!hayProyecto()) return;
  // sin ningún modelo con carpeta conocida (se arrastraron), lo ubica el servidor en sus datos
  const carpeta = carpetaDe(estado.archivos.find((a) => a.ruta)?.ruta);
  const nombre = `${idCaso()}.trimline.bak`, ruta = carpeta ? enCarpeta(carpeta, nombre) : null, ahora = firma();
  if (ahora === firmaRespaldo && (ruta ?? nombre) === claveRespaldo) return;
  try {
    const r = await api.guardarEn({ trabajo: datosTrabajo(), ruta, nombre, respaldo: true });
    rutaRespaldo = r.ruta; claveRespaldo = ruta ?? nombre; firmaRespaldo = ahora;
    pintarProyecto();
  } catch (e) { avisar(`No se pudo escribir el respaldo ${ruta ?? nombre}: ${e.message}`, true); }
}

// ---------- el asistente de proyecto nuevo ----------
// Se eligen las carpetas con los modelos, se tildan los que usa el caso y se crea el proyecto
// solo con esos. El servidor los lee del disco: cada uno queda con su ruta completa.
const asistente = /** @type {HTMLDialogElement} */ ($('asistente'));
/** Lo que se leyó de las carpetas: resumen de la malla + { maxilar, mov, usar }. */
let propuestos = /** @type {any[]} */ ([]);
let carpetasElegidas = /** @type {string[]} */ ([]);
/** Mientras se lee una carpeta: cuántos hay, cuántos van y cuál se está leyendo. */
let leyendo = /** @type {{ total: number, hechos: number, nombre: string } | null} */ (null);
/** Cada vez que se abre el asistente: una lectura de antes que siga en camino se descarta. */
let vezAsistente = 0;
const NOTA_ASISTENTE = $('asistente-nota').textContent;
const campoCasoNuevo = /** @type {HTMLInputElement} */ ($('asistente-caso'));

function notaAsistente(texto = NOTA_ASISTENTE, error = false) {
  $('asistente-nota').textContent = texto;
  $('asistente-nota').classList.toggle('error', error);
}

function abrirAsistente() {
  if (!descartarCambios('empezar un proyecto nuevo')) return;
  propuestos = []; carpetasElegidas = []; leyendo = null; vezAsistente++;
  campoCasoNuevo.value = '';
  notaAsistente();
  pintarAsistente();
  asistente.showModal();
}

async function elegirCarpetaAsistente() {
  const inicial = carpetaDe(carpetasElegidas.at(-1) ? `${carpetasElegidas.at(-1)}/x` : estado.archivos.find((a) => a.ruta)?.ruta);
  try {
    const { carpeta } = await api.elegirCarpeta(inicial, 'Carpeta con los modelos del caso');
    if (!carpeta) return;
    const vez = vezAsistente;
    const lista = await api.modelosDeCarpeta(carpeta);
    if (!carpetasElegidas.includes(carpeta)) carpetasElegidas.push(carpeta);
    // un servidor de antes no sabe listar: ya leyó toda la carpeta
    const nombres = Array.isArray(lista.nombres) ? lista.nombres : (lista.mallas ?? []).map((m) => m.nombre);
    const leer = Array.isArray(lista.nombres) ? (nombre) => api.mallasDeCarpeta(carpeta, [nombre])
      : (nombre) => ({ mallas: lista.mallas.filter((m) => m.nombre === nombre), errores: [] });
    await leerModelos(nombres, nombres, leer, vez);
    if (!nombres.length) notaAsistente(`No hay modelos (.stl, .ply, .obj) en ${carpeta}.`, true);
  } catch (e) { notaAsistente(e.message, true); leyendo = null; pintarAsistente(); }
}

/** Los arrastrados (o elegidos con el selector del navegador): se suben y quedan sin ruta. */
async function soltarEnAsistente(lista) {
  const archivos = [...lista].filter((a) => /\.(stl|ply|obj)$/i.test(a.name));
  if (!archivos.length) { notaAsistente('Ahí no hay modelos (.stl, .ply, .obj).', true); return; }
  if (leyendo) return;
  const subir = async (archivo) => {
    try { return { mallas: [await api.subirMalla(archivo)], errores: [] }; } catch (e) { return { mallas: [], errores: [`${archivo.name}: ${e.message}`] }; }
  };
  await leerModelos(archivos, archivos.map((a) => a.name), subir, vezAsistente);
}

/**
 * Lee los modelos de a uno, para mostrar cuál se está leyendo (un STL grande tarda unos
 * segundos), y los suma a la lista del asistente.
 */
async function leerModelos(items, nombres, leer, vez) {
  const errores = [];
  leyendo = { total: items.length, hechos: 0, nombre: '' };
  for (const [i, item] of items.entries()) {
    if (!asistente.open || vez !== vezAsistente) return;     // se canceló mientras leía
    leyendo.nombre = nombres[i];
    pintarAsistente();
    const r = await leer(item);
    if (vez !== vezAsistente) return;
    errores.push(...r.errores);
    for (const m of r.mallas) {
      const nombre = m.nombre ?? nombres[i];
      if (propuestos.some((p) => (m.ruta ? p.ruta === m.ruta : p.id === m.id && p.nombre === nombre))) continue;
      const maxilar = m.archivo.maxilar ?? null, mov = m.archivo.movimiento ?? '';
      propuestos.push({ ...m, nombre, maxilar, mov, usar: !!(maxilar && mov) });
    }
    leyendo.hechos++;
  }
  propuestos.sort((a, b) => (a.maxilar ?? 'z').localeCompare(b.maxilar ?? 'z') || a.mov.localeCompare(b.mov, undefined, { numeric: true }) || a.nombre.localeCompare(b.nombre));
  if (!campoCasoNuevo.value) campoCasoNuevo.value = propuestos.find((p) => p.archivo.id)?.archivo.id ?? '';
  notaAsistente(...(errores.length ? [`No se pudieron leer: ${errores.join('; ')}`, true] : []));
  leyendo = null;
  pintarAsistente();
}

function pintarAsistente() {
  $('asistente-carpetas').replaceChildren(...carpetasElegidas.map((c) => Object.assign(document.createElement('li'), { textContent: c })));
  $('asistente-carpeta').textContent = carpetasElegidas.length ? 'Sumar otra carpeta…' : 'Elegir carpeta…';
  // mientras lee: la barra y el archivo que está leyendo; solo se puede cancelar
  const progreso = $('asistente-progreso');
  progreso.hidden = !leyendo;
  if (leyendo) {
    const barra = /** @type {HTMLProgressElement} */ (progreso.querySelector('progress'));
    barra.max = leyendo.total || 1; barra.value = leyendo.hechos;
    /** @type {HTMLElement} */ (progreso.querySelector('span')).textContent = `Leyendo ${leyendo.hechos + 1} de ${leyendo.total}: ${leyendo.nombre}`;
  }
  /** @type {HTMLButtonElement} */ ($('asistente-carpeta')).disabled = !!leyendo;
  $('asistente-soltar').classList.toggle('apagado', !!leyendo);
  /** @type {HTMLButtonElement} */ ($('asistente-quitar')).disabled = !propuestos.length || !!leyendo;
  $('asistente-lista').hidden = !propuestos.length;
  const cuerpo = /** @type {HTMLElement} */ (document.querySelector('#asistente-tabla tbody'));
  cuerpo.replaceChildren(...propuestos.map((a, i) => {
    const tr = document.createElement('tr');
    tr.className = a.usar ? '' : 'sin';
    tr.innerHTML = `<td><input type="checkbox" data-i="${i}" data-campo="usar" ${a.usar ? 'checked' : ''}></td>
      <td class="nombre"></td>
      <td><select data-i="${i}" data-campo="maxilar"><option value="">?</option>${Object.entries(MAXILARES).map(([k, t]) => `<option value="${k}" ${a.maxilar === k ? 'selected' : ''}>${t.slice(0, 3)}</option>`).join('')}</select></td>
      <td><input type="text" data-i="${i}" data-campo="mov" value="${a.mov}" maxlength="3"></td>`;
    const nombre = /** @type {HTMLElement} */ (tr.querySelector('.nombre'));
    nombre.textContent = a.nombre;
    nombre.title = a.ruta ?? `${a.nombre}: se arrastró, no se sabe su carpeta`;
    if (!a.ruta) nombre.append(Object.assign(document.createElement('span'), { className: 'sin-ruta', textContent: 'sin ruta' }));
    return tr;
  }));
  const usados = propuestos.filter((p) => p.usar);
  const ok = /** @type {HTMLButtonElement} */ ($('asistente-ok'));
  ok.disabled = !usados.some((p) => p.maxilar && p.mov) || !!leyendo;
  ok.textContent = usados.length ? `Crear proyecto (${usados.length} modelos)` : 'Crear proyecto';
}

$('asistente-tabla').addEventListener('change', (ev) => {
  const el = /** @type {HTMLInputElement} */ (ev.target);
  const a = propuestos[Number(el.dataset.i)];
  if (!a) return;
  if (el.dataset.campo === 'usar') a.usar = el.checked;
  else if (el.dataset.campo === 'maxilar') a.maxilar = el.value || null;
  else if (el.dataset.campo === 'mov') a.mov = el.value.trim() === '' ? '' : el.value.trim().padStart(2, '0');
  pintarAsistente();
});
$('asistente-carpeta').addEventListener('click', elegirCarpetaAsistente);
$('asistente-soltar').addEventListener('click', () => $('asistente-archivos').click());
$('asistente-soltar').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); $('asistente-archivos').click(); } });
$('asistente-archivos').addEventListener('change', (ev) => { const el = /** @type {HTMLInputElement} */ (ev.target); soltarEnAsistente([...(el.files ?? [])]); el.value = ''; });
campoCasoNuevo.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ev.preventDefault(); });
$('asistente-quitar').addEventListener('click', () => {
  propuestos = []; carpetasElegidas = [];
  soltarMallasSobrantes();
  notaAsistente(); pintarAsistente();
});
asistente.addEventListener('close', () => {
  if (asistente.returnValue === 'ok') crearProyecto();
  else soltarMallasSobrantes();                               // las que se leyeron y no se usaron
  asistente.returnValue = '';
});

/** Arma el proyecto con los modelos tildados y escribe el primer respaldo. */
async function crearProyecto() {
  const usados = propuestos.filter((p) => p.usar);
  const caso = campoCasoNuevo.value.trim();
  propuestos = []; carpetasElegidas = [];
  nuevoProyecto(usados.map((p) => p.id));
  /** @type {HTMLInputElement} */ ($('caso')).value = caso;
  mostrarCarga(`Creando el proyecto ${caso}`.trim());
  let hechos = 0;
  for (const p of usados) {
    progresoCarga(`Preparando ${++hechos} de ${usados.length}: ${p.nombre}`, hechos - 1, usados.length);
    try {
      if (!visor.tiene(p.id)) visor.registrar(p.id, await api.bajarMalla(p.id));
    } catch (e) { avisar(e.message, true); continue; }
    estado.archivos.push({ malla: p.id, nombre: p.nombre, arriba: p.arriba, ruta: p.ruta, maxilar: p.maxilar, mov: p.mov, usar: true });
  }
  cerrarCarga();
  finCarga();
  irAPaso('puntos');
  await respaldar();
  avisar(rutaRespaldo ? `Proyecto creado. Respaldo en ${rutaRespaldo}; Guardar (abajo) para elegir nombre y lugar.` : 'Proyecto creado.');
}

$('nuevo').addEventListener('click', abrirAsistente);
$('vacio-nuevo').addEventListener('click', abrirAsistente);

function datosTrabajo() {
  return {
    id: idCaso(),
    // los que no se encontraron al abrir también: así no se pierde dónde estaban
    archivos: [...estado.archivos, ...pendientes].map(({ malla, nombre, maxilar, mov, usar, ruta }) => ({ malla, nombre, maxilar, mov, usar, ruta })),
    maxilares: estado.maxilares,
    vista: { maxilar: estado.maxilar, num: estado.num, modo: estado.modo },
    exportar: { formato: /** @type {HTMLSelectElement} */ ($('formato')).value, n: Number(/** @type {HTMLInputElement} */ ($('puntos')).value) || 300, carpeta: campoCarpeta.value.trim() },
  };
}

function avisarGuardado(nombre, sinRuta) {
  avisar(sinRuta
    ? `Guardado: ${nombre}. De ${sinRuta} modelos no se sabe la carpeta: al abrirlo se buscan junto al .trimline.`
    : `Guardado: ${nombre}`);
}

async function guardar(como = false) {
  if (!hayProyecto()) { avisar('No hay nada para guardar: cargá los modelos.'); return; }
  try {
    avisar('Guardando…');
    const inicial = carpetaDe(rutaTrabajo) ?? carpetaDe(estado.archivos.find((a) => a.ruta)?.ruta) ?? (campoCarpeta.value.trim() || null);
    const mismo = !como && rutaTrabajo && idTrabajo === idCaso();
    const r = await api.guardarEn({ trabajo: datosTrabajo(), ruta: mismo ? rutaTrabajo : null, inicial, nombre: `${idCaso()}.trimline` });
    if (!r.ruta) { avisar(''); return; }
    // los arrastrados que se encontraron junto al .trimline ya tienen ruta (y el respaldo, carpeta)
    for (const x of estado.archivos) x.ruta ??= r.rutas?.[x.malla];
    marcarGuardado(r.ruta);
    avisarGuardado(r.ruta, r.sin_ruta.length);
  } catch (e) {
    if (e.status === 501) await guardarConElNavegador();
    else avisar(`No se pudo guardar: ${e.message}`, true);
  }
}

/** Sin diálogos en el sistema: el selector del navegador (o una descarga). */
async function guardarConElNavegador() {
  let destino = null;
  if (elegirDonde) {
    try {
      destino = await /** @type {any} */ (window).showSaveFilePicker({
        id: 'trabajo', suggestedName: `${idCaso()}.trimline`,
        types: [{ description: 'Trabajo de línea de recorte', accept: { 'application/json': ['.trimline'] } }],
      });
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  try {
    const { blob, sinRuta } = await api.guardarTrabajo(datosTrabajo());
    if (destino) {
      const w = await destino.createWritable();
      await w.write(blob); await w.close();
    } else bajar(`${idCaso()}.trimline`, blob);
    marcarGuardado(null, destino?.name ?? `${idCaso()}.trimline`);
    avisarGuardado(destino?.name ?? `${idCaso()}.trimline`, sinRuta);
  } catch (e) { avisar(`No se pudo guardar: ${e.message}`, true); }
}

$('guardar').addEventListener('click', () => guardar());
$('guardar-como').addEventListener('click', () => guardar(true));

/** Un trabajo viejo (.trimline.json): trae los puntos, pero las mallas hay que arrastrarlas. */
function abrirJson(t) {
  if (t.formato !== 'aligner-trimline') throw new Error('no es un trabajo de aligner-trimline');
  estado.maxilares = { sup: { ...nuevoMaxilar(), ...t.maxilares?.sup }, inf: { ...nuevoMaxilar(), ...t.maxilares?.inf } };
  pendientes = t.archivos ?? [];
  /** @type {HTMLInputElement} */ ($('caso')).value = t.id ?? '';
  for (const a of estado.archivos) {
    const p = pendientes.find((q) => q.nombre === a.nombre);
    if (p) Object.assign(a, { maxilar: p.maxilar, mov: p.mov, usar: p.usar });
  }
  curvas.sup = {}; curvas.inf = {};
  alCambiarArchivos();
  const faltan = pendientes.filter((p) => !estado.archivos.some((a) => a.nombre === p.nombre)).length;
  avisar(faltan ? `Trabajo abierto. Faltan ${faltan} modelos: buscalos en Modelos.` : 'Trabajo abierto.');
}

/** Un .trimline: queda todo como estaba al guardarlo. Los modelos se leen de donde estaban. */
async function abrirTrabajo(archivo) {
  mostrarCarga(`Abriendo ${archivo.name}`);
  progresoCarga('Leyendo los modelos…');
  try { await aplicarTrabajo(await api.abrirTrabajo(archivo), archivo.name); } finally { cerrarCarga(); }
  marcarGuardado(null, archivo.name);
  firmaRespaldo = firma();
}

async function aplicarTrabajo({ trabajo: t, mallas, faltan }, nombre) {
  const arriba = Object.fromEntries(mallas.map((m) => [m.id, m.arriba]));
  let hechas = 0;
  for (const id of Object.keys(arriba)) {
    progresoCarga(`Preparando la vista: ${++hechas} de ${mallas.length}`, hechas - 1, mallas.length);
    if (!visor.tiene(id)) visor.registrar(id, await api.bajarMalla(id));
  }
  const rutas = Object.fromEntries(mallas.map((m) => [m.id, m.ruta]));
  estado.archivos = (t.archivos ?? []).map((a) => ({ ...a, arriba: arriba[a.malla] ?? [0, 0, 1], ruta: rutas[a.malla] ?? a.ruta }));
  estado.maxilares = { sup: { ...nuevoMaxilar(), ...t.maxilares?.sup }, inf: { ...nuevoMaxilar(), ...t.maxilares?.inf } };
  pendientes = faltan ?? [];
  /** @type {HTMLInputElement} */ ($('caso')).value = t.id ?? '';
  if (t.exportar?.n) /** @type {HTMLInputElement} */ ($('puntos')).value = String(t.exportar.n);
  if (t.exportar?.carpeta) ponerCarpeta(t.exportar.carpeta);
  if (t.exportar?.formato && [...$('formato').querySelectorAll('option')].some((o) => o.value === t.exportar.formato)) {
    /** @type {HTMLSelectElement} */ ($('formato')).value = t.exportar.formato;
  }
  if (t.vista && 'modo' in t.vista) estado.modo = t.vista.modo;
  curvas.sup = {}; curvas.inf = {};
  referencias = {};
  estado.maxilar = null;
  soltarMallasSobrantes();                                    // las del proyecto anterior
  alCambiarArchivos();
  if (t.vista?.maxilar && movimientos(t.vista.maxilar).length) {
    if (t.vista.maxilar !== estado.maxilar) elegirMaxilar(t.vista.maxilar, true);
    irA(movimientos(t.vista.maxilar).some((m) => m.num === t.vista.num) ? t.vista.num : base(t.vista.maxilar));
  }
  if (pendientes.length) {
    const donde = [...new Set(pendientes.map((p) => p.ruta?.replace(/[\\/][^\\/]*$/, '')).filter(Boolean))];
    avisar(`Trabajo abierto, pero faltan ${pendientes.length} modelos${donde.length ? ` (no están en ${donde.join(', ')})` : ''}: buscalos en Modelos → «Buscar en otra carpeta…».`, true);
  } else avisar(`Trabajo abierto: ${nombre}`);
}

/** Abre un .trimline del disco; sin `ruta`, con el diálogo del sistema. */
async function abrirRuta(ruta = null, preguntar = true) {
  if (preguntar && !descartarCambios('abrir otro')) return;
  try {
    const lista = await api.abrirDe({ ruta, inicial: carpetaDe(rutaTrabajo) ?? carpetaDe(estado.archivos.find((a) => a.ruta)?.ruta), listar: true });
    if (!lista.ruta) return;
    // de a uno, para mostrar cuál se está leyendo; al final se abre todo junto (ya leído)
    mostrarCarga(`Abriendo ${lista.ruta.split(/[\\/]/).pop()}`);
    let r = lista;
    // un servidor de antes no sabe listar: ya contestó con todo abierto
    if (Array.isArray(lista.nombres)) {
      const total = lista.nombres.length;
      for (const [i, nombre] of lista.nombres.entries()) {
        progresoCarga(`Leyendo ${i + 1} de ${total}: ${nombre}`, i, total);
        await api.abrirDe({ ruta: lista.ruta, solo: i });
      }
      progresoCarga('Armando el proyecto…');
      r = await api.abrirDe({ ruta: lista.ruta });
    }
    await aplicarTrabajo(r, r.ruta);
    if (/\.bak$/i.test(r.ruta)) {
      marcarGuardado(null, '');
      firmaGuardada = '';                                     // un respaldo no es el proyecto guardado
      rutaRespaldo = r.ruta; claveRespaldo = r.ruta;
    } else marcarGuardado(r.ruta);
    firmaRespaldo = firma();
    olvidarHistorial();
    pintarProyecto();
  } catch (e) {
    if (e.status === 501 && !ruta) $('trabajo').click();     // sin diálogos: el del navegador
    else avisar(`No se pudo abrir: ${e.message}`, true);
  } finally { cerrarCarga(); }
}
$('abrir').addEventListener('click', () => abrirRuta());
$('vacio-abrir').addEventListener('click', () => abrirRuta());
$('trabajo').addEventListener('change', async (ev) => {
  const el = /** @type {HTMLInputElement} */ (ev.target);
  const archivo = el.files?.[0];
  el.value = '';
  if (!archivo || !descartarCambios('abrir otro')) return;
  try {
    if (/\.curva$/i.test(archivo.name)) throw new Error('ese .curva son los datos del caso que salen al exportar; el trabajo se guarda en un .trimline');
    if (/\.json$/i.test(archivo.name)) abrirJson(JSON.parse(await archivo.text()));
    else await abrirTrabajo(archivo);
    olvidarHistorial();
  } catch (e) { avisar(`No se pudo abrir: ${e.message}`, true); }
});

$('salir').addEventListener('click', async () => {
  if (!confirm('¿Cerrar el programa? Lo que no guardaste se pierde.')) return;
  await api.cerrar().catch(() => {});
  document.body.innerHTML = '<p style="padding:20px">El programa se cerró. Ya podés cerrar esta pestaña.</p>';
});

// ---------- actualizaciones ----------
async function pintarVersion(buscar = false) {
  const lista = $('versiones');
  try {
    const a = await api.actualizacion(buscar);
    $('version').textContent = a.instalada
      ? `Versión instalada: ${a.tag ?? a.version}.`
      : `Versión ${a.version} (copia de desarrollo: se actualiza con git).`;
    if (a.ultimo && !a.ultimo.ok) {
      $('version').textContent += ` El último cambio de versión (${a.ultimo.cuando?.replace('T', ' ')}) no se pudo hacer: ${a.ultimo.error}. Si vuelve a pasar, instalá con el instalador (.exe).`;
    }
    const volver = /** @type {HTMLButtonElement} */ ($('volver-version'));
    volver.hidden = !a.anterior;
    volver.textContent = `Volver a ${a.anterior ?? 'la anterior'}`;
    if (!buscar) return;
    if (a.error) { lista.textContent = a.error; return; }
    if (!a.releases.length) { lista.textContent = 'Todavía no hay versiones publicadas.'; return; }
    lista.replaceChildren(...a.releases.slice(0, 6).map((r) => {
      const fila = document.createElement('div');
      fila.className = 'fila';
      const texto = document.createElement('span');
      texto.textContent = `${r.tag} · ${r.fecha}${r.prerelease ? ' · prueba' : ''}`;
      texto.title = r.notas;
      const boton = document.createElement('button');
      boton.type = 'button';
      boton.textContent = r.tag === a.tag ? 'Instalada' : 'Instalar';
      boton.disabled = r.tag === a.tag || !a.instalada;
      boton.addEventListener('click', () => cambiarVersion(() => api.instalarVersion(r.tag), `¿Instalar ${r.tag}? El programa se reinicia; guardá el trabajo antes.`));
      fila.append(texto, boton);
      return fila;
    }));
  } catch (e) { lista.textContent = e.message; }
}

async function cambiarVersion(accion, pregunta) {
  if (!confirm(pregunta)) return;
  try {
    avisar('Instalando…');
    const cual = async () => { const a = await api.actualizacion(); return `${a.version}|${a.tag}`; };
    const antes = await cual();
    await accion();
    // el servidor se reinicia: recargar recién cuando responde la versión nueva (si se recarga
    // antes, puede contestar todavía el proceso viejo y la página queda con el código de antes)
    avisar('Reiniciando con la versión nueva…');
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try { if ((await cual()) !== antes) { location.reload(); return; } } catch { /* reiniciando */ }
    }
    avisar('El programa no terminó de reiniciarse: cerralo desde el ícono de la bandeja (abajo a la derecha) y abrilo de nuevo.', true);
    return;
  } catch (e) { avisar(e.message, true); }
}
$('buscar-version').addEventListener('click', () => pintarVersion(true));
$('volver-version').addEventListener('click', () => cambiarVersion(api.revertirVersion, '¿Volver a la versión anterior? El programa se reinicia.'));
pintarVersion();

// ---------- arranque ----------
api.exportadores().then(({ exportadores }) => {
  $('formato').replaceChildren(...exportadores.map((e) => new Option(e.titulo, e.clave)));
}).catch((e) => avisar(e.message, true));
setInterval(api.latido, 5000);
api.latido();
// si el código del servidor cambió desde que arrancó (se actualizó con el programa abierto), avisar
async function revisarServidor() {
  try { $('aviso-reinicio').hidden = !(await api.version()).reiniciar; } catch { /* se está reiniciando */ }
}
revisarServidor();
setInterval(revisarServidor, 20000);
window.addEventListener('focus', revisarServidor);
pintarPanel();
// para probar y depurar desde la consola
Object.assign(window, { trimline: { estado, curvas, visor, hud, irA, elegirMaxilar, movimientos } });
