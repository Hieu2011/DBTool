/** "Generate script as": INSERT / UPDATE statements and WHERE clauses written from cells of a result grid. Text only, nothing is run. */
import { sqlLiteral } from '../importData';
import type { DbKind, QueryResult } from '../types';
import { binaryHex, isBinaryType } from './editData';
import { quoteIdent } from './identifiers';

export type ScriptKind = 'insert' | 'update' | 'whereIn' | 'whereAndOr';

export interface ScriptSource {
  kind: DbKind;
  result: QueryResult;
  /** Grid rows to write, in order. */
  rows: number[];
  /** The table as a statement names it. */
  table: string;
  /** Result column -> column of the table, for every column that belongs to it. */
  names: Map<number, string>;
  /** The result columns to write: the selected cells' columns. */
  cols: number[];
  /** Result columns holding the primary key; empty when it is not known. */
  keys: number[];
  /** Why the key is not known (UPDATE then finds the row by every column). */
  keyNote?: string;
}

const IN_CHUNK = 1000; // Oracle: at most 1000 items in one IN list

export function generateScript(strScript: ScriptKind, objSource: ScriptSource): string {
  const { kind: strKind, result: objResult, rows: arrRows, table: strTable, names: dicNames, cols: arrCols } = objSource;
  const name = (intCol: number) => quoteIdent(dicNames.get(intCol) ?? objResult.columns[intCol].name, strKind);
  const literal = (intRow: number, intCol: number) => {
    const objValue = objResult.rows[intRow][intCol];
    const strType = objResult.columns[intCol].dataType;
    if (objValue === null || objValue === undefined) return 'NULL';
    const strValue = typeof objValue === 'object' ? JSON.stringify(objValue) : String(objValue);
    if (!isBinaryType(strType)) return sqlLiteral(strValue, strType, strKind);
    // Binary always through the hex function; a value the server cut (over 64 bytes) cannot be written back.
    const strHex = binaryHex(strValue);
    if (strHex === null) return 'NULL /* binary value too long to copy */';
    return strKind === 'Oracle' ? `HEXTORAW('${strHex}')` : `decode('${strHex}', 'hex')`;
  };
  const equals = (intRow: number, intCol: number) => {
    const strValue = literal(intRow, intCol);
    return strValue.startsWith('NULL') ? `${name(intCol)} IS NULL` : `${name(intCol)} = ${strValue}`;
  };

  if (strScript === 'insert') {
    const strColumns = arrCols.map(name).join(', ');
    return arrRows.map(intRow => `INSERT INTO ${strTable} (${strColumns})\nVALUES (${arrCols.map(intCol => literal(intRow, intCol)).join(', ')});`).join('\n\n') + '\n';
  }

  if (strScript === 'update') {
    const boolKeyed = objSource.keys.length > 0;
    // No key: the row is found by every column it shows, never by a guess.
    const arrBy = boolKeyed ? objSource.keys : [...dicNames.keys()];
    const arrSet = arrCols.filter(intCol => !objSource.keys.includes(intCol));
    if (arrSet.length === 0) return `-- ${strTable}: the selected cells are all key columns, there is nothing to SET.\n`;
    const strNote = boolKeyed ? '' : `-- ${objSource.keyNote ?? `The primary key of ${strTable} is not known`}: each row is found by all its columns. Check the WHERE before running.\n`;
    return strNote + arrRows.map(intRow =>
      `UPDATE ${strTable}\nSET ${arrSet.map(intCol => `${name(intCol)} = ${literal(intRow, intCol)}`).join(',\n    ')}\nWHERE ${arrBy.map(intCol => equals(intRow, intCol)).join(' AND ')};`).join('\n\n') + '\n';
  }

  // WHERE scripts are whole statements, ready to run.
  const strSelect = `SELECT *\nFROM ${strTable}\n`;

  if (strScript === 'whereIn') {
    const intCol = arrCols[0];
    const arrValues = [...new Set(arrRows.map(intRow => literal(intRow, intCol)).filter(strValue => !strValue.startsWith('NULL')))];
    if (arrValues.length === 0) return `${strSelect}WHERE ${name(intCol)} IS NULL;\n`;
    const arrLists: string[] = [];
    for (let intAt = 0; intAt < arrValues.length; intAt += IN_CHUNK) {
      const arrPart = arrValues.slice(intAt, intAt + IN_CHUNK);
      // short lists on one line, long ones a value per line
      arrLists.push(arrPart.join(', ').length <= 100 ? `${name(intCol)} IN (${arrPart.join(', ')})` : `${name(intCol)} IN (\n  ${arrPart.join(',\n  ')}\n)`);
    }
    return `${strSelect}WHERE ${arrLists.length > 1 ? `(${arrLists.join('\n   OR ')})` : arrLists[0]};\n`;
  }

  // One (a = 1 AND b = 2) per row, over the selected columns.
  const arrConditions = arrRows.map(intRow => arrCols.map(intCol => equals(intRow, intCol)).join(' AND '));
  return `${strSelect}WHERE ${arrConditions.length === 1 ? arrConditions[0] : arrConditions.map(strItem => `(${strItem})`).join('\n   OR ')};\n`;
}
