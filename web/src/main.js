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

const nuevoMaxilar = () => ({ offset: 0, amplitud: 0, ancho: 0.4, controladores: [] });
const estado = {
  /** @type {{ malla: string, nombre: string, maxilar: string | null, mov: string, usar: boolean, arriba: number[] }[]} */
  archivos: [],
  maxilares: { sup: nuevoMaxilar(), inf: nuevoMaxilar() },
  maxilar: /** @type {'sup' | 'inf' | null} */ (null),
  num: /** @type {string | null} */ (null),
  modo: 'v',
  seleccion: /** @type {string | null} */ (null),
};
/** Lo que resolvió el servidor: curvas[maxilar][num]. */
const curvas = { sup: {}, inf: {} };
/** Lo que traía un trabajo abierto, para reconocer sus modelos cuando se arrastren. */
let pendientes = /** @type {any[]} */ ([]);

const visor = await crearVisor($('visor'));
const hud = crearHud(visor.motor, { alMovimiento: irA, alDeslizar: deslizar });

// ---------- avisos ----------
let borrarAviso = 0;
function avisar(texto, error = false) {
  const e = $('estado');
  e.textContent = texto; e.classList.toggle('error', error);
  clearTimeout(borrarAviso);
  if (texto) borrarAviso = setTimeout(() => { e.textContent = ''; }, error ? 8000 : 3500);
}

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
const actual = () => (estado.maxilar ? estado.maxilares[estado.maxilar] : null);
/** El maxilar como lo entiende el servidor. */
const paraServidor = (maxilar) => ({ ...estado.maxilares[maxilar], movimientos: movimientos(maxilar) });

// ---------- carga de modelos ----------
async function cargarArchivos(lista) {
  const archivos = [...lista].filter((a) => /\.(stl|ply|obj)$/i.test(a.name));
  if (!archivos.length) return;
  let hechos = 0;
  for (const archivo of archivos) {
    avisar(`Cargando ${++hechos} de ${archivos.length}: ${archivo.name}`);
    try {
      const r = await api.subirMalla(archivo);
      if (!visor.tiene(r.id)) visor.registrar(r.id, await api.bajarMalla(r.id));
      if (estado.archivos.some((a) => a.malla === r.id && a.nombre === r.nombre)) continue;
      const previo = pendientes.find((p) => p.malla === r.id && p.nombre === r.nombre) ?? pendientes.find((p) => p.nombre === r.nombre);
      estado.archivos.push({
        malla: r.id, nombre: r.nombre, arriba: r.arriba,
        maxilar: previo?.maxilar ?? r.archivo.maxilar, mov: previo?.mov ?? r.archivo.movimiento ?? '', usar: previo?.usar ?? true,
      });
      const caso = /** @type {HTMLInputElement} */ ($('caso'));
      if (!caso.value && r.archivo.id) caso.value = r.archivo.id;
    } catch (e) { avisar(String(e.message ?? e), true); }
  }
  estado.archivos.sort((a, b) => (a.maxilar ?? 'z').localeCompare(b.maxilar ?? 'z') || a.mov.localeCompare(b.mov, undefined, { numeric: true }));
  avisar(`${estado.archivos.length} modelos cargados`);
  alCambiarArchivos();
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
  visor.dibujar(mov ? curvas[estado.maxilar][estado.num] ?? null : null, estado.seleccion);
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
    if (maxilar === estado.maxilar && !arrastre) mostrar();
    else if (maxilar === estado.maxilar) visor.dibujar(curvas[maxilar][estado.num] ?? null, estado.seleccion);
  };
  api.resolver(cuerpo, [estado.num]).then(recibir).catch((e) => avisar(e.message, true));
  clearTimeout(espera);
  if (soloActual) return;
  espera = setTimeout(() => {
    if (mio !== turno) return;
    api.resolver(cuerpo, null).then((r) => { if (mio === turno) recibir(r); }).catch((e) => avisar(e.message, true));
  }, 120);
}

// ---------- gestos sobre el visor ----------
let arrastre = /** @type {{ id: string, movio: boolean, manija?: { lado: string, clave: number[], pos: number[] } } | null} */ (null);
let ultimoPedido = 0;
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
    arrastre = { id: estado.seleccion, movio: false, manija };
    return;
  }
  const id = visor.controladorEn(x, y);
  if (id) {
    estado.seleccion = id;
    arrastre = { id, movio: false };
    mostrar(); pintarPanel();
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
  max.controladores.push(nuevo);
  estado.seleccion = nuevo.id;
  pintarPanel();
  resolverTodo();
});

visor.lienzo.addEventListener('pointermove', (ev) => {
  const [x, y] = enLienzo(ev);
  if (hud.arrastrando) { hud.mover(x); return; }
  if (!arrastre) return;
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
  const [x] = enLienzo(ev);
  if (hud.arrastrando) { hud.soltar(x); return; }
  if (!arrastre) return;
  const movio = arrastre.movio;
  arrastre = null;
  if (movio) resolverTodo(); else mostrar();
  pintarPanel();
}
visor.lienzo.addEventListener('pointerup', soltar);
visor.lienzo.addEventListener('pointercancel', soltar);
visor.lienzo.addEventListener('contextmenu', (ev) => ev.preventDefault());

function deslizar(id, valor, final) {
  const max = actual();
  if (!max) return;
  max[id] = valor;
  pintarHud();
  const ahora = performance.now();
  if (final) resolverTodo();
  else if (ahora - ultimoPedido > 60) { ultimoPedido = ahora; resolverTodo({ soloActual: true }); }
}

function borrarPunto() {
  const max = actual();
  if (!max || !estado.seleccion) return;
  max.controladores = max.controladores.filter((c) => c.id !== estado.seleccion);
  estado.seleccion = null;
  curvas[estado.maxilar] = {};
  pintarPanel(); resolverTodo();
}

function restablecerFeston() {
  const c = actual()?.controladores.find((k) => k.id === estado.seleccion);
  if (!c?.manijas) return;
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
  delete c.claves[estado.num];
  pintarPanel(); resolverTodo();
}

window.addEventListener('keydown', (ev) => {
  if (/** @type {HTMLElement} */ (ev.target).matches('input, select, textarea')) return;
  const nums = estado.maxilar ? movimientos(estado.maxilar).map((m) => m.num) : [];
  const i = nums.indexOf(estado.num ?? '');
  if (ev.key === 'ArrowRight' && i >= 0 && i < nums.length - 1) irA(nums[i + 1]);
  else if (ev.key === 'ArrowLeft' && i > 0) irA(nums[i - 1]);
  else if (ev.key === 'Delete' || ev.key === 'Backspace') borrarPunto();
  else if (ev.key === 'k' || ev.key === 'K') quitarClave();
  else if (ev.key === '1') elegirModo('v');
  else if (ev.key === '2') elegirModo('l');
  else if (ev.key === '3') elegirModo('e');
  else return;
  ev.preventDefault();
});

function elegirModo(modo) { estado.modo = modo; pintarPanel(); }

// ---------- el HUD ----------
function pintarHud() {
  const max = actual();
  if (!max || !estado.maxilar) { hud.definir(null); return; }
  const nums = movimientos(estado.maxilar).map((m) => m.num);
  const claves = new Set(max.controladores.flatMap((c) => Object.keys(c.claves)));
  const sel = max.controladores.find((c) => c.id === estado.seleccion);
  hud.definir({
    linea: {
      titulo: `${MAXILARES[estado.maxilar]} · movimiento ${estado.num}${estado.num === nums[0] ? ' (base)' : ''}`,
      nums, actual: estado.num, claves, clavesSel: new Set(sel ? Object.keys(sel.claves) : []),
    },
    deslizadores: DESLIZADORES.map((d) => ({ ...d, valor: max[d.id] })),
  });
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
      <td><input type="text" data-i="${i}" data-campo="mov" value="${a.mov}" maxlength="3"></td>`;
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
    ? `Vestibulares ${cuenta('v')} · linguales ${cuenta('l')} · extremos ${cuenta('e')}/2. Marcando: ${MODOS[estado.modo]}.`
    : 'Cargá los modelos para empezar.';
  /** @type {HTMLButtonElement} */ ($('borrar-punto')).disabled = !estado.seleccion;
  const sel = max?.controladores.find((c) => c.id === estado.seleccion);
  /** @type {HTMLButtonElement} */ ($('borrar-clave')).disabled = !(sel && estado.num && sel.claves[estado.num] && estado.num !== base(estado.maxilar));
  /** @type {HTMLButtonElement} */ ($('restablecer')).disabled = !sel?.manijas;
  pintarHud();
}

$('tabla').addEventListener('change', (ev) => {
  const el = /** @type {HTMLInputElement} */ (ev.target);
  const a = estado.archivos[Number(el.dataset.i)];
  if (!a) return;
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

const soltarEn = $('soltar');
$('elegir').addEventListener('click', () => $('archivos').click());
$('archivos').addEventListener('change', (ev) => { const el = /** @type {HTMLInputElement} */ (ev.target); cargarArchivos(el.files ?? []); el.value = ''; });
for (const tipo of ['dragenter', 'dragover']) document.addEventListener(tipo, (ev) => { ev.preventDefault(); soltarEn.classList.add('encima'); });
for (const tipo of ['dragleave', 'drop']) document.addEventListener(tipo, (ev) => { ev.preventDefault(); soltarEn.classList.remove('encima'); });
document.addEventListener('drop', (ev) => cargarArchivos(ev.dataTransfer?.files ?? []));

// ---------- exportar, guardar y abrir ----------
function bajar(nombre, texto, tipo = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([texto], { type: tipo }));
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const idCaso = () => /** @type {HTMLInputElement} */ ($('caso')).value.trim() || 'caso';

$('exportar').addEventListener('click', async () => {
  try {
    const maxilares = Object.fromEntries(Object.keys(MAXILARES).filter((m) => movimientos(m).length && estado.maxilares[m].controladores.length).map((m) => [m, paraServidor(m)]));
    const r = await api.exportar({
      id: idCaso(), formato: /** @type {HTMLSelectElement} */ ($('formato')).value,
      n: Number(/** @type {HTMLInputElement} */ ($('puntos')).value) || 500, maxilares,
    });
    if ('showDirectoryPicker' in window) {
      try {
        const carpeta = await /** @type {any} */ (window).showDirectoryPicker({ mode: 'readwrite' });
        for (const f of r.archivos) {
          const w = await (await carpeta.getFileHandle(f.nombre, { create: true })).createWritable();
          await w.write(f.texto); await w.close();
        }
        avisar(`Exportado: ${r.archivos.map((f) => f.nombre).join(', ')}`);
        return;
      } catch (e) { if (e.name === 'AbortError') return; }
    }
    for (const f of r.archivos) bajar(f.nombre, f.texto);
    avisar(`Exportado: ${r.archivos.map((f) => f.nombre).join(', ')}`);
  } catch (e) { avisar(e.message, true); }
});

$('guardar').addEventListener('click', () => {
  bajar(`${idCaso()}.trimline.json`, JSON.stringify({
    formato: 'aligner-trimline', version: 1, id: idCaso(),
    archivos: estado.archivos.map(({ malla, nombre, maxilar, mov, usar }) => ({ malla, nombre, maxilar, mov, usar })),
    maxilares: estado.maxilares,
  }, null, 1), 'application/json');
});
$('abrir').addEventListener('click', () => $('trabajo').click());
$('trabajo').addEventListener('change', async (ev) => {
  const el = /** @type {HTMLInputElement} */ (ev.target);
  try {
    const t = JSON.parse(await /** @type {File} */ (el.files?.[0]).text());
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
    avisar(faltan ? `Trabajo abierto. Arrastrá sus ${faltan} modelos para verlo.` : 'Trabajo abierto.');
  } catch (e) { avisar(`No se pudo abrir: ${e.message}`, true); }
  el.value = '';
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
    await accion();
    // el servidor se reinicia: esperar a que vuelva y recargar la página con el código nuevo
    await new Promise((r) => setTimeout(r, 1500));
    for (let i = 0; i < 80; i++) {
      try { await api.version(); location.reload(); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    avisar('El programa no volvió a arrancar: abrilo de nuevo desde el acceso directo.', true);
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
pintarPanel();
// para probar y depurar desde la consola
Object.assign(window, { trimline: { estado, curvas, visor, hud, irA, elegirMaxilar, movimientos } });
