// Controles dibujados en el visor, pegados a la vista de la cámara: la línea de tiempo de
// movimientos (con sus keyframes) y los deslizadores. No son elementos de HTML: son geometría
// en la capa overlay del motor, recolocada en cada cuadro delante de la cámara para que un
// píxel del visor sea una unidad de este grupo (origen arriba a la izquierda, y hacia abajo).
import * as THREE from 'three';

const COLOR = {
  linea: 0xdddddd, tenue: 0x8a8a8a, fondo: 0x161616, cursor: 0x6aa3ff,
  clave: 0xaaaaaa, claveSel: 0xffc21a, perilla: 0x6aa3ff, texto: '#eeeeee',
};
const MARGEN = 56;          // a los costados de la línea de tiempo
const BANDA = 22;           // cuánto se puede errar con el mouse, en píxeles

const PLANO = new THREE.PlaneGeometry(1, 1);
const TRIANGULO = new THREE.BufferGeometry().setAttribute('position',
  new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0], 3));

/**
 * @param {any} motor el motor de render
 * @param {{ alMovimiento: (num: string) => void, alDeslizar: (id: string, valor: number, final: boolean) => void, alBoton?: (id: string) => void }} avisos
 */
export function crearHud(motor, { alMovimiento, alDeslizar, alBoton }) {
  const grupo = new THREE.Group();
  grupo.matrixAutoUpdate = false;
  grupo.renderOrder = 1000;
  motor.overlay.add(grupo);

  const materiales = new Map();
  const material = (color, opacity = 1) => {
    const k = `${color}/${opacity}`;
    if (!materiales.has(k)) {
      // todos transparentes: así se dibujan en el orden en que se crean, y el fondo no tapa las líneas
      materiales.set(k, new THREE.MeshBasicMaterial({
        color, opacity, transparent: true, depthTest: false, depthWrite: false,
        side: THREE.DoubleSide, toneMapped: false,
      }));
    }
    return materiales.get(k);
  };
  const textos = new Map();
  const texturaDe = (texto, px, color) => {
    const k = `${texto}/${px}/${color}`;
    if (textos.has(k)) return textos.get(k);
    const escala = 2;
    const lienzo = document.createElement('canvas');
    const ctx = /** @type {CanvasRenderingContext2D} */ (lienzo.getContext('2d'));
    const fuente = `${px * escala}px system-ui, sans-serif`;
    ctx.font = fuente;
    const ancho = Math.ceil(ctx.measureText(texto).width) + 4;
    lienzo.width = ancho; lienzo.height = Math.ceil(px * escala * 1.4);
    ctx.font = fuente; ctx.fillStyle = color; ctx.textBaseline = 'middle';
    ctx.fillText(texto, 2, lienzo.height / 2);
    const tex = new THREE.CanvasTexture(lienzo);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    const dato = { mat, w: ancho / escala, h: lienzo.height / escala };
    textos.set(k, dato);
    return dato;
  };

  const pieza = (geo, mat, x, y, w, h, giro = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, 0); m.scale.set(w, h, 1); m.rotation.z = giro;
    m.frustumCulled = false; m.renderOrder = 1000 + grupo.children.length;   // se dibujan en el orden en que se crean
    grupo.add(m);
    return m;
  };
  const rect = (x, y, w, h, color, opacity = 1) => pieza(PLANO, material(color, opacity), x + w / 2, y + h / 2, w, h);
  const rombo = (x, y, lado, color) => pieza(PLANO, material(color), x, y, lado, lado, Math.PI / 4);
  /** alinear: 0 izquierda, 0.5 centro, 1 derecha (respecto de x). */
  const texto = (str, x, y, { alinear = 0, px = 12, color = COLOR.texto } = {}) => {
    const t = texturaDe(str, px, color);
    // el grupo tiene la y invertida: con alto negativo el texto queda derecho
    return pieza(PLANO, t.mat, x + t.w * (0.5 - alinear), y, t.w, -t.h);
  };

  let modelo = /** @type {any} */ (null);
  /** Zonas que atrapan el mouse, recalculadas en cada pintada. */
  let zonas = /** @type {{ tipo: string, id?: string, x0: number, x1: number, y: number, d?: any }[]} */ ([]);
  let arrastre = /** @type {any} */ (null);

  const tamano = () => {
    const c = motor.renderer.domElement;
    return [c.clientWidth || 1, c.clientHeight || 1];
  };

  function pintar() {
    grupo.clear();
    zonas = [];
    if (!modelo) return;
    const [W, H] = tamano();
    pintarLinea(W, H);
    pintarDeslizadores(W, H);
  }

  function pintarLinea(W, H) {
    const { nums, actual, claves, clavesSel, titulo } = modelo.linea;
    if (!nums.length) return;
    const x0 = MARGEN, x1 = Math.max(W - MARGEN, x0 + 40), y = H - 44;
    const xDe = (i) => (nums.length === 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (nums.length - 1));
    rect(x0 - 16, y - 34, x1 - x0 + 32, 64, COLOR.fondo, 0.6);
    rect(x0, y - 0.75, x1 - x0, 1.5, COLOR.linea);
    const cada = Math.max(1, Math.ceil((nums.length * 26) / Math.max(x1 - x0, 1)));   // que los números no se pisen
    nums.forEach((num, i) => {
      const x = xDe(i);
      rect(x - 0.75, y - 6, 1.5, 12, COLOR.linea);
      if (i % cada === 0 || num === actual) texto(num, x, y + 18, { alinear: 0.5, px: 11 });
      if (clavesSel.has(num)) rombo(x, y - 16, 9, COLOR.claveSel);
      else if (claves.has(num)) rombo(x, y - 16, 7, COLOR.clave);
    });
    const xa = xDe(Math.max(0, nums.indexOf(actual)));
    rect(xa - 1.5, y - 26, 3, 36, COLOR.cursor);
    pieza(TRIANGULO, material(COLOR.cursor), xa, y - 29, 12, -9);
    texto(titulo, x0, y - 44, { px: 12 });
    zonas.push({ tipo: 'linea', x0, x1, y, d: { nums, xDe } });
  }

  function pintarDeslizadores(W, H) {
    // en filas (d.fila: 0 abajo, 1 arriba); a la derecha de la fila de abajo, los botones
    const porFila = Math.max(1, ...modelo.deslizadores.map((d) => modelo.deslizadores.filter((e) => (e.fila ?? 0) === (d.fila ?? 0)).length));
    const lugarBotones = (modelo.botones?.length ?? 0) * 44;
    const ancho = Math.min(240, (W - MARGEN * 2 - lugarBotones - 40 * (porFila - 1)) / porFila);
    const enFila = new Map();
    const yDe = (fila) => H - 112 - fila * 54;
    modelo.deslizadores.forEach((d) => {
      const fila = d.fila ?? 0, i = enFila.get(fila) ?? 0;
      enFila.set(fila, i + 1);
      const x0 = MARGEN + i * (ancho + 40), x1 = x0 + ancho, y = yDe(fila);
      const t = (d.valor - d.min) / (d.max - d.min);
      rect(x0 - 16, y - 30, ancho + 32, 46, COLOR.fondo, 0.6);
      rect(x0, y - 0.75, ancho, 1.5, COLOR.linea);
      for (let k = 0; k <= 10; k++) rect(x0 + (ancho * k) / 10 - 0.5, y - (k % 5 ? 3 : 6), 1, k % 5 ? 6 : 12, COLOR.tenue);
      const cero = (0 - d.min) / (d.max - d.min);
      if (cero > 0 && cero < 1) rect(x0 + ancho * cero - 0.75, y - 8, 1.5, 16, COLOR.linea);
      rect(x0 + ancho * t - 4, y - 9, 8, 18, COLOR.perilla);
      const signo = d.valor > 0 ? '+' : '';
      texto(`${d.titulo}  ${d.sinSigno ? '' : signo}${d.valor.toFixed(2)} ${d.unidad ?? ''}`, x0, y - 20, { px: 12 });
      zonas.push({ tipo: 'deslizador', id: d.id, x0, x1, y, d });
    });
    (modelo.botones ?? []).forEach((b, i) => {
      const x0 = MARGEN + porFila * (ancho + 40) - 8 + i * 44, y = yDe(0) - 7;
      rect(x0, y - 16, 34, 34, b.activo ? COLOR.cursor : COLOR.fondo, b.activo ? 0.85 : 0.6);
      texto(b.texto, x0 + 17, y + 1, { alinear: 0.5, px: 17 });
      if (b.leyenda) texto(b.leyenda, x0 + 17, y + 28, { alinear: 0.5, px: 10, color: '#bbbbbb' });
      zonas.push({ tipo: 'boton', id: b.id, x0, x1: x0 + 34, y, d: b });
    });
  }

  function valorEn(zona, x) {
    const { min, max, paso } = zona.d;
    const t = Math.min(1, Math.max(0, (x - zona.x0) / (zona.x1 - zona.x0)));
    return Number((Math.round((min + (max - min) * t) / paso) * paso).toFixed(4));
  }
  function numEn(zona, x) {
    const { nums, xDe } = zona.d;
    let mejor = 0;
    nums.forEach((_, i) => { if (Math.abs(xDe(i) - x) < Math.abs(xDe(mejor) - x)) mejor = i; });
    return nums[mejor];
  }
  function aplicar(zona, x, final) {
    if (zona.tipo === 'linea') {
      const num = numEn(zona, x);
      if (num !== modelo.linea.actual) alMovimiento(num);
    } else {
      alDeslizar(/** @type {string} */ (zona.id), valorEn(zona, x), final);
    }
  }

  // el grupo delante de la cámara, con un píxel por unidad
  const local = new THREE.Matrix4(), escala = new THREE.Vector3(), pos = new THREE.Vector3();
  motor.onFrame(() => {
    const cam = motor.camera;
    const [W, H] = tamano();
    let d, s;
    if (cam.isOrthographicCamera) {
      d = (cam.near + cam.far) / 2;
      s = (cam.top - cam.bottom) / cam.zoom / H;
    } else {
      d = cam.near * 2;
      s = (2 * d * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / cam.zoom / H;
    }
    cam.updateMatrixWorld();
    local.compose(pos.set((-W / 2) * s, (H / 2) * s, -d), new THREE.Quaternion(), escala.set(s, -s, s));
    grupo.matrix.multiplyMatrices(cam.matrixWorld, local);
    grupo.matrixWorldNeedsUpdate = true;
  });
  motor.onResize(() => pintar());

  return {
    /**
     * Qué mostrar: { linea: { titulo, nums, actual, claves: Set, clavesSel: Set },
     *   deslizadores: [{ id, titulo, min, max, paso, valor, unidad, fila? }],
     *   botones?: [{ id, texto, leyenda?, activo? }] }
     */
    definir(m) { modelo = m; pintar(); },
    /** true si el clic cayó en un control (y entonces no es de la malla). */
    bajar(x, y) {
      const boton = zonas.find((z) => z.tipo === 'boton' && x >= z.x0 && x <= z.x1 && Math.abs(y - z.y) <= 18);
      if (boton) { alBoton?.(/** @type {string} */ (boton.id)); return true; }
      const zona = zonas.find((z) => z.tipo !== 'boton' && x >= z.x0 - 12 && x <= z.x1 + 12 && Math.abs(y - z.y) <= BANDA);
      if (!zona) return false;
      arrastre = zona.tipo === 'linea' ? { tipo: 'linea' } : { tipo: 'deslizador', id: zona.id };
      aplicar(zona, x, false);
      return true;
    },
    mover(x) {
      if (!arrastre) return;
      // la zona se busca de nuevo: cada cambio repinta y las zonas son otras
      const zona = zonas.find((z) => z.tipo === arrastre.tipo && z.id === arrastre.id);
      if (zona) aplicar(zona, x, false);
    },
    soltar(x) {
      if (!arrastre) return;
      const zona = zonas.find((z) => z.tipo === arrastre.tipo && z.id === arrastre.id);
      if (zona && zona.tipo === 'deslizador') aplicar(zona, x, true);
      arrastre = null;
    },
    get arrastrando() { return !!arrastre; },
  };
}
