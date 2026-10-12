// El modelo: un árbol de partes.
//
// Una PARTE es lo que se puede mover, girar, duplicar y meter en un ensamble. Hay tres:
//   - la PIEZA es una hoja: tiene lo fabricable (medidas, material, forma), definido en
//     su marco local, que no cambia al moverla ni al girarla.
//   - el ENSAMBLE es un nodo: no tiene nada fabricable propio, compone. Su caja sale de
//     sus hijos. Y como es una parte más, se puede meter en otro ensamble — un mueble es
//     un ensamble de cuerpo, puerta y cajón, que a su vez son ensambles.
//   - la INSTANCIA es la misma pieza o el mismo ensamble colocado otra vez (lo que en Rhino
//     es un Block, no una copia): guarda solo de quién es copia y su marco. Todo lo demás
//     (medidas, forma, lo de adentro) se lee de la fuente cada vez, así que editar la
//     fuente cambia todas sus instancias sin hacer nada más.
//
// Cada parte guarda su marco RESPECTO DE SU PADRE. El marco en el mundo se calcula
// subiendo por el árbol. Girar un ensamble es tocar UN marco: los hijos no se enteran,
// sus definiciones siguen intactas, y en el mundo giran con él.
//
// Toda la geometría se puede pedir en 'local' (el marco de la parte) o en 'world'.
//
// Las medidas son números en la UNIDAD DEL DOCUMENTO (`model.units`: mm, cm, m, in o ft; cm si
// no se dice otra). Viaja con el documento al guardarlo, y de ella salen las tolerancias que
// sugiere config.js.
//
// Lo que está adentro de una instancia no se guarda: se resuelve al pedirlo, con un id de
// camino (`I-1/P-2`: la pieza P-2 de la fuente, tal como queda dentro de la instancia I-1).
// Esas piezas "virtuales" se leen como cualquier otra (vértices, contacto), pero no se
// pueden cambiar por separado: se cambia la fuente, o se suelta la instancia (`detach`).
//
// Este módulo no importa nada de three ni del DOM: corre en Node y lo puede usar el
// servidor. Lo prueba test/sdk.test.mjs.
import { frame, compose, invert, apply, rotate, turn, transpose3, isQuarterTurn, axisIndex } from './frame.js';
import { DEFAULT_UNIT, checkUnit } from './units.js';
import { checkOperation } from './solid.js';
import { checkShape } from './sections.js';

/** @typedef {import('./frame.js').Vec3} Vec3 */
/** @typedef {import('./frame.js').Mat3} Mat3 */
/** @typedef {import('./frame.js').Frame} Frame */
/** @typedef {import('./frame.js').Axis} Axis */
/** @typedef {'local' | 'world'} Space */
/** @typedef {import('./units.js').Unit} Unit */
/** @typedef {import('./solid.js').Operation} Operation */
/** @typedef {import('./solid.js').OperationSpec} OperationSpec */

/**
 * Qué eje LOCAL es el largo, el ancho y el espesor de una pieza. Se decide al crearla
 * (por tamaño) y es parte de su definición: girar no lo cambia, porque los ejes locales
 * giran con la pieza. Solo se cambia a propósito.
 * @typedef {{ length: 0 | 1 | 2, width: 0 | 1 | 2, thickness: 0 | 1 | 2 }} Axes
 */

/**
 * @typedef {Object} PieceDef
 * @property {'piece'} kind
 * @property {string} id
 * @property {string} name
 * @property {string | null} parent
 * @property {Frame} frame       marco respecto del padre (o del mundo si es raíz)
 * @property {Vec3} size         medidas en la unidad del documento, sobre los ejes locales x, y, z
 * @property {Axes} axes
 * @property {string} material
 * @property {import('./sections.js').Shape | null} shape  forma del bruto (perfil, torneado), o null si es una caja
 * @property {Operation[]} [operations]  lo que se le hace al bruto, en orden (ver solid.js)
 * @property {string} [source]   solo en lo que sale de una instancia: la parte de la que es copia
 * @property {true} [fixed]      anclada al mundo: el asentador de relaciones no la mueve (solo si es true)
 */
/**
 * @typedef {Object} AssemblyDef
 * @property {'assembly'} kind
 * @property {string} id
 * @property {string} name
 * @property {string | null} parent
 * @property {Frame} frame
 * @property {string[]} children
 * @property {string} [source]   solo en lo que sale de una instancia: la parte de la que es copia
 * @property {true} [fixed]      anclado al mundo, con todo lo que tiene adentro (solo si es true)
 */
/**
 * Lo que se guarda de una instancia: de quién es copia (siempre una pieza o un ensamble
 * de verdad, nunca otra instancia) y dónde está colocada.
 * @typedef {Object} InstanceDef
 * @property {'instance'} kind
 * @property {string} id
 * @property {string} name
 * @property {string | null} parent
 * @property {Frame} frame
 * @property {string} source
 * @property {true} [fixed]      anclada al mundo (solo si es true)
 */
/** Lo que se ve de una parte: una pieza o un ensamble (una instancia se ve como lo que copia). @typedef {PieceDef | AssemblyDef} PartDef */
/** Lo que se guarda. @typedef {PieceDef | AssemblyDef | InstanceDef} StoredPart */

/**
 * Una RELACIÓN entre partes guardadas (una junta, una unión, un vínculo…). El modelo no sabe qué
 * significa cada tipo: guarda sus partes, sus datos y su estado, la mete en el deshacer, la
 * guarda con el documento y la limpia si alguna de sus partes desaparece. Lo que hace cada tipo
 * lo pone el taller (index.js).
 *   `ops`: las operaciones de piezas que son de la relación (los agujeros de una unión): se
 *          borran con ella.
 *   `broken`: null si vale, o por qué no.
 *   `meta`: lo que la app quiera guardar con ella (su tipo comercial, un nombre); el SDK no lo lee.
 * @typedef {Object} RelationDef
 * @property {string} id
 * @property {string} kind
 * @property {string[]} parts
 * @property {Record<string, any>} data
 * @property {[string, string][]} ops     pares [pieza, id de operación]
 * @property {string | null} broken
 * @property {Record<string, any> | null} meta
 */

/** Una foto del documento, para deshacer: sus partes, sus relaciones y sus contadores de ids. @typedef {{ parts: Map<string, StoredPart>, relations: Map<string, RelationDef>, counters: Record<string, number> }} Foto */

/** @typedef {{ min: Vec3, max: Vec3, size: Vec3, center: Vec3 }} Box */
/** @typedef {{ axis: 0 | 1 | 2, side: 1 | -1, normal: Vec3, corners: Vec3[], center: Vec3 }} Face */

/** Ejes por tamaño: el más largo es el largo, el más corto el espesor. @param {Vec3} size @returns {Axes} */
export function axesBySize(size) {
  const o = /** @type {(0 | 1 | 2)[]} */ ([0, 1, 2]).sort((a, b) => size[b] - size[a] || a - b);
  return { length: o[0], width: o[1], thickness: o[2] };
}

const clone = (/** @type {any} */ v) => JSON.parse(JSON.stringify(v));

/** Congela un registro entero, para que nadie lo toque por la espalda. @template T @param {T} o @returns {T} */
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/**
 * La versión del formato de `toJSON()`. Sube cuando un documento guardado trae algo que una
 * versión anterior del SDK perdería sin darse cuenta; `load` rechaza las que son más nuevas.
 *   1: partes y ensambles · 2: instancias · 3: unidad · 4: operaciones de las piezas · 5: relaciones
 *   6: partes fijas (`fixed`): solo la lleva un documento que tiene alguna, así que uno sin partes
 *      fijas sigue saliendo como 5 y lo lee cualquier versión que lea 5
 */
const VERSION_DOCUMENTO = 6;

const PREFIJO = /** @type {const} */ ({ piece: 'P', assembly: 'E', instance: 'I', relation: 'R' });

/** @param {Axes} axes @returns {Axes} */
function checkAxes(axes) {
  const vals = [axes.length, axes.width, axes.thickness];
  if (!vals.every((v) => v === 0 || v === 1 || v === 2) || new Set(vals).size !== 3) {
    throw new Error(`ejes inválidos: ${JSON.stringify(axes)} (van length, width, thickness con 0, 1 y 2, sin repetir)`);
  }
  return { length: axes.length, width: axes.width, thickness: axes.thickness };
}

/**
 * Un documento que se carga no puede dejar una instancia sin fuente ni un conjunto que se
 * contenga a sí mismo (recorrerlo no terminaría nunca).
 * @param {Map<string, StoredPart>} parts
 */
function validate(parts) {
  for (const p of parts.values()) {
    if (p.kind !== 'instance') continue;
    const s = parts.get(p.source);
    if (!s || s.kind === 'instance') throw new Error(`documento inválido: ${p.id} es copia de ${p.source}, que no existe o es otra instancia`);
  }
  /** @type {Set<string>} */
  const listo = new Set();
  /** @param {string} id @param {string[]} camino */
  const visitar = (id, camino) => {
    if (camino.includes(id)) throw new Error(`documento inválido: ${[...camino, id].join(' → ')} queda adentro de sí mismo`);
    if (listo.has(id)) return;
    const p = parts.get(id);
    if (!p) return;
    const sig = p.kind === 'assembly' ? p.children : p.kind === 'instance' ? [p.source] : [];
    for (const s of sig) visitar(s, [...camino, id]);
    listo.add(id);
  };
  for (const id of parts.keys()) visitar(id, []);
}

/**
 * Una relación que se carga tiene que apuntar a partes que existan.
 * @param {Map<string, RelationDef>} relations @param {Map<string, StoredPart>} parts
 */
function validateRelations(relations, parts) {
  for (const r of relations.values()) {
    if (typeof r.id !== 'string' || typeof r.kind !== 'string' || !Array.isArray(r.parts)) throw new Error(`documento inválido: relación mal formada (${JSON.stringify(r).slice(0, 80)})`);
    const falta = r.parts.find((p) => !parts.has(p));
    if (falta) throw new Error(`documento inválido: la relación ${r.id} apunta a ${falta}, que no existe`);
  }
}

/** Una relación limpia, con todos sus campos. @param {any} r @returns {RelationDef} */
const relacion = (r) => ({ id: r.id, kind: r.kind, parts: [...r.parts], data: clone(r.data ?? {}), ops: clone(r.ops ?? []), broken: r.broken ?? null, meta: r.meta === undefined || r.meta === null ? null : clone(r.meta) });

export class Model {
  /** @type {Foto[]} */
  #pasos = [];
  /** @type {Foto[]} */
  #rehacer = [];
  #nivel = 0;
  /** Cuántas transacciones abrió el que usa el modelo (begin): las operaciones de adentro son "de primer nivel" para asentar. */
  #abiertas = 0;
  #asentando = false;
  /** @type {Foto | null} */
  #inicio = null;

  /**
   * @param {{ units?: Unit, historyLimit?: number }} [opts]
   *   `units`: la unidad del documento (cm si no se dice).
   *   `historyLimit`: cuántos pasos se pueden deshacer (100 si no se dice; 0: no se guarda historial).
   */
  constructor({ units = DEFAULT_UNIT, historyLimit = 100 } = {}) {
    if (!Number.isInteger(historyLimit) || historyLimit < 0) throw new TypeError(`historyLimit inválido: ${String(historyLimit)} (va un entero de 0 o más)`);
    /** Cuántos pasos se guardan para deshacer. */
    this.historyLimit = historyLimit;
    /** La unidad en que están todas las medidas del documento. @type {Unit} */
    this.units = checkUnit(units);
    /** @type {Map<string, StoredPart>} */
    this.parts = new Map();
    /** @type {Map<string, RelationDef>} */
    this.relations = new Map();
    /** @type {Record<string, number>} */
    this.counters = { piece: 0, assembly: 0, instance: 0, relation: 0 };
    /** @type {Set<(ev: { type: string, ids: string[] }) => void>} */
    this.listeners = new Set();
    /**
     * Lo que pone en orden las relaciones después de cada cambio (lo cuelga el taller). Corre
     * dentro del mismo paso de deshacer: con 'step' después de cada operación de primer nivel
     * (también adentro de una transacción), y con 'close' al cerrar el paso (lo que no puede
     * mirar un estado a medio hacer, como si dos piezas se siguen tocando).
     * @type {((phase: 'step' | 'close') => void) | null}
     */
    this.settler = null;
  }

  // ---------- eventos: el visor (y mañana la interfaz) se cuelga de acá ----------

  /** @param {(ev: { type: string, ids: string[] }) => void} fn @returns {() => void} para desuscribirse */
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Avisa qué cambió. Si lo que cambió es (o está adentro de) la fuente de una instancia, la
   * instancia cambió también: va en el aviso, con lo que tiene adentro.
   * @param {string} type @param {string[]} ids
   */
  emit(type, ids) {
    const todos = this.#conInstancias(ids);
    for (const fn of this.listeners) fn({ type, ids: todos });
  }

  /** @param {string[]} ids @returns {string[]} */
  #conInstancias(ids) {
    const out = new Set(ids);
    // las piezas que se recortan contra algo que cambió también cambian
    for (const p of this.parts.values()) {
      if (p.kind === 'piece' && p.operations?.some((o) => o.kind === 'trim' && out.has(o.against))) out.add(p.id);
    }
    const insts = [...this.parts.values()].filter((p) => p.kind === 'instance');
    if (!insts.length) return [...out];
    const tocadas = new Set([...out].filter((id) => this.parts.has(id)));
    /** @type {Set<string>} */
    const alcanzadas = new Set();
    for (let creció = true; creció;) {
      creció = false;
      // lo que, si es fuente de una instancia, la arrastra: lo tocado, lo que lo contiene,
      // y las instancias ya alcanzadas con lo que las contiene
      /** @type {Set<string>} */
      const alcance = new Set();
      for (const id of [...tocadas, ...alcanzadas]) {
        for (let p = this.parts.get(id); p; p = p.parent ? this.parts.get(p.parent) : undefined) alcance.add(p.id);
      }
      for (const i of insts) {
        if (i.kind === 'instance' && !alcanzadas.has(i.id) && alcance.has(i.source)) { alcanzadas.add(i.id); creció = true; }
      }
    }
    for (const id of alcanzadas) for (const x of this.subtree(id)) out.add(x);
    return [...out];
  }

  // ---------- leer ----------

  /**
   * Lo que se ve de una parte. Una instancia se ve como lo que copia (una pieza o un
   * ensamble) puesta en su lugar, y lo de adentro de una instancia se resuelve por su id de
   * camino. Es para leer: lo guardado, que es lo que se cambia, está en `own`.
   * @param {string} id @returns {PartDef}
   */
  get(id) {
    const rec = this.parts.get(id);
    if (rec) return rec.kind === 'instance' ? this.#view(rec, id, rec.parent) : rec;
    const i = id.lastIndexOf('/');
    if (i < 0) throw new Error(`no existe la parte ${id}`);
    const parentId = id.slice(0, i);
    const parent = this.get(parentId);
    const src = this.parts.get(id.slice(i + 1));
    if (!src || parent.kind !== 'assembly' || !parent.children.includes(id)) throw new Error(`no existe la parte ${id}`);
    return this.#view(src, id, parentId);
  }

  /**
   * @param {StoredPart} rec lo guardado de lo que se copia
   * @param {string} id el id con que se ve (el de `rec`, o el de camino si es de adentro de una instancia)
   * @param {string | null} parent
   * @returns {PartDef}
   */
  #view(rec, id, parent) {
    const base = rec.kind === 'instance' ? this.#sourceOf(rec) : rec;
    const source = id !== rec.id ? rec.id : rec.kind === 'instance' ? rec.source : undefined;
    if (base.kind === 'piece') {
      return { kind: 'piece', id, name: rec.name, parent, frame: rec.frame, size: base.size, axes: base.axes, material: base.material, shape: base.shape, operations: base.operations ?? [], source };
    }
    const children = rec.kind === 'assembly' && id === rec.id ? rec.children : base.children.map((c) => `${id}/${c}`);
    return { kind: 'assembly', id, name: rec.name, parent, frame: rec.frame, children, source };
  }

  /** @param {InstanceDef} inst @returns {PieceDef | AssemblyDef} */
  #sourceOf(inst) {
    const s = this.parts.get(inst.source);
    if (!s || s.kind === 'instance') throw new Error(`${inst.id} es copia de ${inst.source}, que ya no existe`);
    return s;
  }

  /**
   * La parte tal como está guardada, que es lo que se cambia. Lo de adentro de una
   * instancia no se guarda, así que no hay nada que cambiar ahí.
   * @param {string} id @returns {StoredPart}
   */
  own(id) {
    const p = this.parts.get(id);
    if (p) return p;
    const raiz = id.split('/')[0];
    if (id.includes('/') && this.parts.has(raiz)) {
      throw new Error(`${id} es parte de la instancia ${raiz}: se cambia en su fuente, o se suelta la instancia con detach()`);
    }
    throw new Error(`no existe la parte ${id}`);
  }

  /** Una pieza guardada, para cambiarla. @param {string} id @returns {PieceDef} */
  ownPiece(id) {
    const p = this.own(id);
    if (p.kind === 'instance') throw new Error(`${id} es una instancia de ${p.source}: se cambia en su fuente, o se suelta con detach()`);
    if (p.kind !== 'piece') throw new Error(`${id} es un ensamble, no una pieza`);
    return p;
  }

  /** Un ensamble guardado, para cambiarlo. @param {string} id @returns {AssemblyDef} */
  ownAssembly(id) {
    const p = this.own(id);
    if (p.kind === 'instance') throw new Error(`${id} es una instancia: no puede contener partes (sueltala con detach())`);
    if (p.kind !== 'assembly') throw new Error(`${id} no es un ensamble`);
    return p;
  }

  /**
   * El registro guardado que DEFINE a una pieza: ella misma, o su fuente si es una instancia
   * (o de adentro de una). Lo que se deriva de la definición (la forma) se puede cachear por
   * este registro: es inmutable, y lo comparten todas las copias.
   * @param {string} id @returns {PieceDef}
   */
  definition(id) {
    this.piece(id); // que exista, y que sea una pieza
    let rec = /** @type {StoredPart} */ (this.parts.get(/** @type {string} */ (id.split('/').at(-1))));
    if (rec.kind === 'instance') rec = this.#sourceOf(rec);
    return /** @type {PieceDef} */ (rec);
  }

  /** @param {string} id @returns {PieceDef} */
  piece(id) {
    const p = this.get(id);
    if (p.kind !== 'piece') throw new Error(`${id} es un ensamble, no una pieza`);
    return p;
  }

  /** Las partes de primer nivel (sin padre), en orden de creación. */
  roots() {
    return [...this.parts.values()].filter((p) => p.parent === null);
  }

  /** @param {string} id @returns {PieceDef[]} todas las piezas que cuelgan de esta parte (ella misma si es pieza) */
  piecesOf(id) {
    const p = this.get(id);
    return p.kind === 'piece' ? [p] : p.children.flatMap((c) => this.piecesOf(c));
  }

  /**
   * Todas las piezas del documento, con las de adentro de cada instancia (en el mundo, son
   * piezas como cualquier otra). En el orden en que se crearon.
   * @returns {PieceDef[]}
   */
  allPieces() {
    /** @type {PieceDef[]} */
    const out = [];
    for (const p of this.parts.values()) {
      if (p.kind === 'piece') out.push(p);
      else if (p.kind === 'instance') out.push(...this.piecesOf(p.id));
    }
    return out;
  }

  /** @param {string} id @returns {string[]} los ids del subárbol, la parte primero (con lo de adentro de las instancias) */
  subtree(id) {
    const p = this.get(id);
    return p.kind === 'piece' ? [id] : [id, ...p.children.flatMap((c) => this.subtree(c))];
  }

  /** @param {string} id @returns {string[]} los ids guardados del subárbol: sin lo que sale de resolver instancias */
  realSubtree(id) {
    const p = this.own(id);
    return p.kind === 'assembly' ? [id, ...p.children.flatMap((c) => this.realSubtree(c))] : [id];
  }

  /** Los ids de las instancias de una parte (las guardadas, no las de adentro de otra instancia). @param {string} id @returns {string[]} */
  instancesOf(id) {
    return [...this.parts.values()].filter((p) => p.kind === 'instance' && p.source === id).map((p) => p.id);
  }

  /** @param {string} id @returns {Frame} el marco de la parte en el mundo */
  worldFrame(id) {
    const p = this.get(id);
    return p.parent === null ? p.frame : compose(this.worldFrame(p.parent), p.frame);
  }

  /** @param {string | null} id @returns {Frame} el marco del mundo para los hijos de `id` */
  parentWorld(id) {
    return id === null ? frame() : this.worldFrame(id);
  }

  // ---------- geometría ----------
  // Todo en 'local' (el marco de la parte) o en 'world'. Por ahora una pieza es su caja:
  // la forma (perfil, torneado, corte) viaja en la definición y el visor la dibuja, pero
  // los vértices que se consultan acá son los de la caja. Los de la forma real van después.

  /** @param {PieceDef} p @returns {Vec3[]} las 8 esquinas, en su marco local */
  cornersLocal(p) {
    const [a, b, c] = p.size.map((s) => s / 2);
    /** @type {Vec3[]} */
    const out = [];
    for (const x of [-a, a]) for (const y of [-b, b]) for (const z of [-c, c]) out.push([x, y, z]);
    return out;
  }

  /**
   * El marco que lleva del espacio de la pieza `pieceId` al espacio pedido: el mundo, o el
   * marco local de `relTo` (que puede ser un ensamble que la contiene).
   * @param {string} pieceId @param {Space} space @param {string} relTo
   */
  toSpace(pieceId, space, relTo) {
    const w = this.worldFrame(pieceId);
    return space === 'world' ? w : compose(invert(this.worldFrame(relTo)), w);
  }

  /** @param {string} id @param {Space} [space] @returns {Vec3[]} */
  positions(id, space = 'world') {
    return this.piecesOf(id).flatMap((p) => {
      const f = this.toSpace(p.id, space, id);
      return this.cornersLocal(p).map((v) => apply(f, v));
    });
  }

  /**
   * Caja alineada a los ejes del espacio pedido. En 'local' de una pieza es exacta: sus
   * medidas. En 'world' también es exacta (es la caja de las esquinas giradas), y con un
   * cuarto de vuelta da números limpios, sin ruido.
   * @param {string} id @param {Space} [space] @returns {Box}
   */
  box(id, space = 'world') {
    const pts = this.positions(id, space);
    if (!pts.length) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
    const min = /** @type {Vec3} */ ([0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k]))));
    const max = /** @type {Vec3} */ ([0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k]))));
    return {
      min, max,
      size: /** @type {Vec3} */ ([0, 1, 2].map((k) => max[k] - min[k])),
      center: /** @type {Vec3} */ ([0, 1, 2].map((k) => (min[k] + max[k]) / 2)),
    };
  }

  /** @param {string} id @param {Space} [space] @returns {[Vec3, Vec3][]} las 12 aristas de cada pieza */
  edges(id, space = 'world') {
    return this.piecesOf(id).flatMap((p) => {
      const f = this.toSpace(p.id, space, id);
      const h = p.size.map((s) => s / 2);
      /** @type {[Vec3, Vec3][]} */
      const out = [];
      for (let ax = 0; ax < 3; ax++) {
        const [u, v] = [0, 1, 2].filter((i) => i !== ax);
        for (const su of [-1, 1]) for (const sv of [-1, 1]) {
          /** @type {Vec3} */ const a = [0, 0, 0];
          /** @type {Vec3} */ const b = [0, 0, 0];
          a[u] = b[u] = su * h[u];
          a[v] = b[v] = sv * h[v];
          a[ax] = -h[ax];
          b[ax] = h[ax];
          out.push([apply(f, a), apply(f, b)]);
        }
      }
      return out;
    });
  }

  /**
   * Las 6 caras de cada pieza, con su normal. `axis`/`side` dicen qué cara es EN EL MARCO
   * DE LA PIEZA (la de +x local sigue siendo la de +x aunque la pieza esté girada); la
   * normal y las esquinas vienen en el espacio pedido.
   * @param {string} id @param {Space} [space] @returns {(Face & { piece: string })[]}
   */
  faces(id, space = 'world') {
    return this.piecesOf(id).flatMap((p) => {
      const f = this.toSpace(p.id, space, id);
      const h = p.size.map((s) => s / 2);
      /** @type {(Face & { piece: string })[]} */
      const out = [];
      for (let ax = 0; ax < 3; ax++) {
        const [u, v] = [0, 1, 2].filter((i) => i !== ax);
        for (const side of /** @type {(1 | -1)[]} */ ([1, -1])) {
          const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
            /** @type {Vec3} */ const q = [0, 0, 0];
            q[ax] = side * h[ax];
            q[u] = a * h[u];
            q[v] = b * h[v];
            return apply(f, q);
          });
          /** @type {Vec3} */ const n = [0, 0, 0];
          n[ax] = side;
          /** @type {Vec3} */ const c = [0, 0, 0];
          c[ax] = side * h[ax];
          out.push({ piece: p.id, axis: /** @type {0 | 1 | 2} */ (ax), side, normal: rotate(f.r, n), corners, center: apply(f, c) });
        }
      }
      return out;
    });
  }

  /**
   * Largo, ancho y espesor de una pieza. Salen de su definición, así que girarla no los
   * cambia nunca: un larguero sigue teniendo el largo que tenía, esté como esté.
   * @param {string} id
   */
  dims(id) {
    const p = this.piece(id);
    return { length: p.size[p.axes.length], width: p.size[p.axes.width], thickness: p.size[p.axes.thickness] };
  }

  /** ¿Todos los marcos, hasta el mundo, son cuartos de vuelta? Entonces la caja en el mundo es la pieza exacta. @param {string} id */
  isAxisAligned(id) {
    return isQuarterTurn(this.worldFrame(id).r);
  }

  // ---------- cambiar: lo guardado no se toca, se reemplaza ----------
  // Los registros guardados son inmutables (están congelados): un cambio pone un registro nuevo
  // en el lugar del viejo. Así una "foto" del documento es copiar el Map —los registros se
  // comparten, no se clonan— y deshacer es volver a una foto.

  /** @param {StoredPart} rec */
  #put(rec) {
    this.parts.set(rec.id, deepFreeze(rec));
  }

  /** @param {string} id @param {Record<string, unknown>} cambios */
  #patch(id, cambios) {
    this.#put(/** @type {StoredPart} */ ({ ...this.own(id), ...cambios }));
  }

  // ---------- deshacer ----------
  // Cada operación es un paso. Para que varias valgan un solo paso (un arrastre son cien
  // `move`) se agrupan con begin() … commit(), o con transaction(fn). Una operación que falla
  // a medias no deja nada hecho, y rollback() cancela todo lo de una transacción abierta.

  /** @returns {Foto} */
  #foto() {
    return { parts: new Map(this.parts), relations: new Map(this.relations), counters: { ...this.counters } };
  }

  /** @param {Foto} f */
  #volver(f) {
    this.parts = new Map(f.parts);
    this.relations = new Map(f.relations);
    this.counters = { ...f.counters };
  }

  /** Los ids que cambian entre dos mapas: los que están en uno y no en el otro, o distintos. @param {Map<string, unknown>} a @param {Map<string, unknown>} b */
  #diferencias(a, b) {
    /** @type {string[]} */
    const out = [];
    for (const [id, rec] of a) if (b.get(id) !== rec) out.push(id);
    for (const id of b.keys()) if (!a.has(id)) out.push(id);
    return out;
  }

  /** Lo que cambia entre el documento y una foto: partes y relaciones. @param {Foto} f */
  #cambiosDesde(f) {
    return [...this.#diferencias(this.parts, f.parts), ...this.#diferencias(this.relations, f.relations)];
  }

  /** ¿El documento es el de la foto? @param {Foto} f */
  #igual(f) {
    const ks = new Set([...Object.keys(f.counters), ...Object.keys(this.counters)]);
    return this.#cambiosDesde(f).length === 0 && [...ks].every((k) => (f.counters[k] ?? 0) === (this.counters[k] ?? 0));
  }

  /** Vuelve a una foto y avisa qué cambió. @param {Foto} f @param {string} tipo */
  #restaurar(f, tipo) {
    const ids = this.#cambiosDesde(f);
    this.#volver(f);
    if (ids.length) this.emit(tipo, ids);
  }

  /**
   * Deja que el taller ponga en orden las relaciones (ver `settler`). No se anida: lo que hace
   * el que asienta no vuelve a asentar.
   * @param {'step' | 'close'} phase
   */
  #asentar(phase) {
    if (!this.settler || this.#asentando || !this.relations.size) return;
    this.#asentando = true;
    try { this.settler(phase); } finally { this.#asentando = false; }
  }

  /** Cierra el paso que se abrió: si cambió algo, queda para deshacer. */
  #cerrar() {
    const inicio = this.#inicio;
    this.#inicio = null;
    if (!inicio || this.#igual(inicio)) return;
    this.#pasos.push(inicio);
    this.#rehacer.length = 0;
    while (this.#pasos.length > this.historyLimit) this.#pasos.shift();
  }

  /**
   * Una operación, como un paso de deshacer (o parte de la transacción abierta). Si falla, el
   * documento queda como estaba antes de ella.
   * @template T @param {() => T} fn @returns {T}
   */
  #paso(fn) {
    const antes = this.#foto();
    if (this.#nivel === 0) this.#inicio = antes;
    this.#nivel++;
    try {
      const r = fn();
      // una operación de primer nivel (la que pidió el que usa el modelo, no una de adentro de otra)
      if (this.#nivel === this.#abiertas + 1 && !this.#asentando) {
        this.#asentar('step');
        if (this.#nivel === 1) this.#asentar('close');
      }
      return r;
    } catch (e) {
      const ids = this.#cambiosDesde(antes);
      this.#volver(antes);
      if (ids.length) this.emit('rollback', ids);
      throw e;
    } finally {
      if (--this.#nivel === 0) this.#cerrar();
    }
  }

  /** Abre una transacción: lo que se haga hasta commit() es un solo paso de deshacer. Se anidan: vale la de afuera. */
  begin() {
    if (this.#nivel === 0) this.#inicio = this.#foto();
    this.#nivel++;
    this.#abiertas++;
  }

  /** Cierra la transacción. Si no cambió nada, no queda ningún paso. */
  commit() {
    if (this.#nivel === 0) throw new Error('no hay una transacción abierta (begin)');
    if (this.#nivel === 1) {
      try {
        this.#asentar('close');
      } catch (e) {
        this.rollback();
        throw e;
      }
    }
    this.#abiertas--;
    if (--this.#nivel === 0) this.#cerrar();
  }

  /** Cancela la transacción abierta (con todas las de adentro): el documento vuelve a como estaba en begin(). */
  rollback() {
    if (this.#nivel === 0) throw new Error('no hay una transacción abierta (begin)');
    const inicio = /** @type {Foto} */ (this.#inicio);
    this.#nivel = 0;
    this.#abiertas = 0;
    this.#inicio = null;
    this.#restaurar(inicio, 'rollback');
  }

  /**
   * Hace `fn` como un solo paso de deshacer. Si tira, el documento vuelve a como estaba.
   * @template T @param {() => T} fn @returns {T}
   */
  transaction(fn) {
    this.begin();
    /** @type {T} */
    let r;
    try {
      r = fn();
    } catch (e) {
      if (this.#nivel > 0) this.rollback();
      throw e;
    }
    if (this.#nivel > 0) this.commit();
    return r;
  }

  /** @param {string} que */
  #sinTransaccion(que) {
    if (this.#nivel) throw new Error(`hay una transacción abierta: se cierra (commit) o se cancela (rollback) antes de ${que}`);
  }

  /** ¿Hay algo para deshacer? */
  get canUndo() { return this.#pasos.length > 0; }
  /** ¿Hay algo para rehacer? */
  get canRedo() { return this.#rehacer.length > 0; }

  /** Vuelve al documento de antes del último paso. Devuelve false si no había nada para deshacer. */
  undo() {
    this.#sinTransaccion('deshacer');
    const antes = this.#pasos.pop();
    if (!antes) return false;
    this.#rehacer.push(this.#foto());
    this.#restaurar(antes, 'undo');
    return true;
  }

  /** Vuelve a hacer lo último que se deshizo. Devuelve false si no había nada para rehacer. */
  redo() {
    this.#sinTransaccion('rehacer');
    const despues = this.#rehacer.pop();
    if (!despues) return false;
    this.#pasos.push(this.#foto());
    this.#restaurar(despues, 'redo');
    return true;
  }

  /** Olvida lo que se puede deshacer y rehacer; el documento queda como está. */
  clearHistory() {
    this.#sinTransaccion('borrar el historial');
    this.#pasos.length = 0;
    this.#rehacer.length = 0;
  }

  // ---------- crear ----------

  /** @param {'piece' | 'assembly' | 'instance' | 'relation'} kind */
  nextId(kind) {
    this.counters[kind] = (this.counters[kind] ?? 0) + 1;
    return `${PREFIJO[kind]}-${this.counters[kind]}`;
  }

  /**
   * @param {{ name?: string, size: Vec3, material?: string, shape?: unknown,
   *           at?: Vec3, r?: Mat3, axes?: Axes, parent?: string | null }} spec
   *   `at`: dónde queda su centro, en el espacio del padre (el mundo si no tiene).
   *   `r`: su rotación inicial en ese mismo espacio (identidad si no se da), para crearla ya
   *   orientada en vez de crearla derecha y rotarla después.
   * @returns {string} el id
   */
  addPiece({ name, size, material = 'default', shape = null, at = [0, 0, 0], r, axes, parent = null }) {
    if (!Array.isArray(size) || size.length !== 3 || size.some((s) => !(s > 0))) {
      throw new Error(`medidas inválidas: ${JSON.stringify(size)} (van tres números > 0, en ${this.units})`);
    }
    return this.#paso(() => {
      const id = this.nextId('piece');
      /** @type {PieceDef} */
      const p = {
        kind: 'piece', id, name: name || `Pieza ${this.counters.piece}`, parent: null,
        frame: frame(at, r), size: [...size], axes: axes ? checkAxes(axes) : axesBySize(size),
        material, shape: checkShape(shape), operations: [],
      };
      this.#put(p);
      if (parent) this.adopt(parent, [id], { keepWorld: false });
      this.emit('add', [id]);
      return id;
    });
  }

  /**
   * Junta partes hermanas en un ensamble nuevo. Si alguna ya es un ensamble, queda
   * ADENTRO del nuevo: se anida, no se aplasta. El origen del ensamble queda en el centro
   * de lo que junta, así girarlo gira alrededor de su centro. Nada cambia de lugar.
   * @param {string[]} ids @param {{ name?: string }} [opts] @returns {string}
   */
  assemble(ids, { name } = {}) {
    if (!ids.length) throw new Error('no hay nada para ensamblar');
    return this.#paso(() => {
      const parts = ids.map((id) => this.own(id));
      const parent = parts[0].parent;
      if (parts.some((p) => p.parent !== parent)) {
        throw new Error('solo se ensamblan partes hermanas (que estén en el mismo ensamble, o sueltas)');
      }
      // el centro de lo que se junta, en el espacio del padre
      const pw = this.parentWorld(parent);
      const pts = ids.flatMap((id) => this.positions(id, 'world')).map((q) => apply(invert(pw), q));
      const center = /** @type {Vec3} */ ([0, 1, 2].map((k) => (Math.min(...pts.map((q) => q[k])) + Math.max(...pts.map((q) => q[k]))) / 2));
      const id = this.nextId('assembly');
      /** @type {AssemblyDef} */
      const a = { kind: 'assembly', id, name: name || `Ensamble ${this.counters.assembly}`, parent, frame: frame(center), children: [] };
      this.#put(a);
      if (parent) {
        const pa = this.ownAssembly(parent);
        this.#patch(parent, { children: [...pa.children.filter((c) => !ids.includes(c)), id] });
      }
      this.adopt(id, ids, { keepWorld: true });
      this.emit('assemble', [id, ...ids]);
      return id;
    });
  }

  /**
   * Mueve partes adentro de un ensamble. Con keepWorld no se mueven en el mundo: su marco
   * se re-expresa respecto del nuevo padre.
   * @param {string} parentId @param {string[]} ids @param {{ keepWorld: boolean }} opts
   */
  adopt(parentId, ids, { keepWorld }) {
    this.#paso(() => {
      this.ownAssembly(parentId);
      const inv = invert(this.worldFrame(parentId));
      for (const id of ids) {
        const p = this.own(id);
        if (this.#alcance(id).has(parentId)) throw new Error(`${id} no puede quedar adentro de sí mismo`);
        const w = this.worldFrame(id);
        this.#patch(id, { frame: keepWorld ? compose(inv, w) : p.frame, parent: parentId });
        const pa = this.ownAssembly(parentId);
        if (!pa.children.includes(id)) this.#patch(parentId, { children: [...pa.children, id] });
      }
    });
  }

  /**
   * Todo lo guardado que forma parte de `id`: ella, lo que tiene adentro y, por cada
   * instancia, su fuente (con todo lo de la fuente). Si un contenedor está en el alcance de
   * una parte, ponerla ahí adentro la haría contenerse a sí misma.
   * @param {string} id @param {Set<string>} [visto] @returns {Set<string>}
   */
  #alcance(id, visto = new Set()) {
    if (visto.has(id)) return visto;
    visto.add(id);
    const p = this.parts.get(id);
    if (p?.kind === 'assembly') for (const c of p.children) this.#alcance(c, visto);
    else if (p?.kind === 'instance') this.#alcance(p.source, visto);
    return visto;
  }

  /**
   * No se puede dejar sin fuente a una instancia: quitar partes que son la fuente de
   * instancias que quedan afuera es un error, con el nombre de quién las usa.
   * @param {string[]} quitadas
   */
  #sinDependientes(quitadas) {
    const q = new Set(quitadas);
    const deps = [...this.parts.values()].filter((p) => p.kind === 'instance' && !q.has(p.id) && q.has(p.source));
    if (deps.length) {
      const fuentes = [...new Set(deps.map((d) => /** @type {InstanceDef} */ (d).source))];
      throw new Error(`${fuentes.join(', ')} es la fuente de ${deps.map((d) => d.id).join(', ')}: se sueltan (detach) o se borran las instancias antes`);
    }
  }

  /** Deshace un ensamble: sus hijos pasan al padre, en el mismo lugar. @param {string} id */
  disassemble(id) {
    return this.#paso(() => {
      const a = this.own(id);
      if (a.kind === 'instance') throw new Error(`${id} es una instancia: se suelta con detach() y después se deshace`);
      if (a.kind !== 'assembly') throw new Error(`${id} no es un ensamble`);
      this.#sinDependientes([id]);
      const kids = [...a.children];
      for (const k of kids) {
        const p = this.own(k);
        this.#patch(k, { frame: compose(a.frame, p.frame), parent: a.parent });
      }
      if (a.parent) {
        const pa = this.ownAssembly(a.parent);
        this.#patch(a.parent, { children: pa.children.flatMap((c) => (c === id ? kids : [c])) });
      }
      this.parts.delete(id);
      this.emit('disassemble', [id, ...kids]);
      this.#limpiarRelaciones();
      return kids;
    });
  }

  /** Borra una parte y todo lo que cuelga de ella. @param {string} id */
  remove(id) {
    this.#paso(() => {
      const p = this.own(id);
      const guardadas = this.realSubtree(id);
      this.#sinDependientes(guardadas);
      const ids = this.subtree(id);
      if (p.parent) {
        const pa = this.ownAssembly(p.parent);
        this.#patch(p.parent, { children: pa.children.filter((c) => c !== id) });
      }
      for (const k of guardadas) this.parts.delete(k);
      this.emit('remove', ids);
      this.#limpiarRecortes();
      this.#limpiarRelaciones();
    });
  }

  // ---------- instancias ----------

  /**
   * Una instancia de una pieza o de un ensamble: la misma parte colocada otra vez. Editar la
   * fuente se ve en todas sus instancias; la instancia solo tiene su lugar. Nace encima de
   * la fuente (en su mismo ensamble, si lo tiene), salvo que se diga otra cosa.
   * Instanciar una instancia da otra instancia de la misma fuente.
   * @param {string} srcId
   * @param {{ name?: string, parent?: string | null, placement?: Frame }} [opts]
   *   `parent`: el ensamble donde queda (el de la fuente si no se dice; null: suelta).
   *   `placement`: una transformación rígida, en el mundo, que se le aplica a la colocación
   *   de la fuente (la instancia queda movida y girada por ella).
   * @returns {string} el id de la instancia
   */
  instantiate(srcId, { name, parent, placement } = {}) {
    return this.#paso(() => {
      const src = this.own(srcId);
      const base = src.kind === 'instance' ? this.#sourceOf(src) : src;
      const dest = parent === undefined ? src.parent : parent;
      if (dest !== null) {
        this.ownAssembly(dest);
        if (this.#alcance(base.id).has(dest)) throw new Error(`no se puede instanciar ${base.id} adentro de ${dest}: quedaría adentro de sí misma`);
      }
      const mundo = this.worldFrame(srcId);
      const id = this.nextId('instance');
      /** @type {InstanceDef} */
      const inst = {
        kind: 'instance', id, name: name || src.name, parent: dest,
        frame: compose(invert(this.parentWorld(dest)), placement ? compose(placement, mundo) : mundo),
        source: base.id,
      };
      this.#put(inst);
      if (dest) this.#patch(dest, { children: [...this.ownAssembly(dest).children, id] });
      this.emit('add', [id]);
      return id;
    });
  }

  /**
   * Suelta una instancia: pasa a ser una pieza o un ensamble de verdad, copia de lo que era
   * su fuente, que ya no la sigue. Conserva su id (la app guarda ids) y su lugar. Lo de
   * adentro, si es un ensamble, son partes nuevas.
   * @param {string} id
   */
  detach(id) {
    this.#paso(() => {
      const inst = this.own(id);
      if (inst.kind !== 'instance') throw new Error(`${id} no es una instancia`);
      const src = this.#sourceOf(inst);
      const antes = this.subtree(id);
      if (src.kind === 'piece') {
        /** @type {PieceDef} */
        const real = {
          kind: 'piece', id, name: inst.name, parent: inst.parent, frame: clone(inst.frame),
          size: [...src.size], axes: { ...src.axes }, material: src.material, shape: src.shape ? clone(src.shape) : null,
          operations: clone(src.operations ?? []),
        };
        this.#put(real);
        this.#copiarRelaciones(new Map([[src.id, id]]));
      } else {
        /** @type {AssemblyDef} */
        const real = { kind: 'assembly', id, name: inst.name, parent: inst.parent, frame: clone(inst.frame), children: [] };
        this.#put(real);
        /** @type {Map<string, string>} */
        const copias = new Map();
        this.#patch(id, { children: src.children.map((c) => this.#copiar(c, id, copias)) });
        copias.set(src.id, id);
        this.#remapear(copias);
        this.#copiarRelaciones(copias);
      }
      this.emit('detach', [...new Set([...antes, ...this.subtree(id)])]);
      this.#limpiarRecortes();
    });
  }

  // ---------- colocar: solo tocan marcos, nunca una definición ----------

  /** Corre la parte `delta` (en la unidad del documento), medido en el mundo. @param {string} id @param {Vec3} delta */
  move(id, delta) {
    this.#paso(() => {
      const p = this.own(id);
      const d = rotate(transpose3(this.parentWorld(p.parent).r), delta); // al espacio del padre
      this.#patch(id, { frame: { r: p.frame.r, t: [p.frame.t[0] + d[0], p.frame.t[1] + d[1], p.frame.t[2] + d[2]] } });
      this.emit('move', this.subtree(id));
    });
  }

  /** Lleva el centro de la caja de la parte a `point`, en el mundo. @param {string} id @param {Vec3} point */
  moveTo(id, point) {
    const c = this.box(id, 'world').center;
    this.move(id, [point[0] - c[0], point[1] - c[1], point[2] - c[2]]);
  }

  /**
   * Gira la parte `deg` grados.
   *   axis: 'x' | 'y' | 'z' del mundo, o un vector del mundo.
   *   local: true → el eje es uno de los de la PIEZA (girar sobre su propio largo, p. ej.).
   *   pivot: 'center' (el centro de su caja, por defecto), 'origin' (su origen) o un punto
   *          del mundo.
   * @param {string} id @param {Axis | Vec3} axis @param {number} deg
   * @param {{ pivot?: 'center' | 'origin' | Vec3, local?: boolean }} [opts]
   */
  rotate(id, axis, deg, { pivot = 'center', local = false } = {}) {
    this.#paso(() => {
      const p = this.own(id);
      const w = this.worldFrame(id);
      /** @type {Axis | Vec3} */
      let ax = axis;
      if (local) {
        if (Array.isArray(axis)) throw new Error('con local: true el eje va como x, y o z de la pieza');
        const k = axisIndex(axis);
        ax = [w.r[k], w.r[3 + k], w.r[6 + k]]; // la columna k: el eje local, visto desde el mundo
      }
      const pv = pivot === 'center' ? this.box(id, 'world').center : pivot === 'origin' ? w.t : pivot;
      const w2 = turn(w, ax, deg, pv);
      this.#patch(id, { frame: compose(invert(this.parentWorld(p.parent)), w2) });
      this.emit('rotate', this.subtree(id));
    });
  }

  /**
   * Aplica una transformación rígida, expresada en el MUNDO, a una parte. Es el verbo del
   * que salen todos los demás: mover y girar son transformaciones. Solo cambia el marco.
   * @param {string} id @param {Frame} T
   */
  transform(id, T) {
    this.#paso(() => {
      const p = this.own(id);
      this.#patch(id, { frame: compose(invert(this.parentWorld(p.parent)), compose(T, this.worldFrame(id))) });
      this.emit('transform', this.subtree(id));
    });
  }

  /** @param {string} id @param {string} name */
  rename(id, name) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('el nombre no puede estar vacío');
    this.#paso(() => {
      this.own(id);
      this.#patch(id, { name: name.trim() });
      this.emit('rename', [id]);
    });
  }

  /**
   * Ancla una parte al mundo (o la suelta). Una parte fija no la mueve el asentador de relaciones;
   * lo demás (`move`, `transform`) lo decide quien llama. Un ensamble fijo fija todo lo de adentro.
   * @param {string} id @param {boolean} fixed
   */
  setFixed(id, fixed) {
    if (typeof fixed !== 'boolean') throw new TypeError(`fixed inválido: ${String(fixed)} (va true o false)`);
    this.#paso(() => {
      const p = { ...this.own(id) };
      if (fixed) p.fixed = true; else delete p.fixed;
      this.#put(/** @type {StoredPart} */ (p));
      this.emit('fixed', [id]);
    });
  }

  /** ¿Es fija, o está adentro de un ensamble fijo? @param {string} id */
  isFixed(id) {
    for (let p = this.parts.get(id); p; p = p.parent ? this.parts.get(p.parent) : undefined) if (p.fixed) return true;
    return false;
  }

  /** @param {string} id @param {string} material */
  setMaterial(id, material) {
    this.#paso(() => {
      this.ownPiece(id);
      this.#patch(id, { material });
      this.emit('material', [id]);
    });
  }

  /**
   * Cambia la forma del bruto (perfil, torneado; null: una caja). Las medidas y las operaciones
   * quedan como estaban.
   * @param {string} id @param {unknown} shape
   */
  setShape(id, shape) {
    this.#paso(() => {
      this.ownPiece(id);
      this.#patch(id, { shape: checkShape(shape) });
      this.emit('shape', [id]);
    });
  }

  /**
   * Cambia las medidas de una pieza (en su marco local: x, y, z). No toca cuál eje es el
   * largo: un ancho que pasa al largo no da vuelta la pieza sola.
   * @param {string} id @param {Vec3} size
   */
  resize(id, size) {
    this.#paso(() => {
      this.ownPiece(id);
      if (size.length !== 3 || size.some((s) => !(s > 0))) throw new Error(`medidas inválidas: ${JSON.stringify(size)}`);
      this.#patch(id, { size: [...size] });
      this.emit('resize', [id]);
    });
  }

  // ---------- operaciones: lo que se le hace al bruto ----------

  /** Revisa una operación; un recorte, además, contra una pieza que exista y no sea ella misma. @param {string} pieceId @param {unknown} op */
  #checkOp(pieceId, op) {
    const o = checkOperation(op);
    if (o.kind === 'trim') {
      if (o.against === pieceId) throw new Error(`${pieceId} no se puede recortar contra sí misma`);
      this.piece(o.against);
    }
    return o;
  }

  /** ¿Existe esa pieza (también una de adentro de una instancia)? @param {string} id */
  #existe(id) {
    try { this.piece(id); return true; } catch { return false; }
  }

  /**
   * Saca los recortes que apuntan a una pieza que ya no está (se borró, o era de adentro de una
   * instancia que se soltó). Va en el mismo paso: deshacer devuelve la pieza y el recorte.
   */
  #limpiarRecortes() {
    /** @type {string[]} */
    const cambiadas = [];
    for (const p of [...this.parts.values()]) {
      if (p.kind !== 'piece' || !p.operations?.some((o) => o.kind === 'trim')) continue;
      const quedan = p.operations.filter((o) => o.kind !== 'trim' || this.#existe(o.against));
      if (quedan.length !== p.operations.length) {
        this.#patch(p.id, { operations: quedan });
        cambiadas.push(p.id);
      }
    }
    if (cambiadas.length) this.emit('operation', cambiadas);
  }

  /** @param {Operation[]} ops */
  #siguienteOp(ops) {
    return `O-${Math.max(0, ...ops.map((o) => Number(o.id.slice(2)) || 0)) + 1}`;
  }

  /** @param {string} pieceId @param {string} opId */
  #indiceOp(pieceId, opId) {
    const ops = this.ownPiece(pieceId).operations ?? [];
    const i = ops.findIndex((o) => o.id === opId);
    if (i < 0) throw new Error(`${pieceId} no tiene la operación ${opId}`);
    return { ops, i };
  }

  /**
   * Agrega una operación al final de la lista de una pieza. Devuelve su id, único dentro de
   * la pieza. No cambia el bruto: ni sus medidas ni su caja.
   * @param {string} pieceId @param {OperationSpec} op @returns {string}
   */
  addOperation(pieceId, op) {
    return this.#paso(() => {
      const ops = this.ownPiece(pieceId).operations ?? [];
      const nueva = /** @type {Operation} */ ({ id: this.#siguienteOp(ops), ...this.#checkOp(pieceId, op) });
      this.#patch(pieceId, { operations: [...ops, nueva] });
      this.emit('operation', [pieceId]);
      return nueva.id;
    });
  }

  /** Reemplaza una operación, en su lugar y con su id. @param {string} pieceId @param {string} opId @param {OperationSpec} op */
  updateOperation(pieceId, opId, op) {
    this.#paso(() => {
      const { ops, i } = this.#indiceOp(pieceId, opId);
      const nueva = /** @type {Operation} */ ({ id: opId, ...this.#checkOp(pieceId, op) });
      this.#patch(pieceId, { operations: ops.map((o, k) => (k === i ? nueva : o)) });
      this.emit('operation', [pieceId]);
    });
  }

  /** Saca una operación: la forma vuelve a la de antes de ella. @param {string} pieceId @param {string} opId */
  removeOperation(pieceId, opId) {
    this.#paso(() => {
      const { ops, i } = this.#indiceOp(pieceId, opId);
      this.#patch(pieceId, { operations: ops.filter((_, k) => k !== i) });
      this.emit('operation', [pieceId]);
    });
  }

  /**
   * Copia real de lo guardado en `srcId` y de todo lo que cuelga de ello, bajo `parent`.
   * @param {string} srcId @param {string | null} parent @param {Map<string, string>} copias viejo → nuevo
   * @returns {string}
   */
  #copiar(srcId, parent, copias) {
    const src = this.own(srcId);
    const nid = this.nextId(src.kind);
    /** @type {any} */
    const n = clone(src);
    n.id = nid;
    n.parent = parent;
    if (n.kind === 'assembly') n.children = [];
    this.#put(n);
    copias.set(srcId, nid);
    if (src.kind === 'assembly') this.#patch(nid, { children: src.children.map((c) => this.#copiar(c, nid, copias)) });
    return nid;
  }

  /** Una instancia copiada cuya fuente también se copió mira a la copia: lo copiado se basta a sí mismo. @param {Map<string, string>} copias */
  #remapear(copias) {
    for (const nid of copias.values()) {
      const n = this.parts.get(nid);
      if (n?.kind === 'instance' && copias.has(n.source)) this.#patch(nid, { source: copias.get(n.source) });
    }
  }

  /**
   * Copia la parte con todo lo que cuelga de ella —marcos, giros, ensambles adentro— en
   * el mismo lugar y bajo el mismo padre. Como el giro vive en el marco y no en las
   * medidas, la copia sale exactamente igual: no hay nada que reconstruir. La copia es
   * independiente de la original (para que sigan a la original, se instancia). Copiar una
   * instancia da otra instancia de la misma fuente.
   * @param {string} id @returns {string} el id de la copia
   */
  duplicate(id) {
    return this.#paso(() => {
      const src = this.own(id);
      /** @type {Map<string, string>} */
      const copias = new Map();
      const nid = this.#copiar(id, src.parent, copias);
      this.#remapear(copias);
      this.#copiarRelaciones(copias);
      if (src.parent) this.#patch(src.parent, { children: [...this.ownAssembly(src.parent).children, nid] });
      this.emit('add', this.subtree(nid));
      return nid;
    });
  }

  // ---------- relaciones ----------
  // Se guardan entre partes guardadas. Las de adentro de la fuente de una instancia se VEN también
  // en la instancia, con ids de camino (`I-1/R-2`, entre `I-1/P-3` e `I-1/P-4`), y se leen como
  // cualquier otra; se cambian en la fuente.

  /** @param {RelationDef} rec */
  #putRel(rec) {
    this.relations.set(rec.id, deepFreeze(rec));
  }

  /** @param {unknown[]} parts */
  #checkRelParts(parts) {
    if (!Array.isArray(parts) || !parts.length) throw new TypeError('una relación va entre partes: parts es una lista de ids');
    for (const p of parts) {
      if (typeof p !== 'string') throw new TypeError(`parte inválida en la relación: ${String(p)}`);
      if (!this.parts.has(p)) {
        if (p.includes('/') && this.parts.has(p.split('/')[0])) throw new Error(`${p} es de adentro de la instancia ${p.split('/')[0]}: la relación va en su fuente, o se suelta la instancia con detach()`);
        throw new Error(`no existe la parte ${p}`);
      }
    }
    return /** @type {string[]} */ ([...parts]);
  }

  /**
   * Una relación nueva. `kind` es su tipo (el modelo no lo interpreta); `data`, sus datos (van
   * como JSON); `ops`, las operaciones de piezas que son de ella.
   * @param {{ kind: string, parts: string[], data?: Record<string, any>, ops?: [string, string][], meta?: Record<string, any> | null }} spec
   * @returns {string} el id
   */
  addRelation({ kind, parts, data = {}, ops = [], meta = null }) {
    if (typeof kind !== 'string' || !kind) throw new TypeError('una relación necesita su kind');
    return this.#paso(() => {
      const ps = this.#checkRelParts(parts);
      const id = this.nextId('relation');
      this.#putRel(relacion({ id, kind, parts: ps, data, ops, broken: null, meta }));
      this.emit('relation', [id, ...ps]);
      return id;
    });
  }

  /**
   * Cambia los datos, las operaciones, el estado o lo de la app de una relación guardada. Pasar
   * a rota avisa con 'relation-broken'.
   * @param {string} id @param {{ data?: Record<string, any>, ops?: [string, string][], broken?: string | null, meta?: Record<string, any> | null }} cambios
   */
  updateRelation(id, cambios) {
    this.#paso(() => {
      const r = this.ownRelation(id);
      const n = relacion({ ...r, ...cambios });
      this.#putRel(n);
      this.emit(n.broken && !r.broken ? 'relation-broken' : 'relation', [id, ...n.parts]);
    });
  }

  /** Borra una relación, con las operaciones que son de ella. @param {string} id */
  removeRelation(id) {
    this.#paso(() => {
      const r = this.ownRelation(id);
      this.relations.delete(id);
      this.#sacarOps(r.ops);
      this.emit('relation-remove', [id, ...r.parts.filter((p) => this.parts.has(p))]);
    });
  }

  /** Saca operaciones de piezas que sigan estando. @param {readonly (readonly [string, string])[]} ops */
  #sacarOps(ops) {
    /** @type {Map<string, Set<string>>} */
    const por = new Map();
    for (const [p, o] of ops) {
      if (!por.has(p)) por.set(p, new Set());
      /** @type {Set<string>} */ (por.get(p)).add(o);
    }
    for (const [p, os] of por) {
      const rec = this.parts.get(p);
      if (rec?.kind !== 'piece' || !rec.operations?.some((o) => os.has(o.id))) continue;
      this.#patch(p, { operations: rec.operations.filter((o) => !os.has(o.id)) });
      this.emit('operation', [p]);
    }
  }

  /** Una relación guardada, para cambiarla. @param {string} id @returns {RelationDef} */
  ownRelation(id) {
    const r = this.relations.get(id);
    if (r) return r;
    if (id.includes('/')) throw new Error(`${id} es de adentro de una instancia: se cambia en su fuente, o se suelta la instancia con detach()`);
    throw new Error(`no existe la relación ${id}`);
  }

  /** Una relación: guardada, o de adentro de una instancia (por su id de camino). @param {string} id @returns {RelationDef} */
  relation(id) {
    const r = this.relations.get(id) ?? (id.includes('/') ? this.allRelations().find((x) => x.id === id) : undefined);
    if (!r) throw new Error(`no existe la relación ${id}`);
    return r;
  }

  /**
   * Todas las relaciones: las guardadas y, por cada instancia, las de adentro de su fuente, con
   * ids de camino.
   * @returns {RelationDef[]}
   */
  allRelations() {
    const out = [...this.relations.values()];
    if (!this.relations.size) return out;
    /** @param {string} vista el id con que se ve la instancia @param {string} fuente */
    const verAdentro = (vista, fuente) => {
      /** @type {Map<string, string>} id guardado → cómo se ve adentro de la instancia */
      const caminos = new Map([[fuente, vista]]);
      /** @param {string} id @param {string} camino */
      const bajar = (id, camino) => {
        const p = this.parts.get(id);
        if (p?.kind !== 'assembly') return;
        for (const c of p.children) {
          caminos.set(c, `${camino}/${c}`);
          bajar(c, `${camino}/${c}`);
        }
      };
      bajar(fuente, vista);
      for (const r of this.relations.values()) {
        if (!r.parts.every((p) => caminos.has(p))) continue;
        out.push(deepFreeze({ ...r, id: `${vista}/${r.id}`, parts: r.parts.map((p) => /** @type {string} */ (caminos.get(p))), ops: [] }));
      }
      for (const [id, camino] of caminos) {
        const p = this.parts.get(id);
        if (p?.kind === 'instance') verAdentro(camino, p.source);
      }
    };
    for (const p of [...this.parts.values()]) if (p.kind === 'instance') verAdentro(p.id, p.source);
    return out;
  }

  /** Las relaciones donde está una parte (por su id, también uno de camino). @param {string} partId @returns {RelationDef[]} */
  relationsOf(partId) {
    return this.allRelations().filter((r) => r.parts.includes(partId));
  }

  /** Borra las relaciones que apuntan a partes que ya no están, con sus operaciones. Va en el mismo paso. */
  #limpiarRelaciones() {
    for (const r of [...this.relations.values()]) {
      if (r.parts.every((p) => this.parts.has(p))) continue;
      this.relations.delete(r.id);
      this.#sacarOps(r.ops);
      this.emit('relation-remove', [r.id, ...r.parts.filter((p) => this.parts.has(p))]);
    }
  }

  /**
   * Copia las relaciones cuyas partes se copiaron todas, con los ids nuevos. A una pieza copiada
   * se le sacan las operaciones de una relación que no se copió (la unión con algo que quedó
   * afuera): la copia no tiene esa unión.
   * @param {Map<string, string>} copias viejo → nuevo
   */
  #copiarRelaciones(copias) {
    const nuevas = [];
    for (const r of [...this.relations.values()]) {
      const enCopia = r.ops.filter(([p]) => copias.has(p));
      if (r.parts.every((p) => copias.has(p))) {
        const id = this.nextId('relation');
        /** @param {string} p */
        const m = (p) => /** @type {string} */ (copias.get(p));
        this.#putRel(relacion({ ...r, id, parts: r.parts.map(m), ops: r.ops.filter(([p]) => copias.has(p)).map(([p, o]) => [m(p), o]) }));
        nuevas.push(id);
      } else if (enCopia.length) {
        this.#sacarOps(enCopia.map(([p, o]) => [/** @type {string} */ (copias.get(p)), o]));
      }
    }
    if (nuevas.length) this.emit('relation', nuevas);
  }

  // ---------- guardar ----------

  toJSON() {
    return {
      version: [...this.parts.values()].some((p) => p.fixed) ? VERSION_DOCUMENTO : 5, units: this.units, counters: { ...this.counters },
      parts: [...this.parts.values()].map(clone), relations: [...this.relations.values()].map(clone),
    };
  }

  /**
   * Carga un documento. La unidad es la del documento: uno guardado antes de que se guardara la
   * unidad estaba en cm, que era lo único que había. Cargar un documento borra el historial
   * (no se puede deshacer una carga).
   * @param {{ units?: Unit, counters: Record<string, number>, parts: StoredPart[], relations?: RelationDef[] }} data
   */
  load(data) {
    this.#sinTransaccion('cargar un documento');
    const v = /** @type {{ version?: unknown }} */ (data).version;
    if (typeof v === 'number' && v > VERSION_DOCUMENTO) {
      throw new Error(`el documento es de la versión ${v} del formato, más nueva que la que lee este SDK (${VERSION_DOCUMENTO}): hay que actualizar el SDK`);
    }
    const units = checkUnit(data.units ?? 'cm');
    const parts = new Map(data.parts.map((p) => [p.id, /** @type {StoredPart} */ (deepFreeze(clone(p)))]));
    validate(parts);
    const relations = new Map((data.relations ?? []).map((r) => [r.id, deepFreeze(relacion(r))]));
    validateRelations(relations, parts);
    const ids = [...this.parts.keys(), ...this.relations.keys()];
    this.units = units;
    this.parts = parts;
    this.relations = relations;
    this.counters = { piece: 0, assembly: 0, instance: 0, relation: 0, ...data.counters };
    this.#pasos.length = 0; // un documento nuevo no tiene pasado
    this.#rehacer.length = 0;
    this.emit('load', [...ids, ...this.parts.keys(), ...this.relations.keys()]);
  }

  /** El árbol como texto, para la consola. @param {string | null} [id] @param {number} [depth] @returns {string} */
  tree(id = null, depth = 0) {
    const pad = '  '.repeat(depth);
    if (id === null) return this.roots().map((p) => this.tree(p.id, 0)).join('\n');
    const p = this.get(id);
    const f = this.worldFrame(id);
    const giro = isQuarterTurn(f.r) ? (f.r.join() === '1,0,0,0,1,0,0,0,1' ? '' : ' ⟳90°') : ' ⟳';
    const copia = this.parts.get(id)?.kind === 'instance' ? ` ⧉ ${p.source}` : '';
    if (p.kind === 'piece') {
      const d = this.dims(id);
      return `${pad}▭ ${p.id} ${p.name}  ${d.length} × ${d.width} × ${d.thickness} ${p.material}${giro}${copia}`;
    }
    // lo de adentro de una instancia es el de su fuente: no se repite
    const hijos = copia ? [] : p.children.map((c) => this.tree(c, depth + 1));
    return [`${pad}▣ ${p.id} ${p.name}${giro}${copia}`, ...hijos].join('\n');
  }
}
