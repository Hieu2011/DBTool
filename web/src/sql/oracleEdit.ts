/**
 * Editing an Oracle SELECT in the grid. The driver does not say which table a result column comes from, so the
 * statement's own text is read: the tables of its FROM clause, and what each select item is. The row to update is
 * found by ROWID: the statement is run again with `<table>.ROWID` added to its select list.
 * Text only; imports nothing but the masker, so it also runs under node for its check.
 */
import { maskSql } from './derived';

export interface FromItem {
  /** As written: TABLE, SCHEMA.TABLE, or '' for a subquery. */
  ref: string;
  alias?: string;
  subquery: boolean;
}

type SelectItem =
  | { kind: 'star'; qualifier?: string; start: number; end: number }
  | { kind: 'column'; qualifier?: string; column: string; name: string; start: number; end: number }
  | { kind: 'expression'; start: number; end: number };

export interface ParsedSelect { from: FromItem[]; items: SelectItem[]; listEnd: number }

/** Result column -> the FROM item (index) and column it shows; null when it cannot be written back. */
export type ColumnMap = ({ from: number; column: string } | null)[];

export const ROWID_ALIAS = 'DBSTUDIO_ROWID_';

const ID = '"[^"]+"|[A-Za-z][\\w$#]*';
const NOT_ALIAS = new Set(['ON', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'OUTER', 'WHERE', 'PARTITION', 'USING', 'SAMPLE',
  'PIVOT', 'UNPIVOT', 'GROUP', 'ORDER', 'HAVING', 'CONNECT', 'START', 'UNION', 'MINUS', 'INTERSECT', 'FOR', 'FETCH', 'MODEL']);
const PSEUDO = new Set(['ROWID', 'ROWNUM', 'LEVEL', 'SYSDATE', 'SYSTIMESTAMP', 'USER', 'NULL']);

/** Unquoted names fold to upper case; quoted ones are taken as written. */
const norm = (strName: string) => (strName.startsWith('"') ? strName.slice(1, -1) : strName.toUpperCase());
const normRef = (strRef: string) => strRef.split('.').map(strPart => norm(strPart.trim())).join('.');

/** Everything inside parentheses blanked, same length. */
function flatten(strMasked: string) {
  const arrOut = strMasked.split('');
  let intDepth = 0;
  for (let intPos = 0; intPos < arrOut.length; intPos++) {
    if (strMasked[intPos] === ')') intDepth--;
    if (intDepth > 0 && arrOut[intPos] !== '\n') arrOut[intPos] = ' ';
    if (strMasked[intPos] === '(') intDepth++;
  }
  return arrOut.join('');
}

/** The main query's select list and FROM clause. A string: why its rows cannot be edited. */
export function parseSelect(strSql: string): ParsedSelect | string {
  const strMasked = maskSql(strSql);
  const strFlat = flatten(strMasked);
  const arrSelect = /\bselect\b(?:\s+(distinct|unique|all)\b)?/i.exec(strFlat);
  if (!arrSelect) return 'The statement is not a SELECT.';
  if (arrSelect[1] && arrSelect[1].toLowerCase() !== 'all') return 'A DISTINCT result has no single row behind each line.';
  const intListStart = arrSelect.index + arrSelect[0].length;
  const arrFrom = /\bfrom\b/i.exec(strFlat.slice(intListStart));
  if (!arrFrom) return 'The statement has no FROM clause.';
  const intListEnd = intListStart + arrFrom.index;
  const intFromStart = intListEnd + arrFrom[0].length;
  const strRest = strFlat.slice(intFromStart);
  if (/\b(?:union|minus|intersect)\b/i.test(strRest)) return 'UNION / MINUS / INTERSECT results cannot be edited.';
  if (/\bgroup\s+by\b/i.test(strRest)) return 'A GROUP BY result has no single row behind each line.';
  const arrFromEnd = /\b(?:where|having|order\s+by|connect\s+by|start\s+with|fetch|offset|for\s+update|model)\b/i.exec(strRest);
  const strFromClause = arrFromEnd ? strRest.slice(0, arrFromEnd.index) : strRest;

  // ---- FROM: a table (or a blanked subquery) after FROM, a comma or JOIN, then maybe an alias ----
  const arrItems: FromItem[] = [];
  const reItem = new RegExp(`(?:^|,|\\bjoin\\b)\\s*(\\(\\s*\\)|(?:${ID})(?:\\s*\\.\\s*(?:${ID}))?(?:@[\\w.$#]+)?)(?:\\s+(?:as\\s+)?(${ID}))?`, 'gi');
  for (const arrMatch of strFromClause.matchAll(reItem)) {
    const [, strRef, strAlias] = arrMatch;
    const boolSubquery = strRef.startsWith('(');
    if (strRef.includes('@')) return 'Tables reached through a database link cannot be edited here.';
    const strRealAlias = strAlias && !NOT_ALIAS.has(norm(strAlias)) ? strAlias : undefined;
    arrItems.push({ ref: boolSubquery ? '' : strRef.replace(/\s+/g, ''), alias: strRealAlias, subquery: boolSubquery });
  }
  if (arrItems.length === 0) return 'No table was found in the FROM clause.';

  // ---- select list: split at the top-level commas ----
  const arrSelectItems: SelectItem[] = [];
  const reColumn = new RegExp(`^(?:((?:${ID})(?:\\s*\\.\\s*(?:${ID}))?)\\s*\\.\\s*)?(${ID})(?:\\s+(?:as\\s+)?(${ID}))?$`, 'i');
  const reStar = new RegExp(`^(?:((?:${ID})(?:\\s*\\.\\s*(?:${ID}))?)\\s*\\.\\s*)?\\*$`);
  let intItemStart = intListStart;
  const addItem = (intEnd: number) => {
    // Trim to the item's own text; hints and comments are already blank.
    let intFrom = intItemStart;
    let intTo = intEnd;
    while (intFrom < intTo && /\s/.test(strMasked[intFrom])) intFrom++;
    while (intTo > intFrom && /\s/.test(strMasked[intTo - 1])) intTo--;
    intItemStart = intEnd + 1;
    const strItem = strMasked.slice(intFrom, intTo);
    const arrStar = reStar.exec(strItem);
    if (arrStar) return void arrSelectItems.push({ kind: 'star', qualifier: arrStar[1] && normRef(arrStar[1]), start: intFrom, end: intTo });
    const arrColumn = reColumn.exec(strItem);
    // "a b" reads as column + alias, but `sysdate x` or `null n` are not columns.
    if (arrColumn && !PSEUDO.has(norm(arrColumn[2]))) {
      return void arrSelectItems.push({
        kind: 'column', qualifier: arrColumn[1] && normRef(arrColumn[1]), column: norm(arrColumn[2]), name: norm(arrColumn[3] ?? arrColumn[2]),
        start: intFrom, end: intTo,
      });
    }
    arrSelectItems.push({ kind: 'expression', start: intFrom, end: intTo });
  };
  for (let intPos = intListStart; intPos < intListEnd; intPos++) if (strFlat[intPos] === ',') addItem(intPos);
  addItem(intListEnd);

  return { from: arrItems, items: arrSelectItems, listEnd: intListEnd };
}

/** How a FROM item is named elsewhere in the statement. */
export const nameOf = (objItem: FromItem) => objItem.alias ?? objItem.ref;

/** The FROM item a qualifier (alias, TABLE or SCHEMA.TABLE) points at; -1 when none or several do. */
function itemOf(arrFrom: FromItem[], strQualifier: string) {
  const arrHits = arrFrom.map((objItem, intIndex) => {
    if (objItem.alias) return norm(objItem.alias) === strQualifier ? intIndex : -1;
    if (objItem.subquery) return -1;
    const strRef = normRef(objItem.ref);
    return strRef === strQualifier || strRef.split('.').pop() === strQualifier ? intIndex : -1;
  }).filter(intIndex => intIndex >= 0);
  return arrHits.length === 1 ? arrHits[0] : -1;
}

/**
 * What each result column is. columnsOf: the table's columns in table order (undefined when unknown: a subquery,
 * a synonym, a schema not loaded). A string: why the result's columns cannot be told apart.
 */
export function mapColumns(objParsed: ParsedSelect, arrResultNames: string[], columnsOf: (objItem: FromItem) => string[] | undefined): ColumnMap | string {
  const arrMap: ColumnMap = [];
  const arrNames: string[] = [];
  const arrKnown = objParsed.from.map(columnsOf);
  const boolOneTable = objParsed.from.length === 1 && !objParsed.from[0].subquery;
  // SELECT * FROM one_table: every column is that table's, whatever it is (a synonym, a schema not loaded).
  if (boolOneTable && objParsed.items.length === 1 && objParsed.items[0].kind === 'star' && !arrKnown[0])
    return arrResultNames.map(strColumn => ({ from: 0, column: strColumn }));

  for (const objSelectItem of objParsed.items) {
    if (objSelectItem.kind === 'expression') { arrMap.push(null); arrNames.push(''); continue; }
    if (objSelectItem.kind === 'star') {
      const arrFromIndexes = objSelectItem.qualifier === undefined ? objParsed.from.map((_, intIndex) => intIndex) : [itemOf(objParsed.from, objSelectItem.qualifier)];
      for (const intFrom of arrFromIndexes) {
        const arrColumns = intFrom >= 0 ? arrKnown[intFrom] : undefined;
        if (!arrColumns) {
          return `The columns behind "*" are not known${intFrom >= 0 && !objParsed.from[intFrom].subquery ? ` for ${objParsed.from[intFrom].ref}` : ''}: `
            + 'list the columns in the SELECT, or open that schema in the object tree first.';
        }
        for (const strColumn of arrColumns) {
          arrMap.push(objParsed.from[intFrom].subquery ? null : { from: intFrom, column: strColumn });
          arrNames.push(strColumn);
        }
      }
      continue;
    }

    let intOwner = -1;
    if (objSelectItem.qualifier !== undefined) {
      intOwner = itemOf(objParsed.from, objSelectItem.qualifier);
      // A name the table is known not to have is something else (a record field, a package constant).
      if (intOwner >= 0 && arrKnown[intOwner] && !arrKnown[intOwner]!.includes(objSelectItem.column)) intOwner = -1;
    } else if (arrKnown.every(arrColumns => arrColumns !== undefined)) {
      // Unqualified: only sure when every table's columns are known and exactly one has it.
      const arrOwners = arrKnown.map((arrColumns, intIndex) => (arrColumns!.includes(objSelectItem.column) ? intIndex : -1)).filter(intIndex => intIndex >= 0);
      if (arrOwners.length === 1) intOwner = arrOwners[0];
    } else if (boolOneTable) intOwner = 0; // nothing else it could belong to
    arrMap.push(intOwner >= 0 && !objParsed.from[intOwner].subquery ? { from: intOwner, column: objSelectItem.column } : null);
    arrNames.push(objSelectItem.name);
  }

  const boolSame = arrMap.length === arrResultNames.length && arrNames.every((strName, intCol) => strName === '' || strName === arrResultNames[intCol]);
  return boolSame ? arrMap : 'The select list could not be matched to the result columns.';
}

/** The statement with `<table>.ROWID` as one more column. A bare `*` becomes `t1.*, t2.*`: Oracle takes nothing else beside it. */
export function rowIdSql(strSql: string, objParsed: ParsedSelect, objTarget: FromItem): string | null {
  let strOut = '';
  let intAt = 0;
  for (const objSelectItem of objParsed.items) {
    if (objSelectItem.kind !== 'star' || objSelectItem.qualifier !== undefined) continue;
    if (objParsed.from.some(objItem => objItem.subquery && !objItem.alias)) return null; // nothing to qualify the star with
    strOut += strSql.slice(intAt, objSelectItem.start) + objParsed.from.map(objItem => `${nameOf(objItem)}.*`).join(', ');
    intAt = objSelectItem.end;
  }
  const intInsert = objParsed.items[objParsed.items.length - 1].end;
  return `${strOut}${strSql.slice(intAt, intInsert)}, ${nameOf(objTarget)}.ROWID AS ${ROWID_ALIAS}${strSql.slice(intInsert)}`;
}
