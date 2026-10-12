// Estirar un conjunto por un plano (como el STRETCH de los CAD): lo que cruza el plano se
// estira, lo que está del lado que se arrastra se mueve, y lo del otro lado se queda.
//
// Todo se mide en el marco del ensamble, sobre uno de sus ejes, así el mismo mueble girado se
// estira igual. Cada "unidad" es una pieza (o una instancia, que se mueve entera) con lo que ocupa
// sobre ese eje y sobre los otros dos.
//
// Una pieza que cruza el plano se estira solo si uno de sus ejes corre a lo largo del eje de
// estirado (entonces se le cambia esa medida). Si cruza en diagonal, no hay una sola manera de
// estirarla: se mueve entera con el lado donde está su centro (y el plan lo dice). Lo mismo con
// las bloqueadas (patas torneadas, perfiles, frentes) y con las instancias.
//
// Puro: no importa three ni DOM.

/**
 * @typedef {Object} Unidad
 * @property {string} id
 * @property {number} lo        dónde empieza, sobre el eje de estirado
 * @property {number} hi        dónde termina
 * @property {[[number, number], [number, number]]} resto   lo que ocupa sobre los otros dos ejes
 * @property {0 | 1 | 2 | null} eje   el eje de la pieza que corre a lo largo del de estirado, o null (en diagonal, o no se estira)
 * @property {'locked' | 'instance' | null} fija   por qué no se estira nunca, si es así
 */
/**
 * @typedef {{ id: string, action: 'stretch' | 'move' | 'stay', axis?: 0 | 1 | 2, reason?: 'locked' | 'instance' | 'diagonal' }} Paso
 */

/**
 * Los planos de corte posibles: el medio de cada hueco entre bordes (de cualquier pieza), el
 * hueco más ancho primero y, si empatan, el más centrado. Un plano que cruzaría una pieza fija
 * no se ofrece.
 * @param {readonly Unidad[]} us @returns {{ plane: number, gap: number }[]}
 */
export function cutPlanes(us) {
  if (!us.length) return [];
  const bordes = [...new Set(us.flatMap((u) => [u.lo, u.hi]).map((v) => Math.round(v * 1e9) / 1e9))].sort((a, b) => a - b);
  const lo = bordes[0], hi = bordes[bordes.length - 1], medio = (lo + hi) / 2;
  /** @type {{ plane: number, gap: number }[]} */
  const out = [];
  for (let i = 0; i + 1 < bordes.length; i++) {
    const plane = (bordes[i] + bordes[i + 1]) / 2;
    if (us.some((u) => u.fija && u.lo < plane && u.hi > plane)) continue;
    out.push({ plane, gap: bordes[i + 1] - bordes[i] });
  }
  return out.sort((a, b) => b.gap - a.gap || Math.abs(a.plane - medio) - Math.abs(b.plane - medio));
}

/**
 * Qué le pasa a cada unidad, y cuánto se puede achicar como mucho (`min`: el delta más chico
 * permitido). `side`: el lado que se arrastra (1: el de valores mayores). `delta`: cuánto crece
 * el conjunto (negativo: se achica).
 * @param {readonly Unidad[]} us @param {{ plane: number, side: 1 | -1, minLength: number }} opts
 * @returns {{ pasos: Paso[], min: number }}
 */
export function stretchPlan(us, { plane, side, minLength }) {
  const eps = 1e-9 * Math.max(1, ...us.map((u) => Math.abs(u.hi) + Math.abs(u.lo)));
  /** @type {Paso[]} */
  const pasos = [];
  for (const u of us) {
    const lado = u.hi <= plane + eps ? -1 : u.lo >= plane - eps ? 1 : 0;
    if (lado !== 0) { pasos.push({ id: u.id, action: lado === side ? 'move' : 'stay' }); continue; }
    if (u.fija || u.eje === null) {
      const centro = (u.lo + u.hi) / 2 > plane ? 1 : -1;
      pasos.push({ id: u.id, action: centro === side ? 'move' : 'stay', reason: u.fija ?? 'diagonal' });
      continue;
    }
    pasos.push({ id: u.id, action: 'stretch', axis: u.eje });
  }
  // el límite al achicar: ninguna estirada por debajo del mínimo, y los lados no se cruzan
  let min = -Infinity;
  const porId = new Map(us.map((u) => [u.id, u]));
  for (const p of pasos) if (p.action === 'stretch') {
    const u = /** @type {Unidad} */ (porId.get(p.id));
    min = Math.max(min, minLength - (u.hi - u.lo));
  }
  const mueven = pasos.filter((p) => p.action === 'move').map((p) => /** @type {Unidad} */ (porId.get(p.id)));
  const quedan = pasos.filter((p) => p.action === 'stay').map((p) => /** @type {Unidad} */ (porId.get(p.id)));
  const solapan = (/** @type {Unidad} */ a, /** @type {Unidad} */ b) => a.resto.every(([a0, a1], k) => a0 < b.resto[k][1] - eps && b.resto[k][0] < a1 - eps);
  for (const m of mueven) for (const q of quedan) {
    if (!solapan(m, q)) continue;
    // del lado +: lo de m baja delta; no puede pasar el hi de q (y al revés del lado -)
    if (side === 1 && m.lo >= q.hi - eps) min = Math.max(min, q.hi - m.lo);
    if (side === -1 && m.hi <= q.lo + eps) min = Math.max(min, m.hi - q.lo);
  }
  return { pasos, min };
}
