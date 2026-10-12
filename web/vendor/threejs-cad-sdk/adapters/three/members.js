// Lo que devuelve createThreeView, en una tabla como las de help(). Está aparte de viewer.js
// porque viewer.js importa three, y la referencia de la API (scripts/docs.mjs) se genera en
// Node sin three. Una prueba compara esta tabla con lo que viewer.js devuelve de verdad.

/** @type {import('../../src/help.js').Member[]} */
export const VIEW_MEMBERS = [
  ['createThreeView(workshop, { scene, geometryFor?, materialFor?, colors? })', 'espeja el documento en una escena de three: cuelga un grupo en scene y lo mantiene al día con los eventos del modelo. geometryFor(piece) y materialFor(piece) son los ganchos de la app (por defecto: la forma que resulta y un gris neutro). colors: { edge, highlight, contact, collision }'],
  ['group', 'el grupo que el adaptador cuelga en la escena'],
  ['meshes', 'las mallas por id de pieza (las de adentro de una instancia, con su id de camino), para elegir con un raycaster'],
  ['sync()', 'sincroniza ya, sin esperar al próximo cuadro'],
  ['show', 'capas de ayuda: show.axes(on), show.boxes(on), show.labels(on) (necesita un CSS2DRenderer) y show.contacts(on) (verde donde se tocan, rojo donde chocan)'],
  ['highlight(...parts)', 'resalta partes, con todo lo de adentro; sin argumentos, apaga'],
  ['rebuild()', 'rehace todas las mallas (si cambió lo que devuelven los ganchos)'],
  ['dispose()', 'se desengancha del modelo y saca todo de la escena'],
];
