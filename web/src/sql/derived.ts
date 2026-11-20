/**
 * Subqueries in FROM and CTEs of a statement, with the columns they return, read from the text alone.
 * Used where the parser has no answer (Oracle: the library has no grammar for it). No imports: also runs under node for its check.
 */

export interface DerivedTable {
  /** Alias of the subquery, or name of the CTE (as written, quotes kept). */
  name: string;
  /** Output column names. */
  columns: string[];
  /** `*` or `t.*` in the select list: the caller expands them from the tables of `inner`. '' = every table. */
  stars: string[];
  /** The subquery's own text with nested parentheses blanked: its FROM clause is at the top level. */
  inner: string;
}

const NOT_NAME = new Set([
  'where', 'join', 'inner', 'left', 'right', 'full', 'cross', 'on', 'using', 'group', 'order', 'having', 'limit', 'offset', 'fetch',
  'union', 'set', 'values', 'returning', 'natural', 'start', 'connect', 'for', 'window', 'except', 'intersect', 'minus', 'partition',
  'select', 'from', 'and', 'or', 'then', 'else', 'when', 'end', 'as', 'pivot', 'unpivot', 'model', 'with',
]);
const IDENT = '"[^"]+"|[A-Za-z_][\\w$#]*';

/** Strings and comments replaced by spaces, same length: brackets and keywords inside them no longer count. */
export function maskSql(strSql: string): string {
  const arrOut = strSql.split('');
  const blank = (intFrom: number, intTo: number) => {
    for (let intPos = intFrom; intPos < intTo && intPos < arrOut.length; intPos++) if (arrOut[intPos] !== '\n') arrOut[intPos] = ' ';
  };
  let intPos = 0;
  while (intPos < strSql.length) {
    const strChar = strSql[intPos];
    const strNext = strSql[intPos + 1];
    if (strChar === '-' && strNext === '-') {
      const intEol = strSql.indexOf('\n', intPos);
      const intEnd = intEol < 0 ? strSql.length : intEol;
      blank(intPos, intEnd);
      intPos = intEnd;
    } else if (strChar === '/' && strNext === '*') {
      const intClose = strSql.indexOf('*/', intPos + 2);
      const intEnd = intClose < 0 ? strSql.length : intClose + 2;
      blank(intPos, intEnd);
      intPos = intEnd;
    } else if (strChar === "'") {
      let intEnd = intPos + 1;
      while (intEnd < strSql.length) {
        if (strSql[intEnd] !== "'") intEnd++;
        else if (strSql[intEnd + 1] === "'") intEnd += 2;
        else break;
      }
      blank(intPos + 1, intEnd); // the quotes stay: the literal is still one token
      intPos = intEnd + 1;
    } else if (strChar === '"') {
      const intClose = strSql.indexOf('"', intPos + 1);
      intPos = intClose < 0 ? strSql.length : intClose + 1; // quoted identifiers are kept
    } else intPos++;
  }
  return arrOut.join('');
}

/** Index of the bracket closing the one at intOpen; -1 when it is not closed. */
function closeOf(strMasked: string, intOpen: number) {
  let intDepth = 0;
  for (let intPos = intOpen; intPos < strMasked.length; intPos++) {
    if (strMasked[intPos] === '(') intDepth++;
    else if (strMasked[intPos] === ')' && --intDepth === 0) return intPos;
  }
  return -1;
}

/** Text with everything inside parentheses blanked (the brackets stay). */
function flatten(strMasked: string) {
  const arrOut = strMasked.split('');
  let intDepth = 0;
  for (let intPos = 0; intPos < arrOut.length; intPos++) {
    if (arrOut[intPos] === ')') intDepth--;
    if (intDepth > 0 && arrOut[intPos] !== '\n') arrOut[intPos] = ' ';
    if (strMasked[intPos] === '(') intDepth++;
  }
  return arrOut.join('');
}

/** Column names of the first SELECT list of a (masked) query text. */
function selectList(strQuery: string) {
  const strFlat = flatten(strQuery);
  const arrSelect = /\bselect\b(?:\s+(?:distinct|all|unique)\b)?/i.exec(strFlat);
  if (!arrSelect) return { columns: [], stars: [] };
  const intListStart = arrSelect.index + arrSelect[0].length;
  const arrFrom = /\bfrom\b/i.exec(strFlat.slice(intListStart));
  const intListEnd = arrFrom ? intListStart + arrFrom.index : strFlat.length;

  const arrColumns: string[] = [];
  const arrStars: string[] = [];
  let intItemStart = intListStart;
  const addItem = (intEnd: number) => {
    const strItem = strQuery.slice(intItemStart, intEnd).trim();
    intItemStart = intEnd + 1;
    if (!strItem) return;
    const arrStar = new RegExp(`^(?:(${IDENT})\\s*\\.\\s*)?\\*$`).exec(strItem);
    if (arrStar) return void arrStars.push(arrStar[1] ?? '');
    // expr AS name | expr name | t.name | name
    const arrAlias = new RegExp(`(?:\\bas\\s+|[\\s)])(${IDENT})$`, 'i').exec(strItem) ?? new RegExp(`^(?:(?:${IDENT})\\s*\\.\\s*)*(${IDENT})$`).exec(strItem);
    if (arrAlias && !NOT_NAME.has(arrAlias[1].toLowerCase())) arrColumns.push(arrAlias[1]);
  };
  for (let intPos = intListStart; intPos < intListEnd; intPos++) if (strFlat[intPos] === ',') addItem(intPos);
  addItem(intListEnd);
  return { columns: arrColumns, stars: arrStars };
}

export function derivedTables(strSql: string): DerivedTable[] {
  const strMasked = maskSql(strSql);
  const arrTables: DerivedTable[] = [];
  const reOpen = /\(\s*(?:select|with)\b/gi;
  for (let arrOpen = reOpen.exec(strMasked); arrOpen; arrOpen = reOpen.exec(strMasked)) {
    const intOpen = arrOpen.index;
    const intClose = closeOf(strMasked, intOpen);
    if (intClose < 0) continue;
    const strInner = strMasked.slice(intOpen + 1, intClose);

    // CTE: name [(col, col)] AS [NOT] [MATERIALIZED] ( ... )
    const arrCte = new RegExp(`(${IDENT})\\s*(?:\\(([^()]*)\\)\\s*)?\\bas\\s+(?:(?:not\\s+)?materialized\\s+)?$`, 'i').exec(strMasked.slice(0, intOpen));
    // Subquery: ( ... ) [AS] alias
    const arrAlias = new RegExp(`^\\s*(?:as\\s+)?(${IDENT})`, 'i').exec(strMasked.slice(intClose + 1));
    const strName = arrCte && !NOT_NAME.has(arrCte[1].toLowerCase()) ? arrCte[1]
      : arrAlias && !NOT_NAME.has(arrAlias[1].toLowerCase()) ? arrAlias[1] : null;
    if (!strName) continue;

    const objList = selectList(strInner);
    const arrDeclared = arrCte?.[2]?.split(',').map(strColumn => strColumn.trim()).filter(Boolean);
    arrTables.push({
      name: strName,
      columns: arrDeclared && arrDeclared.length > 0 && strName === arrCte?.[1] ? arrDeclared : objList.columns,
      stars: objList.stars,
      inner: flatten(strInner),
    });
  }
  return arrTables;
}
