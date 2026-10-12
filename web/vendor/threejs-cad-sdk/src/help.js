// help(): la ayuda en la consola. Cada clase declara sus miembros en una tabla (`members`)
// y help() la imprime. JavaScript no tiene docstrings como Python, así que la tabla la
// escribimos a mano — y para que no mienta, hay una prueba (web/test/sdk.test.mjs) que
// exige que cada miembro público de cada clase esté en su tabla, y que cada entrada de la
// tabla exista de verdad.

/**
 * Un miembro: su firma tal como se escribe, y qué hace. Si la firma empieza con
 * "static ", es de la clase y no de la instancia.
 * @typedef {[string, string]} Member
 */

/**
 * Los nombres que documenta una firma. Una entrada puede agrupar varios miembros
 * ("x  y  z", "translation(v) / translation(from, to)"), y las de "new …" son el
 * constructor, que no es un miembro.
 * @param {string} sig @returns {{ name: string, isStatic: boolean }[]}
 */
export function memberNames(sig) {
  if (/^new\s/.test(sig)) return [];
  const isStatic = /^static\s/.test(sig);
  return sig.replace(/^static\s+/, '').split(/\s{2,}|\s\/\s/).map((part) => {
    const m = part.trim().match(/^[A-Za-z_$][\w$]*/);
    return { name: m ? m[0] : part.trim(), isStatic };
  });
}

/**
 * Imprime la tabla de miembros y la devuelve (con su título en `rows.title`, que no se
 * enumera: es lo que usa el generador de la referencia, scripts/docs.mjs).
 * @param {string} title @param {Member[]} members @param {{ print?: boolean }} [opts]
 * @returns {{ member: string, description: string }[] & { readonly title?: string }}
 */
export function help(title, members, { print = true } = {}) {
  const rows = members.map(([sig, doc]) => ({ member: sig, description: doc }));
  Object.defineProperty(rows, 'title', { value: title });
  if (print) {
    console.log(`%c${title}`, 'font-weight:700;color:#a84a1f;font-size:12px');
    console.table(rows);
  }
  return rows;
}
