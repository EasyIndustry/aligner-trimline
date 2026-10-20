// Controles dibujados en el visor, pegados a la vista de la cámara: la línea de tiempo de
// movimientos (con sus keyframes) y los deslizadores. No son elementos de HTML: son geometría
// en la capa overlay del motor, recolocada en cada cuadro delante de la cámara para que un
// píxel del visor sea una unidad de este grupo (origen arriba a la izquierda, y hacia abajo).
import * as THREE from 'three';

const COLOR = {
  linea: 0xdddddd, tenue: 0x8a8a8a, fondo: 0x161616, cursor: 0x6aa3ff,
  clave: 0xaaaaaa, claveSel: 0xffc21a, perilla: 0x6aa3ff, texto: '#eeeeee',
  sinAjuste: '#ffb347', apagado: '#9a9a9a', realce: 0x9cc3ff, adicional: '#7fd18b',
};
const MARGEN = 56;          // a los costados de la línea de tiempo
const BANDA = 22;           // cuánto se puede errar con el mouse, en píxeles

const PLANO = new THREE.PlaneGeometry(1, 1);
const CIRCULO = new THREE.CircleGeometry(0.5, 32);
const TRIANGULO = new THREE.BufferGeometry().setAttribute('position',
  new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0], 3));

/**
 * @param {any} motor el motor de render
 * @param {{ alMovimiento: (num: string) => void, alDeslizar: (id: string, valor: number, final: boolean) => void, alBoton?: (id: string) => void, alMenu?: (num: string, x: number, y: number) => void }} avisos
 */
export function crearHud(motor, { alMovimiento, alDeslizar, alBoton, alMenu }) {
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
  const circulo = (x, y, d, color, opacity = 1) => pieza(CIRCULO, material(color, opacity), x, y, d, d);
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
  /** Lo que está bajo el mouse y se resalta: 'cursor' (el que se arrastra) o 'menu' (el ⋯). */
  let realce = /** @type {string | null} */ (null);

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
    const { nums, actual, claves, clavesSel, titulo, marcas = {}, extra = new Set() } = modelo.linea;
    if (!nums.length) return;
    const x0 = MARGEN, x1 = Math.max(W - MARGEN, x0 + 40), y = H - 44;
    const xDe = (i) => (nums.length === 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (nums.length - 1));
    rect(x0 - 16, y - 64, x1 - x0 + 32, 104, COLOR.fondo, 0.6);
    rect(x0, y - 0.75, x1 - x0, 1.5, COLOR.linea);
    const cada = Math.max(1, Math.ceil((nums.length * 26) / Math.max(x1 - x0, 1)));   // que los números no se pisen
    nums.forEach((num, i) => {
      const x = xDe(i);
      // las curvas adicionales (X18), al final y en otro color
      rect(x - 0.75, y - 6, 1.5, 12, extra.has(num) ? 0x7fd18b : COLOR.linea);
      if (i % cada === 0 || num === actual || extra.has(num)) texto(num, x, y + 18, { alinear: 0.5, px: 11, color: extra.has(num) ? COLOR.adicional : COLOR.texto });
      // los movimientos sin offset (o) o sin festoneado (f), debajo del número
      if (marcas[num]) texto(marcas[num], x, y + 31, { alinear: 0.5, px: 10, color: COLOR.sinAjuste });
      if (clavesSel.has(num)) rombo(x, y - 16, 9, COLOR.claveSel);
      else if (claves.has(num)) rombo(x, y - 16, 7, COLOR.clave);
    });
    const xa = xDe(Math.max(0, nums.indexOf(actual)));
    // el cursor: al pasarle por encima o arrastrarlo se acentúa (más grueso, más grande, más claro)
    const fuerte = realce === 'cursor' || arrastre?.tipo === 'linea';
    const colorCursor = fuerte ? COLOR.realce : COLOR.cursor;
    rect(xa - (fuerte ? 2.5 : 1.5), y - 26, fuerte ? 5 : 3, 36, colorCursor);
    pieza(TRIANGULO, material(colorCursor), xa, y - 30, fuerte ? 17 : 12, fuerte ? -13 : -9);
    // arriba del cursor, el ⋯ que abre el menú del movimiento (lo mismo que el clic derecho)
    const ym = y - 46, sobre = realce === 'menu';
    if (alMenu) {
      circulo(xa, ym, 22, sobre ? COLOR.realce : COLOR.cursor);
      circulo(xa, ym, 17, COLOR.fondo, sobre ? 0.75 : 0.95);
      for (const dx of [-4.5, 0, 4.5]) circulo(xa + dx, ym, 3.2, sobre ? 0xffffff : COLOR.realce);
      zonas.push({ tipo: 'menu', x0: xa - 13, x1: xa + 13, y: ym, d: { num: actual } });
    }
    // el título, donde no lo tape el ⋯
    const tt = texturaDe(titulo, 12, COLOR.texto);
    if (alMenu && xa - 14 < x0 + tt.w + 8) texto(titulo, x1, y - 50, { px: 12, alinear: 1 });
    else texto(titulo, x0, y - 50, { px: 12 });
    zonas.push({ tipo: 'linea', x0, x1, y, d: { nums, xDe, xa } });
  }

  function pintarDeslizadores(W, H) {
    // en filas (d.fila: 0 abajo, 1 arriba); a la derecha de la fila de abajo, los botones
    const porFila = Math.max(1, ...modelo.deslizadores.map((d) => modelo.deslizadores.filter((e) => (e.fila ?? 0) === (d.fila ?? 0)).length));
    const lugarBotones = (modelo.botones?.length ?? 0) * 44;
    const ancho = Math.min(240, (W - MARGEN * 2 - lugarBotones - 40 * (porFila - 1)) / porFila);
    const enFila = new Map();
    const yDe = (fila) => H - 142 - fila * 54;
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
      // apagado: el valor vale para el tratamiento, pero este movimiento no lo lleva
      rect(x0 + ancho * t - 4, y - 9, 8, 18, d.apagado ? 0x777777 : COLOR.perilla);
      const signo = d.valor > 0 ? '+' : '';
      texto(`${d.titulo}  ${d.sinSigno ? '' : signo}${d.valor.toFixed(2)} ${d.unidad ?? ''}${d.apagado ? '  · no va en este mov.' : ''}`, x0, y - 20,
        { px: 12, color: d.apagado ? COLOR.apagado : COLOR.texto });
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
  const enMenu = (x, y) => zonas.find((z) => z.tipo === 'menu' && x >= z.x0 && x <= z.x1 && Math.abs(y - z.y) <= 13);
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
     *   (linea.marcas?: { num: texto } debajo de cada número; linea.extra?: Set de las curvas adicionales)
     *   deslizadores: [{ id, titulo, min, max, paso, valor, unidad, fila?, apagado? }],
     *   botones?: [{ id, texto, leyenda?, activo? }] }
     */
    definir(m) { modelo = m; pintar(); },
    /** true si el clic cayó en un control (y entonces no es de la malla). */
    bajar(x, y) {
      const menu = enMenu(x, y);
      if (menu) { alMenu?.(menu.d.num, menu.x0 + 13, menu.y + 14); return true; }
      const boton = zonas.find((z) => z.tipo === 'boton' && x >= z.x0 && x <= z.x1 && Math.abs(y - z.y) <= 18);
      if (boton) { alBoton?.(/** @type {string} */ (boton.id)); return true; }
      const zona = zonas.find((z) => (z.tipo === 'linea' || z.tipo === 'deslizador') && x >= z.x0 - 12 && x <= z.x1 + 12 && Math.abs(y - z.y) <= BANDA);
      if (!zona) return false;
      arrastre = zona.tipo === 'linea' ? { tipo: 'linea' } : { tipo: 'deslizador', id: zona.id };
      aplicar(zona, x, false);
      if (zona.tipo === 'linea') pintar();                    // el cursor, acentuado mientras se arrastra
      return true;
    },
    /**
     * El mouse pasa por (x, y) sin apretar: resalta lo que está debajo y dice qué cursor poner
     * ('grab' para arrastrar, 'pointer' para hacer clic), o null si no hay un control.
     */
    encima(x, y) {
      let nuevo = null, mouse = null;
      const linea = zonas.find((z) => z.tipo === 'linea');
      if (enMenu(x, y)) { nuevo = 'menu'; mouse = 'pointer'; }
      else if (linea && Math.abs(x - linea.d.xa) <= 10 && y >= linea.y - 40 && y <= linea.y + 12) { nuevo = 'cursor'; mouse = 'grab'; }
      else if (zonas.some((z) => (z.tipo === 'linea' || z.tipo === 'deslizador') && x >= z.x0 - 12 && x <= z.x1 + 12 && Math.abs(y - z.y) <= BANDA)) mouse = 'grab';
      else if (zonas.some((z) => z.tipo === 'boton' && x >= z.x0 && x <= z.x1 && Math.abs(y - z.y) <= 18)) mouse = 'pointer';
      if (nuevo !== realce) { realce = nuevo; pintar(); }
      return mouse;
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
      const eraLinea = arrastre.tipo === 'linea';
      arrastre = null;
      if (eraLinea) pintar();
    },
    get arrastrando() { return !!arrastre; },
    /** El movimiento de la línea de tiempo que está en (x, y), o null. */
    movimientoEn(x, y) {
      const zona = zonas.find((z) => z.tipo === 'linea' && x >= z.x0 - 12 && x <= z.x1 + 12 && y >= z.y - 34 && y <= z.y + 40);
      return zona ? numEn(zona, x) : null;
    },
  };
}
