/** Editing a SELECT result in the grid: which columns can be written back to which table, and the UPDATE statements. */
import { sqlLiteral } from '../importData';
import type { DbKind, QueryResult, ResultOrigin } from '../types';
import { qualifiedName, quoteIdent } from './identifiers';
import { nameOf, type ColumnMap, type ParsedSelect } from './oracleEdit';

export interface EditTarget {
  key: string;
  /** Shown in the table list. */
  label: string;
  /** The table as the UPDATE names it. */
  tableSql: string;
  /** Oracle: rows are found by ROWID (read by running the statement again), not by primary key. */
  byRowId?: boolean;
  keyColumns: string[];
  /** For each key column, every result column that carries it. */
  keyIndexes: number[][];
  /** Result column -> column of the table, for the columns the grid can edit. */
  columns: Map<number, string>;
  /** Why this table cannot be edited here; undefined when it can. */
  reason?: string;
  /** Why this text cannot be saved in that column (MongoDB: a sub-document that does not read as one); null when it can. */
  cellError?: (intCol: number, strValue: string) => string | null;
  /** One more test a row has to pass (MongoDB: its _id can be written back). */
  rowOk?: (arrRow: unknown[]) => boolean;
}

/** One statement of a save. row: the grid row it comes from. */
export interface RowUpdate {
  kind: 'update' | 'insert' | 'delete'; row: number; sql: string; cells: { col: number; value: string | null }[];
  /** A PL/SQL block: the driver reports no row count for it. */
  block?: boolean;
  /** MongoDB update: the answer's matchedCount is what has to be 1. */
  check?: 'matched';
}

// Never written from the grid.
const NOT_EDITABLE_TYPE = /bfile|image/i;

/** bytea / RAW / BLOB...: the cell holds hex (0x…), whole only up to the 64 bytes the server sends. */
export const isBinaryType = (strType: string) => /bytea|blob|raw|binary/i.test(strType) && !/binary_(float|double)/i.test(strType);

/** The hex digits of a binary cell's text (0xAB12, PostgreSQL's \\xab12, or bare), null when it is not a whole value. */
export function binaryHex(strValue: string) {
  const strHex = strValue.trim().replace(/^(0x|\\x)/i, '');
  return /^([0-9a-f]{2})*$/i.test(strHex) ? strHex.toUpperCase() : null;
}

// The only expressions a cell may hold (typed after "="); anything else is a value and gets quoted.
const EXPRESSION = /^=\s*((?:[\w$#"]+\.)*[\w$#"]+\.NEXTVAL|NEXTVAL\('[^']+'\)|SYSDATE|SYSTIMESTAMP|CURRENT_TIMESTAMP|(?:[\w$#]+\.)*[\w$#]+\(\))\s*$/i;

/** A cell's text as SQL: `=SEQ.NEXTVAL` / `=SYSDATE` as they are, the rest as a literal of the column's type. */
function cellSql(strValue: string | null, strType: string, strKind: DbKind) {
  const arrExpression = EXPRESSION.exec(strValue ?? '');
  if (arrExpression) return arrExpression[1];
  if (strValue === null || strValue === '' || !isBinaryType(strType)) return sqlLiteral(strValue, strType, strKind);
  // Text that is not hex still goes through the hex function, so the database rejects it instead of storing the text's bytes.
  const strHex = binaryHex(strValue) ?? strValue.replace(/'/g, "''");
  return strKind === 'Oracle' ? `HEXTORAW('${strHex}')` : `decode('${strHex}', 'hex')`;
}

/**
 * Oracle: what generates a table's key, found by name. The key is the one-column primary key, or the first column
 * when the table declares none. Rows: column, kind (PROCEDURE / FUNCTION / SEQUENCE), owner, name; best first.
 * A routine <TABLE>_NEWID (procedure with one OUT parameter, or function without parameters) comes before a
 * sequence (SEQ_<TABLE>_ID, SEQ_<TABLE>, <TABLE>_SEQ, SEQ_<COLUMN>...). strTableSql: TABLE or OWNER.TABLE.
 */
export function keyGeneratorSql(strTableSql: string) {
  const arrParts = strTableSql.split('.').map(strPart => (strPart.startsWith('"') ? strPart.slice(1, -1) : strPart.toUpperCase()).replace(/'/g, "''"));
  const strTable = arrParts[arrParts.length - 1];
  const strOwner = arrParts.length > 1 ? `'${arrParts[0]}'` : `SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')`;
  const strArguments = `SELECT COUNT(*) FROM all_arguments a WHERE a.owner = o.owner AND a.object_name = o.object_name AND a.package_name IS NULL AND a.argument_name IS NOT NULL`;
  return `WITH k AS (
  SELECT cc.column_name FROM all_constraints c
  JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
  WHERE c.constraint_type = 'P' AND c.owner = ${strOwner} AND c.table_name = '${strTable}'
    AND (SELECT COUNT(*) FROM all_cons_columns x WHERE x.owner = c.owner AND x.constraint_name = c.constraint_name) = 1
  UNION ALL
  SELECT tc.column_name FROM all_tab_columns tc
  WHERE tc.owner = ${strOwner} AND tc.table_name = '${strTable}' AND tc.column_id = 1
    AND NOT EXISTS (SELECT 1 FROM all_constraints c WHERE c.constraint_type = 'P' AND c.owner = ${strOwner} AND c.table_name = '${strTable}')
)
SELECT k.column_name, o.object_type, o.owner, o.object_name, 1 AS pri
FROM k JOIN all_objects o ON o.owner = ${strOwner} AND o.object_name = '${strTable}_NEWID' AND o.object_type IN ('PROCEDURE', 'FUNCTION')
WHERE (${strArguments} AND a.in_out <> 'OUT') = 0
  AND (${strArguments} AND a.in_out = 'OUT') = DECODE(o.object_type, 'PROCEDURE', 1, 0)
UNION ALL
SELECT k.column_name, 'SEQUENCE', s.sequence_owner, s.sequence_name, 2
FROM k JOIN all_sequences s ON s.sequence_owner = ${strOwner}
 AND s.sequence_name IN ('SEQ_${strTable}_ID', 'SEQ_${strTable}', '${strTable}_SEQ', '${strTable}_ID_SEQ', 'SEQ_' || k.column_name, 'SEQ_${strTable}_' || k.column_name, k.column_name || '_SEQ')
ORDER BY 5`;
}

/** Oracle: the primary key columns of a table, in key order. strTableSql: TABLE or OWNER.TABLE (no owner = the current schema). */
export function primaryKeySql(strTableSql: string) {
  const arrParts = strTableSql.split('.').map(strPart => (strPart.startsWith('"') ? strPart.slice(1, -1) : strPart.toUpperCase()).replace(/'/g, "''"));
  const strOwner = arrParts.length > 1 ? `'${arrParts[0]}'` : `SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')`;
  return `SELECT cc.column_name
FROM all_constraints c
JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
WHERE c.constraint_type = 'P' AND c.owner = ${strOwner} AND c.table_name = '${arrParts[arrParts.length - 1]}'
ORDER BY cc.position`;
}

/** `row:col` of a cell in the changes map. */
export const cellKey = (intRow: number, intCol: number) => `${intRow}:${intCol}`;

/** The tables the result's columns come from. A string: why nothing can be edited. */
export function editTargets(objResult: QueryResult, objOrigin: ResultOrigin, strKind: DbKind): EditTarget[] | string {
  const boolSameShape = objOrigin.columns.length === objResult.columns.length
    && objOrigin.columns.every((objColumn, intCol) => objColumn.name.toLowerCase() === objResult.columns[intCol].name.toLowerCase());
  if (!boolSameShape) return 'The statement does not describe the same columns as this result (it is not a plain SELECT).';
  if (objOrigin.tables.length === 0) return 'No column of this result comes straight from a table (expressions, functions or a subquery only).';

  return objOrigin.tables.map(objTable => {
    const indexesOf = (strColumn: string) => objOrigin.columns
      .map((objColumn, intCol) => (objColumn.schema === objTable.schema && objColumn.table === objTable.name && objColumn.column === strColumn ? intCol : -1))
      .filter(intCol => intCol >= 0);
    const arrKeyIndexes = objTable.keyColumns.map(indexesOf);
    const dicColumns = new Map<number, string>();
    objOrigin.columns.forEach((objColumn, intCol) => {
      if (objColumn.schema === objTable.schema && objColumn.table === objTable.name && objColumn.column
        && !NOT_EDITABLE_TYPE.test(objResult.columns[intCol].dataType)) dicColumns.set(intCol, objColumn.column);
    });
    const arrMissing = objTable.keyColumns.filter((_, intKey) => arrKeyIndexes[intKey].length === 0);
    const strReason = objTable.keyColumns.length === 0 ? 'no primary key'
      : arrMissing.length > 0 ? `add its key to the SELECT: ${arrMissing.join(', ')}`
        : dicColumns.size === 0 ? 'no editable column' : undefined;
    return {
      key: `${objTable.schema}.${objTable.name}`, label: `${objTable.schema}.${objTable.name}`,
      tableSql: qualifiedName(objTable.schema, objTable.name, strKind), keyColumns: objTable.keyColumns,
      keyIndexes: arrKeyIndexes, columns: dicColumns, reason: strReason,
    };
  });
}

/** Oracle: one target per table of the FROM clause, with the result columns the select list takes straight from it. */
export function rowIdTargets(objParsed: ParsedSelect, arrMap: ColumnMap, objResult: QueryResult): EditTarget[] {
  return objParsed.from.map((objItem, intFrom) => ({ objItem, intFrom })).filter(({ objItem }) => !objItem.subquery).map(({ objItem, intFrom }) => {
    const dicColumns = new Map<number, string>();
    arrMap.forEach((objOwner, intCol) => {
      if (objOwner?.from === intFrom && !NOT_EDITABLE_TYPE.test(objResult.columns[intCol].dataType)) dicColumns.set(intCol, objOwner.column);
    });
    return {
      key: `#${intFrom}`, label: objItem.alias ? `${objItem.ref} ${objItem.alias}` : objItem.ref, tableSql: objItem.ref, byRowId: true,
      keyColumns: ['ROWID'], keyIndexes: [], columns: dicColumns,
      reason: dicColumns.size === 0 ? `the SELECT takes no column straight from it; write ${nameOf(objItem)}.column` : undefined,
    };
  });
}

/**
 * A row can be edited when its key is whole and reads the same wherever the result repeats it (a self-join shows
 * two rows of the table at once). By ROWID: when the row has one (an outer join leaves it empty).
 */
export function rowEditable(objTarget: EditTarget, arrRow: unknown[], strRowId?: string | null) {
  if (objTarget.byRowId) return !!strRowId;
  if (objTarget.rowOk && !objTarget.rowOk(arrRow)) return false;
  return objTarget.keyIndexes.every(arrIndexes => {
    const objFirst = arrRow[arrIndexes[0]];
    return objFirst !== null && objFirst !== undefined && arrIndexes.every(intCol => arrRow[intCol] === objFirst);
  });
}

/** One UPDATE per changed row, found by the full primary key as it was read, or by its ROWID (arrRowIds: one per row). */
export function buildUpdates(strKind: DbKind, objTarget: EditTarget, objResult: QueryResult, dicChanges: Map<string, string | null>,
  arrRowIds?: (string | null)[]): RowUpdate[] {
  const dicRows = new Map<number, { col: number; value: string | null }[]>();
  for (const [strCell, strValue] of dicChanges) {
    const [intRow, intCol] = strCell.split(':').map(Number);
    if (!objTarget.columns.has(intCol)) continue;
    dicRows.set(intRow, [...(dicRows.get(intRow) ?? []), { col: intCol, value: strValue }]);
  }

  const typeOf = (intCol: number) => objResult.columns[intCol].dataType;
  const whereOf = rowFilter(strKind, objTarget, objResult, arrRowIds);
  return [...dicRows.entries()].sort(([intA], [intB]) => intA - intB).map(([intRow, arrCells]) => {
    // The same table column shown twice: the later edit wins.
    const dicSet = new Map<string, string>();
    for (const objCell of arrCells)
      dicSet.set(objTarget.columns.get(objCell.col)!, cellSql(objCell.value, typeOf(objCell.col), strKind));
    return {
      kind: 'update' as const, row: intRow, cells: arrCells,
      sql: `UPDATE ${objTarget.tableSql} SET ${
        [...dicSet].map(([strColumn, strLiteral]) => `${quoteIdent(strColumn, strKind)} = ${strLiteral}`).join(', ')} WHERE ${whereOf(intRow)}`,
    };
  });
}

/** WHERE of one loaded row: its full primary key as it was read, or its ROWID. */
function rowFilter(strKind: DbKind, objTarget: EditTarget, objResult: QueryResult, arrRowIds?: (string | null)[]) {
  return (intRow: number) => (objTarget.byRowId
    ? `ROWID = '${String(arrRowIds?.[intRow] ?? '').replace(/'/g, "''")}'`
    : objTarget.keyColumns.map((strColumn, intKey) => {
      const intCol = objTarget.keyIndexes[intKey][0];
      return `${quoteIdent(strColumn, strKind)} = ${sqlLiteral(String(objResult.rows[intRow][intCol]), objResult.columns[intCol].dataType, strKind)}`;
    }).join(' AND '));
}

/** One DELETE per row, found the same way as an UPDATE. */
export function buildDeletes(strKind: DbKind, objTarget: EditTarget, objResult: QueryResult, arrRows: number[], arrRowIds?: (string | null)[]): RowUpdate[] {
  const whereOf = rowFilter(strKind, objTarget, objResult, arrRowIds);
  return [...arrRows].sort((intA, intB) => intA - intB)
    .map(intRow => ({ kind: 'delete' as const, row: intRow, cells: [], sql: `DELETE FROM ${objTarget.tableSql} WHERE ${whereOf(intRow)}` }));
}

/**
 * One INSERT per new row (arrNew: a value per result column; intBase: the grid row of the first one).
 * Empty cells are left out, so the column's default (or a trigger) applies; dicAuto: table column -> the expression
 * an empty cell of it gets instead (the key's sequence or generator). hsProcedures: names (upper case) that are
 * procedures with one OUT parameter; `=NAME()` on one of them becomes a block that calls it first.
 */
export function buildInserts(strKind: DbKind, objTarget: EditTarget, objResult: QueryResult, arrNew: (string | null)[][], intBase: number,
  dicAuto?: Map<string, string>, hsProcedures?: Set<string>): RowUpdate[] {
  return arrNew.map((arrRow, intNew) => {
    const dicSet = new Map<string, string>();
    const arrCells: { col: number; value: string | null }[] = [];
    for (const [intCol, strColumn] of objTarget.columns) {
      const strValue = arrRow[intCol];
      if (strValue === null || strValue === undefined || strValue === '') {
        if (dicAuto?.has(strColumn) && !dicSet.has(strColumn)) dicSet.set(strColumn, dicAuto.get(strColumn)!);
        continue;
      }
      dicSet.set(strColumn, cellSql(strValue, objResult.columns[intCol].dataType, strKind));
      arrCells.push({ col: intCol, value: strValue });
    }
    const arrDeclare: string[] = [];
    const arrCalls: string[] = [];
    for (const [strColumn, strValueSql] of dicSet) {
      if (!strValueSql.endsWith('()') || !hsProcedures?.has(strValueSql.slice(0, -2).toUpperCase())) continue;
      const strVariable = `v_${arrDeclare.length + 1}`;
      arrDeclare.push(`${strVariable} ${objTarget.tableSql}.${quoteIdent(strColumn, strKind)}%TYPE;`);
      arrCalls.push(`${strValueSql.slice(0, -2)}(${strVariable});`);
      dicSet.set(strColumn, strVariable);
    }
    const strFirst = [...objTarget.columns.values()][0];
    const strSql = dicSet.size > 0
      ? `INSERT INTO ${objTarget.tableSql} (${[...dicSet.keys()].map(strColumn => quoteIdent(strColumn, strKind)).join(', ')}) VALUES (${[...dicSet.values()].join(', ')})`
      // Oracle 11g has no DEFAULT VALUES.
      : strKind === 'Oracle' ? `INSERT INTO ${objTarget.tableSql} (${quoteIdent(strFirst, strKind)}) VALUES (NULL)`
        : `INSERT INTO ${objTarget.tableSql} DEFAULT VALUES`;
    return arrDeclare.length === 0 ? { kind: 'insert' as const, row: intBase + intNew, cells: arrCells, sql: strSql }
      : { kind: 'insert' as const, row: intBase + intNew, cells: arrCells, block: true, sql: `DECLARE ${arrDeclare.join(' ')} BEGIN ${arrCalls.join(' ')} ${strSql}; END;` };
  });
}

/** Only a SELECT (or WITH ... SELECT) result can be edited. */
export const looksLikeSelect = (strSql: string) => /^\s*(?:\(\s*)*(?:select|with)\b/i.test(strSql.replace(/^(?:\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/))*/, ''));
