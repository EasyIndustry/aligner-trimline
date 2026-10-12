// El visor 3D: el motor de render vendorizado, la malla del movimiento que se mira, los
// controladores y la curva. De acá sale también el rayo del mouse contra la malla.
import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { createEngine } from '../vendor/threejs-render-engine/src/index.js';
import { createMaterialEngine } from '../vendor/threejs-material-engine/adapters/three/engine.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export const COLORES = { v: 0x1f6fd0, l: 0xd9741a, e: 0x1e9a4a, inversa: 0x666666, seleccion: 0xffd400, curva: 0xff3b4e, manija: 0x7df9ff };
const RADIO_PX = 6;

export async function crearVisor(contenedor) {
  const motor = createEngine(contenedor, { preset: 'studio', area: 90, quality: 'media' });
  motor.show({ grid: false, floor: false, shadows: false, fog: false });
  motor.tweak({ background: '#3b3b3b' });      // fondo gris oscuro: el yeso claro resalta
  // clic derecho orbita, shift + clic derecho desplaza, la rueda hace zoom; el izquierdo queda
  // libre para marcar y mover puntos (shift + derecho va primero: gana la primera regla)
  motor.view.input({
    scheme: {
      mouse: [{ button: 2, shift: true, action: 'pan' }, { button: 2, action: 'orbit' }],
      wheel: 'zoom',
      touch: { 1: 'orbit', 2: 'pan-zoom' },
    },
    zoomToCursor: true,
  });

  // todo lo del modelo cuelga de acá, en las coordenadas del archivo; el grupo lo para con la
  // base hacia abajo (el motor tiene +Y arriba)
  const raiz = new THREE.Group();
  motor.content.add(raiz);

  let material = /** @type {THREE.Material} */ (new THREE.MeshStandardMaterial({ color: 0xe6dfd2, roughness: 0.65 }));
  try {
    material = await createMaterialEngine(motor.renderer).material({ name: 'Yeso', channels: { baseColor: '#e6dfd2', roughness: 0.65 } });
  } catch (e) { console.warn('motor de materiales:', e); }
  // la malla un pelo hacia atrás en profundidad, para que la curva apoyada encima se vea entera
  material.polygonOffset = true; material.polygonOffsetFactor = 1; material.polygonOffsetUnits = 2;

  const malla = new THREE.Mesh(new THREE.BufferGeometry(), material);
  malla.visible = false;
  raiz.add(malla);

  const geometrias = new Map();
  /** @param {string} id @param {{ posiciones: Float32Array, indices: Uint32Array }} datos */
  function registrar(id, datos) {
    if (geometrias.has(id)) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(datos.posiciones, 3));
    g.setIndex(new THREE.BufferAttribute(datos.indices, 1));
    g.computeVertexNormals();
    g.computeBoundsTree();
    geometrias.set(id, g);
  }

  /** Para el maxilar con `arriba` hacia +Y, centrado y con la base en el piso. */
  function orientar(id, arriba) {
    const g = geometrias.get(id);
    if (!g) return;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...arriba).normalize(), new THREE.Vector3(0, 1, 0));
    const caja = new THREE.Box3(), p = new THREE.Vector3(), pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) caja.expandByPoint(p.fromBufferAttribute(pos, i).applyQuaternion(q));
    const c = caja.getCenter(new THREE.Vector3());
    raiz.quaternion.copy(q);
    raiz.position.set(-c.x, -caja.min.y, -c.z);
    raiz.updateMatrixWorld(true);
  }

  function mostrar(id) {
    const g = id && geometrias.get(id);
    malla.visible = !!g;
    if (g) malla.geometry = g;
  }

  function encuadrar() {
    if (malla.visible) motor.view.go('iso', { fit: [malla], margin: 1.25, animate: false });
  }

  // ---------- controladores y curva ----------
  const esfera = new THREE.SphereGeometry(1, 16, 12);
  const matPunto = Object.fromEntries(Object.entries(COLORES).map(([k, color]) => [k, new THREE.MeshBasicMaterial({ color, depthTest: k !== 'manija' })]));
  const puntos = new THREE.Group();
  raiz.add(puntos);
  const matCurva = new LineMaterial({ color: COLORES.curva, linewidth: 2.5 });
  const matManija = new LineMaterial({ color: COLORES.manija, linewidth: 1.5, depthTest: false });
  const cubo = new THREE.BoxGeometry(1.6, 1.6, 1.6);
  let lineas = /** @type {Line2[]} */ ([]);
  /** Las manijas del punto elegido: [{ lado: 'a' | 'b', malla, clave }] */
  let manijas = /** @type {{ lado: string, malla: THREE.Mesh, clave: number[] }[]} */ ([]);
  /** @type {Map<string, THREE.Mesh>} */ const porId = new Map();

  function punto(pos, mat, radio, id) {
    const m = new THREE.Mesh(esfera, mat);
    m.position.set(pos[0], pos[1], pos[2]);
    m.userData = { radio, noEdge: true, noAO: true, id };
    puntos.add(m);
    return m;
  }

  /**
   * Dibuja lo que resolvió el servidor para el movimiento que se mira.
   * Los puntos intermedios (crestas inversas) se agarran como los demás, con id `i:<clave>`.
   * @param {any} r { cerrada, tramos: [{ puntos, claves, info }], controladores } o null
   * @param {string | null} seleccion el punto elegido, el que muestra sus manijas
   * @param {Set<string>} [elegidos] los demás que se marcan como elegidos
   */
  function dibujar(r, seleccion, elegidos = new Set()) {
    puntos.clear();
    porId.clear();
    manijas = [];
    for (const l of lineas) { raiz.remove(l); l.geometry.dispose(); }
    lineas = [];
    if (!r) return;
    for (const c of r.controladores) {
      const sel = c.id === seleccion || elegidos.has(c.id);
      // con keyframe en este movimiento se ve lleno y más grande; sin él, es una posición interpolada
      porId.set(c.id, punto(c.pos, sel ? matPunto.seleccion : matPunto[c.tipo], (c.clave ? RADIO_PX : RADIO_PX * 0.65) * (sel ? 1.25 : 1), c.id));
    }
    for (const t of r.tramos) {
      t.info.forEach((info, i) => {
        if (info.clase !== 'inversa') return;
        const id = `i:${info.clave}`;
        porId.set(id, punto(t.claves.slice(i * 3, i * 3 + 3), id === seleccion ? matPunto.seleccion : matPunto.inversa, id === seleccion ? 4.5 : 3.5, id));
      });
      // las manijas Bézier del punto elegido: una línea a cada lado y un cuadradito para agarrar
      const i = t.info.findIndex((info) => info.clase === 'cresta' && info.id === seleccion);
      if (i >= 0) {
        const k = t.claves.slice(i * 3, i * 3 + 3);
        for (const lado of [0, 1]) {
          const h = t.manijas.slice(i * 6 + lado * 3, i * 6 + lado * 3 + 3);
          const guia = new Line2(new LineGeometry().setPositions([...k, ...h]), matManija);
          guia.userData = { noEdge: true, noAO: true };
          guia.frustumCulled = false;
          raiz.add(guia);
          lineas.push(guia);
          const m = punto(h, matPunto.manija, 4.5, null);
          m.geometry = cubo;
          manijas.push({ lado: lado ? 'b' : 'a', malla: m, clave: k });
        }
      }
      const pts = t.puntos.slice();
      if (r.cerrada) pts.push(pts[0], pts[1], pts[2]);
      if (pts.length < 6) continue;
      const linea = new Line2(new LineGeometry().setPositions(pts), matCurva);
      linea.userData = { noEdge: true, noAO: true };
      linea.frustumCulled = false;
      raiz.add(linea);
      lineas.push(linea);
    }
  }

  /** Dónde está dibujado un punto (coordenadas del archivo), o null. */
  const posicion = (id) => porId.get(id)?.position.toArray() ?? null;

  /** Mueve un controlador ya dibujado, sin esperar al servidor (mientras se arrastra). */
  function moverPunto(id, pos) {
    porId.get(id)?.position.set(pos[0], pos[1], pos[2]);
  }

  // los puntos miden lo mismo en pantalla a cualquier distancia
  const mundo = new THREE.Vector3();
  motor.onFrame(() => {
    for (const m of puntos.children) {
      m.getWorldPosition(mundo);
      m.scale.setScalar(motor.view.worldPerPixel([mundo.x, mundo.y, mundo.z]) * m.userData.radio);
    }
  });

  // ---------- el rayo del mouse ----------
  const rayo = new THREE.Raycaster();
  rayo.firstHitOnly = true;
  /** Dónde pega el mouse en la malla: [x, y, z] en coordenadas del archivo, o null. */
  function picar(x, y) {
    if (!malla.visible) return null;
    const { origin, dir } = motor.view.ray([x, y]);
    rayo.set(new THREE.Vector3(...origin), new THREE.Vector3(...dir));
    const [golpe] = rayo.intersectObject(malla, false);
    if (!golpe) return null;
    const p = raiz.worldToLocal(golpe.point.clone());
    return { pos: [p.x, p.y, p.z], cara: golpe.faceIndex };
  }

  /** Dónde se ve un punto dibujado: [x, y] en píxeles, o null si queda detrás de la cámara o tapado. */
  function enPantalla(m) {
    m.getWorldPosition(mundo);
    const [px, py, prof] = motor.view.project([mundo.x, mundo.y, mundo.z]);
    if (prof < 0 || prof > 1) return null;
    // un punto tapado por el modelo no se agarra: el rayo tiene que llegar hasta él
    const golpe = picar(px, py);
    if (golpe && m.position.distanceTo(new THREE.Vector3(...golpe.pos)) > 1.5) return null;
    return [px, py];
  }

  /** El controlador que está bajo el mouse (a menos de `tol` píxeles), o null. */
  function controladorEn(x, y, tol = 11) {
    let mejor = null, dist = tol;
    for (const [id, m] of porId) {
      const p = enPantalla(m);
      const d = p ? Math.hypot(p[0] - x, p[1] - y) : Infinity;
      if (d < dist) { dist = d; mejor = id; }
    }
    return mejor;
  }

  /** Los controladores (no los puntos intermedios) que se ven dentro del rectángulo, en píxeles. */
  function controladoresEn(x0, y0, x1, y1) {
    const [xa, xb, ya, yb] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
    return [...porId].filter(([id, m]) => {
      if (id.startsWith('i:')) return false;
      const p = enPantalla(m);
      return p && p[0] >= xa && p[0] <= xb && p[1] >= ya && p[1] <= yb;
    }).map(([id]) => id);
  }

  /** La manija que está bajo el mouse: { lado, clave } o null. */
  function manijaEn(x, y, tol = 10) {
    for (const h of manijas) {
      h.malla.getWorldPosition(mundo);
      const [px, py] = motor.view.project([mundo.x, mundo.y, mundo.z]);
      if (Math.hypot(px - x, py - y) < tol) return { lado: h.lado, clave: h.clave, pos: h.malla.position.toArray() };
    }
    return null;
  }

  /** El punto bajo el mouse sobre el plano que pasa por `pos` y mira a la cámara (coordenadas del archivo). */
  function enPlano(x, y, pos) {
    const { origin, dir } = motor.view.ray([x, y]);
    const o = new THREE.Vector3(...origin), d = new THREE.Vector3(...dir);
    const p = raiz.localToWorld(new THREE.Vector3(...pos));
    const normal = motor.camera.getWorldDirection(new THREE.Vector3());
    const den = d.dot(normal);
    if (Math.abs(den) < 1e-9) return pos;
    const q = raiz.worldToLocal(o.addScaledVector(d, p.sub(o).dot(normal) / den));
    return [q.x, q.y, q.z];
  }

  /** Mueve una manija ya dibujada, sin esperar al servidor. */
  function moverManija(lado, pos) {
    manijas.find((h) => h.lado === lado)?.malla.position.set(pos[0], pos[1], pos[2]);
  }

  /** Dónde cae en el visor un punto dado en coordenadas del archivo: [x, y] en píxeles. */
  function aPantalla(pos) {
    const p = raiz.localToWorld(new THREE.Vector3(pos[0], pos[1], pos[2]));
    return motor.view.project([p.x, p.y, p.z]);
  }

  return { aPantalla, posicion, controladoresEn, manijaEn, enPlano, moverManija, motor, lienzo: motor.renderer.domElement, registrar, tiene: (id) => geometrias.has(id), orientar, mostrar, encuadrar, dibujar, moverPunto, picar, controladorEn };
}
