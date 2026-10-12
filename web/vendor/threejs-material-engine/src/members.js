// La tabla de help() del motor (createMaterialEngine): una línea por miembro. Vive aparte (pura,
// sin three) para que la prueba en Node pueda compararla con la API del adaptador.

/** @type {import('./help.js').Member[]} */
export const ENGINE_MEMBERS = [
  ['renderer', 'el WebGLRenderer donde se hornea'],
  ['define(def)', 'la definición completa y validada: con los atajos resueltos, y un error que dice dónde si algo está mal'],
  ['plan(def)', 'qué canales quedan constantes y cuáles se hornean, con sus pasos (fill, capas, mezclas de capas de material)'],
  ['hash(def)', 'el identificador del material, con las versiones de sus generadores: igual definición, igual hash'],
  ['material(def, { clone?, onProgress? })', 'el MeshPhysicalMaterial: hornea lo que haga falta (una vez por hash) y lo arma'],
  ['bake(def, { onProgress? })', 'solo hornea: { hash, textures: { canal: Texture }, plan }'],
  ['exportBaked(def, { type?, quality? })', 'los mapas horneados como imágenes, para guardar prehorneados: { hash, files: { canal: Blob } }'],
  ['loadBaked(def, files)', 'un material desde prehorneados { canal: URL }, sin hornear'],
  ['registerGenerator(gen)', "agregar un generador o el plugin de una app ('app/nombre'): GLSL que llena la superficie, uv o sólido"],
  ['generators()', 'los generadores que hay: { name, version, space, outputs, params, doc }'],
  ['release(def)', 'soltar lo horneado de un material'],
  ['stats()', 'qué hay en memoria: materiales, texturas, megabytes, programas'],
  ['dispose()', 'soltarlo todo'],
  ['help()', 'esta tabla'],
];
