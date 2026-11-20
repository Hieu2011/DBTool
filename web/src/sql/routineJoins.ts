/** Join conditions (`a.col = b.col`) between known tables, read from the source of a routine. Text only: no parser. */
import { maskSql } from './derived';

export interface JoinTable { key: string; schema: string; name: string; columns?: string[] }
export interface JoinLink { from: string; fromColumn: string; to: string; toColumn: string }

const NOT_ALIAS = new Set([
  'where', 'join', 'inner', 'left', 'right', 'full', 'cross', 'on', 'using', 'group', 'order', 'having', 'limit', 'offset', 'fetch',
  'union', 'set', 'values', 'returning', 'natural', 'start', 'connect', 'for', 'window', 'except', 'intersect', 'minus', 'partition',
  'select', 'from', 'and', 'or', 'as', 'loop', 'then', 'into', 'when', 'is', 'begin', 'end',
]);

const escapeRegex = (strText: string) => strText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One link per pair of columns compared with `=` across two different tables.
 * Aliases are resolved statement by statement (the text between two `;`): the same alias may mean another table further down.
 */
export function joinLinks(strSource: string, arrTables: JoinTable[]): JoinLink[] {
  if (arrTables.length < 2) return [];
  const strMasked = maskSql(strSource).replace(/"/g, '').toLowerCase();
  const strNames = arrTables.map(objTable => escapeRegex(objTable.name.toLowerCase())).sort((strA, strB) => strB.length - strA.length).join('|');
  // [schema.]table [[as] alias], after FROM / JOIN / UPDATE / INTO or a comma of a FROM list
  const reTable = new RegExp(`(?:\\b(?:from|join|update|into)\\s+|,\\s*)(?:([\\w$#]+)\\.)?(${strNames})\\b(?:\\s+(?:as\\s+)?([a-z_][\\w$#]*))?`, 'g');
  // a.x = b.y, with Oracle's (+) on either side
  const reEqual = /([a-z_][\w$#]*)\.([a-z_][\w$#]*)\s*(?:\(\+\)\s*)?=\s*([a-z_][\w$#]*)\.([a-z_][\w$#]*)/g;

  const dicLinks = new Map<string, JoinLink>();
  for (const strStatement of strMasked.split(';')) {
    const dicAliases = new Map<string, JoinTable>();
    for (const arrMatch of strStatement.matchAll(reTable)) {
      const [, strSchema, strName, strAlias] = arrMatch;
      const arrNamed = arrTables.filter(objTable => objTable.name.toLowerCase() === strName);
      const objTable = arrNamed.find(objItem => objItem.schema.toLowerCase() === strSchema) ?? arrNamed[0];
      if (!objTable) continue;
      dicAliases.set(strName, objTable);
      if (strAlias && !NOT_ALIAS.has(strAlias)) dicAliases.set(strAlias, objTable);
    }
    if (dicAliases.size < 2) continue;

    for (const [, strLeft, strLeftColumn, strRight, strRightColumn] of strStatement.matchAll(reEqual)) {
      const objLeft = dicAliases.get(strLeft);
      const objRight = dicAliases.get(strRight);
      if (!objLeft || !objRight || objLeft.key === objRight.key) continue;
      // The column's own spelling, and no link on a name the table does not have (a record field, a variable).
      const columnOf = (objTable: JoinTable, strColumn: string) =>
        (objTable.columns ? objTable.columns.find(strName => strName.toLowerCase() === strColumn) : strColumn);
      const strFromColumn = columnOf(objLeft, strLeftColumn);
      const strToColumn = columnOf(objRight, strRightColumn);
      if (!strFromColumn || !strToColumn) continue;
      // The same join written the other way round is the same link.
      const [objA, objB] = objLeft.key < objRight.key
        ? [{ key: objLeft.key, column: strFromColumn }, { key: objRight.key, column: strToColumn }]
        : [{ key: objRight.key, column: strToColumn }, { key: objLeft.key, column: strFromColumn }];
      dicLinks.set(`${objA.key}.${objA.column}=${objB.key}.${objB.column}`, { from: objA.key, fromColumn: objA.column, to: objB.key, toColumn: objB.column });
    }
  }
  return [...dicLinks.values()];
}
