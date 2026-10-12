// Lo que la interfaz le pide al servidor local. Todo el cálculo pesado está del otro lado.

async function json(respuesta) {
  if (respuesta.ok) return respuesta.json();
  let detalle = respuesta.statusText;
  try { detalle = (await respuesta.json()).detail ?? detalle; } catch { /* no era JSON */ }
  throw new Error(detalle);
}

const enviar = (ruta, cuerpo) => fetch(ruta, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo ?? {}),
}).then(json);

/** Sube un archivo de malla tal cual y devuelve su resumen: { id, vertices, caras, arriba, min, max, archivo }. */
export const subirMalla = (archivo) => fetch(`/api/mallas?nombre=${encodeURIComponent(archivo.name)}`, {
  method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: archivo,
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
export const exportar = (cuerpo) => enviar('/api/exportar', cuerpo);
export const latido = () => enviar('/api/latido').catch(() => {});
export const cerrar = () => enviar('/api/cerrar');
export const actualizacion = (buscar = false) => fetch(`/api/actualizacion?buscar=${buscar}`).then(json);
export const instalarVersion = (tag) => enviar('/api/actualizacion/instalar', { tag });
export const revertirVersion = () => enviar('/api/actualizacion/revertir');
export const version = () => fetch('/api/version').then(json);
