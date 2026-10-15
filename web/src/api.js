// Lo que la interfaz le pide al servidor local. Todo el cálculo pesado está del otro lado.

async function json(respuesta) {
  if (respuesta.ok) return respuesta.json();
  let detalle = respuesta.statusText;
  try { detalle = (await respuesta.json()).detail ?? detalle; } catch { /* no era JSON */ }
  throw Object.assign(new Error(detalle), { status: respuesta.status });
}

const enviar = (ruta, cuerpo) => fetch(ruta, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo ?? {}),
}).then(json);

/** Sube un archivo de malla tal cual y devuelve su resumen: { id, vertices, caras, arriba, min, max, archivo }. */
export const subirMalla = (archivo) => fetch(`/api/mallas?nombre=${encodeURIComponent(archivo.name)}`, {
  method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: archivo,
}).then(json);

/** Lee un .pts para mostrarlo de referencia: { curvas: [{ maxilar, mov, puntos: [x, y, z, ...] }] }. */
export const referencia = (archivo) => fetch(`/api/referencia?nombre=${encodeURIComponent(archivo.name)}`, {
  method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: archivo,
}).then(json);

/** La malla ya soldada, con la misma numeración que usa el servidor: { posiciones, indices }. */
export async function bajarMalla(id) {
  const r = await fetch(`/api/mallas/${id}/bin`);
  if (!r.ok) throw new Error(`no se pudo bajar la malla ${id}`);
  const buf = await r.arrayBuffer();
  const [nv, nf] = new Uint32Array(buf, 0, 2);
  return {
    posiciones: new Float32Array(buf, 8, nv * 3),
    indices: new Uint32Array(buf, 8 + nv * 12, nf * 3),
  };
}

export const resolver = (maxilar, nums, n = 300) => enviar('/api/resolver', { maxilar, nums, n });
export const exportadores = () => fetch('/api/exportadores').then(json);
/** Exporta; con `carpeta` el servidor escribe ahí los archivos (409 si ya hay y no se pidió `pisar`). */
export const exportar = (cuerpo) => enviar('/api/exportar', cuerpo);
/** El diálogo de carpetas del sistema: { carpeta } o { carpeta: null } si se canceló. */
export const elegirCarpeta = (inicial, titulo) => enviar('/api/carpeta/elegir', { inicial, titulo });
export const latido = () => enviar('/api/latido').catch(() => {});
export const cerrar = () => enviar('/api/cerrar');
export const actualizacion = (buscar = false) => fetch(`/api/actualizacion?buscar=${buscar}`).then(json);
export const instalarVersion = (tag) => enviar('/api/actualizacion/instalar', { tag });
export const revertirVersion = () => enviar('/api/actualizacion/revertir');
export const version = () => fetch('/api/version').then(json);

/** Carga los modelos de una carpeta del disco: { carpeta, mallas: [resumen + archivo], errores }. */
export const mallasDeCarpeta = (carpeta, nombres) => enviar('/api/mallas/carpeta', { carpeta, nombres });

/**
 * El trabajo como contenido de un archivo .trimline, sin las mallas (solo su ruta).
 * Devuelve { blob, sinRuta }: cuántos modelos no tienen ruta conocida (se arrastraron).
 */
export async function guardarTrabajo(trabajo) {
  const r = await fetch('/api/trabajo/guardar', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(trabajo),
  });
  if (!r.ok) await json(r);
  return { blob: await r.blob(), sinRuta: Number(r.headers.get('X-Sin-Ruta')) || 0 };
}

/** El servidor escribe el .trimline (sin `ruta`, pregunta dónde): { ruta, sin_ruta } o { ruta: null }. 501 = sin diálogos. */
export const guardarEn = (cuerpo) => enviar('/api/trabajo/guardar-en', cuerpo);
/** El servidor abre un .trimline del disco (con su diálogo): { ruta, trabajo, mallas, faltan } o { ruta: null }. */
export const abrirDe = (cuerpo) => enviar('/api/trabajo/abrir-de', cuerpo);

/** Abre un .trimline: el servidor carga los modelos que encuentra. Devuelve { trabajo, mallas: [resumen], faltan }. */
export const abrirTrabajo = (archivo) => fetch('/api/trabajo/abrir', {
  method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: archivo,
}).then(json);
