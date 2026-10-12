// Adaptador de three: espeja el modelo en una escena. Es lo único del SDK que importa three.
//
// No es dueño de nada. Escucha los eventos del modelo y, en el cuadro siguiente, deja cada
// malla donde el modelo dice: su matriz es el marco en el mundo que calcula el modelo. three
// no decide dónde está ninguna pieza.
//
// Tampoco crea renderer, cámara ni controles: eso es de la app. Recibe una escena (o
// cualquier Object3D) y cuelga ahí un grupo con las piezas y las capas de ayuda.
//
//   import { createWorkshop } from '../src/index.js';
//   import { createThreeView } from '../adapters/three/viewer.js';
//   const taller = createWorkshop();
//   const vista = createThreeView(taller, { scene });
//   vista.show.contacts(true);
//
// Las etiquetas son CSS2DObject: para verlas, la app tiene que dibujar también con un
// CSS2DRenderer (three/addons/renderers/CSS2DRenderer.js).
//
// La forma y el material de cada pieza los decide la app, si quiere, con dos ganchos:
//   geometryFor(piece) → BufferGeometry en el marco LOCAL de la pieza, centrada en su origen
//   materialFor(piece) → Material
// Por defecto: la forma que resulta de la pieza (su bruto —caja, perfil o torneado— con sus
// operaciones) y un gris neutro para todas, sea cual sea su
// `material`. Si la forma no se puede calcular (p. ej. hace falta un kernel que la app no
// pasó), se dibuja la caja y el motivo queda en `mesh.geometry.userData.solidError`. El adaptador no conoce catálogos de materiales de ninguna app: eso es de
// `materialFor`.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { toColumns4 } from '../../src/frame.js';
import { convertLength } from '../../src/units.js';

/** @typedef {ReturnType<typeof import('../../src/index.js').createWorkshop>} Workshop */
/** @typedef {import('../../src/model.js').PieceDef} PieceDef */

const GRIS_NEUTRO = '#9a9a92';

/**
 * @param {Workshop} workshop
 * @param {{
 *   scene: THREE.Object3D,
 *   geometryFor?: (piece: PieceDef) => THREE.BufferGeometry,
 *   materialFor?: (piece: PieceDef) => THREE.Material | THREE.Material[],
 *   colors?: { edge?: string, highlight?: string, contact?: string, collision?: string },
 * }} opts
 */
export function createThreeView(workshop, { scene, geometryFor, materialFor, colors = {} }) {
  const model = workshop.model;
  // los tamaños de las ayudas (ejes, tubos, etiquetas) están pensados en cm: se llevan a la unidad del documento
  const u = convertLength(1, 'cm', model.units);
  const col = { edge: '#3b2a1e', highlight: '#d6461f', contact: '#2e9a5c', collision: '#d6461f', ...colors };
  const caja = (/** @type {PieceDef} */ p) => new THREE.BoxGeometry(p.size[0], p.size[1], p.size[2]);
  const geo = geometryFor || ((/** @type {PieceDef} */ p) => {
    if (!p.operations?.length && !p.shape) return caja(p);
    try {
      const m = workshop.part(p.id).local.solid;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3));
      g.setIndex([...m.indices]);
      g.computeVertexNormals();
      return g;
    } catch (e) {
      const g = caja(p);
      g.userData.solidError = e instanceof Error ? e.message : String(e);
      return g;
    }
  });
  const mat = materialFor || (() => new THREE.MeshStandardMaterial({ color: GRIS_NEUTRO, roughness: 0.8 }));

  const root = new THREE.Group();
  root.name = 'threejs-cad-sdk';
  const piezas = new THREE.Group();
  const capas = new THREE.Group();
  root.add(piezas, capas);
  scene.add(root);

  /** @type {Map<string, { mesh: THREE.Mesh, edges: THREE.LineSegments, key: string, forma: unknown }>} */
  const mallas = new Map();
  const ver = { axes: false, boxes: false, labels: false, contacts: false };
  /** @type {Set<string>} */
  let resaltadas = new Set();
  /** @type {boolean} */
  let pendiente = false;

  /** @param {{ mesh: THREE.Mesh, edges: THREE.LineSegments }} e */
  function tirar(e) {
    piezas.remove(e.mesh);
    e.mesh.geometry.dispose();
    e.edges.geometry.dispose();
  }

  function sync() {
    const vivas = new Set();
    // las piezas de adentro de una instancia se dibujan como cualquier otra, con su id de camino
    for (const p of model.allPieces()) {
      vivas.add(p.id);
      const key = JSON.stringify([p.size, p.shape, p.material, p.operations]);
      // la forma que resulta puede cambiar sin que cambie la definición (un recorte, si se mueve la otra pieza)
      let forma = null;
      if (!geometryFor && (p.shape || p.operations?.length)) { try { forma = workshop.part(p.id).local.solid; } catch { forma = null; } }
      let e = mallas.get(p.id);
      if (!e || e.key !== key || e.forma !== forma) {
        if (e) tirar(e);
        const mesh = new THREE.Mesh(geo(p), mat(p));
        mesh.matrixAutoUpdate = false;
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.userData.id = p.id;
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 25), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.6 }));
        mesh.add(edges);
        piezas.add(mesh);
        e = { mesh, edges, key, forma };
        mallas.set(p.id, e);
      }
      e.mesh.matrix.fromArray(toColumns4(model.worldFrame(p.id)));
      e.mesh.matrixWorldNeedsUpdate = true;
      /** @type {THREE.LineBasicMaterial} */ (e.edges.material).color.set(resaltadas.has(p.id) ? col.highlight : col.edge);
    }
    for (const [id, e] of mallas) if (!vivas.has(id)) { tirar(e); mallas.delete(id); }
    dibujarCapas();
  }

  function dibujarCapas() {
    for (const o of [...capas.children]) {
      capas.remove(o);
      o.traverse((x) => {
        if (x instanceof CSS2DObject) x.element.remove();
        if (x instanceof THREE.Mesh || x instanceof THREE.LineSegments) x.geometry.dispose();
      });
    }
    for (const id of model.parts.keys()) {
      const p = model.get(id);
      const caja = model.box(id, 'world');
      const ensamble = p.kind === 'assembly';
      if (ver.axes) {
        const ejes = new THREE.AxesHelper(Math.max(8 * u, Math.min(40 * u, Math.max(...caja.size) * 0.35)));
        ejes.matrixAutoUpdate = false;
        ejes.matrix.fromArray(toColumns4(model.worldFrame(id)));
        capas.add(ejes);
      }
      if (ver.boxes) {
        capas.add(new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(...caja.min), new THREE.Vector3(...caja.max)), ensamble ? col.highlight : col.edge));
      }
      if (ver.labels) {
        const div = document.createElement('div');
        div.className = ensamble ? 'cad-label cad-label--assembly' : 'cad-label';
        div.textContent = `${id} · ${p.name}`;
        const o = new CSS2DObject(div);
        o.position.set(caja.center[0], ensamble ? caja.max[1] + 4 * u : caja.center[1], caja.center[2]);
        capas.add(o);
      }
    }
    if (ver.contacts) {
      for (const c of workshop.contacts()) {
        if (c.kind === 'face') capas.add(poligono(c.points, col.contact, 0.75));
        else if (c.kind === 'edge') capas.add(tubo(c.points[0], c.points[1], col.contact));
        else capas.add(punto(c.points[0], col.contact));
      }
      for (const i of workshop.collisions()) for (const f of i.faces) capas.add(poligono(f, col.collision, 0.55));
    }
  }

  // ---------- formas para los contactos: por encima de todo, para que se vean ----------
  /** @param {readonly { x: number, y: number, z: number }[]} pts @param {string} color @param {number} opacity */
  function poligono(pts, color, opacity) {
    /** @type {number[]} */
    const pos = [];
    for (let i = 1; i < pts.length - 1; i++) for (const q of [pts[0], pts[i], pts[i + 1]]) pos.push(q.x, q.y, q.z);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthTest: false }));
    m.renderOrder = 10;
    return m;
  }
  /** @param {{ x: number, y: number, z: number }} a @param {{ x: number, y: number, z: number }} b @param {string} color */
  function tubo(a, b, color) {
    const A = new THREE.Vector3(a.x, a.y, a.z), B = new THREE.Vector3(b.x, b.y, b.z);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.5 * u, 0.5 * u, A.distanceTo(B), 12), new THREE.MeshBasicMaterial({ color, depthTest: false }));
    m.position.copy(A).add(B).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
    m.renderOrder = 10;
    return m;
  }
  /** @param {{ x: number, y: number, z: number }} a @param {string} color */
  function punto(a, color) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(u, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false }));
    m.position.set(a.x, a.y, a.z);
    m.renderOrder = 10;
    return m;
  }

  // muchos eventos seguidos (una demo, un Transform.apply) → una sola sincronización por cuadro
  const off = workshop.on(() => {
    if (pendiente) return;
    pendiente = true;
    requestAnimationFrame(() => { pendiente = false; sync(); });
  });

  /** @param {keyof typeof ver} que @param {boolean} [on] */
  const llave = (que, on = true) => { ver[que] = on !== false; dibujarCapas(); return ver[que]; };

  sync();
  return {
    /** El grupo que el adaptador cuelga en la escena. */
    group: root,
    /** Las mallas por id de pieza (para elegir con un raycaster, por ejemplo). Las de adentro de una instancia llevan su id de camino (`I-1/P-2`). */
    meshes: mallas,
    /** Sincroniza ya, sin esperar al próximo cuadro. */
    sync,
    show: {
      /** Ejes de cada marco: rojo x, verde y, azul z. @param {boolean} [on] */
      axes: (on) => llave('axes', on),
      /** Caja en el mundo de cada parte. @param {boolean} [on] */
      boxes: (on) => llave('boxes', on),
      /** id y nombre de cada parte (necesita un CSS2DRenderer). @param {boolean} [on] */
      labels: (on) => llave('labels', on),
      /** Verde donde se tocan, rojo donde se meten una en otra. @param {boolean} [on] */
      contacts: (on) => llave('contacts', on),
    },
    /** Resalta partes (con todo lo de adentro). Sin argumentos, apaga. @param {...(string | { id: string })} partes */
    highlight(...partes) {
      resaltadas = new Set(partes.flatMap((x) => model.subtree(typeof x === 'string' ? x : x.id)));
      sync();
    },
    /** Rehace todas las mallas (p. ej. si cambió lo que devuelven los ganchos). */
    rebuild() { for (const e of mallas.values()) tirar(e); mallas.clear(); sync(); },
    /** Se desengancha del modelo y saca todo de la escena. */
    dispose() {
      off();
      for (const e of mallas.values()) tirar(e);
      mallas.clear();
      for (const o of [...capas.children]) capas.remove(o);
      scene.remove(root);
    },
  };
}
