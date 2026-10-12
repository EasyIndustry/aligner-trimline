// help(): la ayuda en la consola, con el mismo formato que threejs-cad-sdk y threejs-render-engine. Cada objeto
// declara sus miembros en una tabla y help() la imprime; una prueba exige que la tabla y la
// API coincidan.
//
// Puro: no importa three ni DOM.

/** @typedef {[string, string]} Member */

/**
 * Imprime la tabla de miembros y la devuelve.
 * @param {string} title @param {Member[]} members @param {{ print?: boolean }} [opts]
 * @returns {{ member: string, description: string }[]}
 */
export function help(title, members, { print = true } = {}) {
  const rows = members.map(([sig, doc]) => ({ member: sig, description: doc }));
  if (print) {
    console.log(`%c${title}`, 'font-weight:700;font-size:12px');
    console.table(rows);
  }
  return rows;
}

/**
 * Los nombres que documenta una firma: 'select(objects)' → select, 'a  b' → a, b.
 * @param {string} sig
 */
export function memberNames(sig) {
  return sig.replace(/^static\s+/, '').split(/\s{2,}|\s\/\s/).map((p) => p.trim().match(/^[A-Za-z_$][\w$]*/)?.[0]).filter((x) => !!x);
}
