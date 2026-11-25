/**
 * Editing the documents of a MongoDB find() in the grid: top-level fields only, each document found by its _id.
 * Changes become updateOne / insertOne / deleteOne in shell syntax, run like any other statement.
 */
import { shellValue, type FieldType } from '../importDocuments';
import type { QueryResult } from '../types';
import type { EditTarget, RowUpdate } from './editData';

const QUOTED = `(?:"[^"]*"|'[^']*')`;
// db[.getSiblingDB("x")].<collection | getCollection("y")].find(
const FIND = new RegExp(`^\\s*(db(?:\\s*\\.\\s*getSiblingDB\\(\\s*${QUOTED}\\s*\\))?\\s*\\.\\s*(?:getCollection\\(\\s*${QUOTED}\\s*\\)|[\\w$]+(?:\\.[\\w$]+)*?))\\s*\\.\\s*find\\s*\\(`);

// Result column types (MongoProvider.TypeName) a cell's text can be turned back into.
const TYPE_OF: Record<string, FieldType> = {
  string: 'string', int32: 'number', int64: 'number', double: 'number', decimal128: 'number', boolean: 'boolean', date: 'date', objectId: 'objectId',
  null: 'auto', undefined: 'auto', '': 'auto',
};

// The only calls a sub-document typed in a cell may hold: anything else would be run as script by the server.
const CONSTRUCTORS = new Set(['ObjectId', 'ISODate', 'Date', 'NumberLong', 'NumberInt', 'NumberDecimal', 'Timestamp', 'BinData', 'UUID', 'MinKey', 'MaxKey']);
const WORDS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'new']);
const CLOSER: Record<string, string> = { '{': '}', '[': ']', '(': ')' };

/**
 * The text of an object / array cell as one shell value: a single { } or [ ] holding only data (strings, numbers,
 * keys and the constructors above). Null for anything else: cut text (…), unbalanced brackets, operators, calls.
 */
export function documentLiteral(strValue: string, strType: string): string | null {
  const strText = strValue.trim();
  if (!(strType === 'array' ? /^\[[\s\S]*\]$/ : /^\{[\s\S]*\}$/).test(strText)) return null;
  // Strings hold anything: judge the rest.
  const strBare = strText.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
  if (/'|"(?!")/.test(strBare.replace(/""/g, '')) || /[^\w\s{}[\](),:.+\-"$]/.test(strBare)) return null;
  if (/(?<!\d)\.|\.(?!\d)/.test(strBare)) return null; // a dot only inside a number: no member access
  const arrOpen: string[] = [];
  for (let intAt = 0; intAt < strBare.length; intAt++) {
    const strChar = strBare[intAt];
    if (CLOSER[strChar]) arrOpen.push(CLOSER[strChar]);
    else if (strChar === '}' || strChar === ']' || strChar === ')') {
      if (arrOpen.pop() !== strChar) return null;
      if (arrOpen.length === 0 && intAt < strBare.length - 1) return null; // one value, nothing after it
    }
  }
  if (arrOpen.length > 0) return null;
  for (const arrWord of strBare.matchAll(/(?<![\w$])[A-Za-z_$][\w$]*/g)) {
    const strNext = strBare.slice(arrWord.index + arrWord[0].length).trimStart()[0];
    if (strNext === ':') continue; // a key
    if (strNext === '(' ? !CONSTRUCTORS.has(arrWord[0]) : !WORDS.has(arrWord[0])) return null;
  }
  return strText;
}

/** A cell's text as a shell literal of the column's type; text that does not fit the type is kept as it reads. */
function fieldLiteral(strValue: string | null, strType: string) {
  if (strValue === null || strValue === '') return 'null';
  const strText = strValue.trim();
  // Not a whole document (the grid refuses those edits): stored as the text it is, never run.
  if (strType === 'object' || strType === 'array') return documentLiteral(strValue, strType) ?? JSON.stringify(strValue);
  if (strType === 'decimal128' && /^-?\d+(\.\d+)?$/.test(strText)) return `NumberDecimal("${strText}")`;
  if (strType === 'int64' && /^-?\d{1,18}$/.test(strText)) return `NumberLong("${strText}")`;
  return shellValue(strValue, TYPE_OF[strType] ?? 'auto') ?? shellValue(strValue, 'auto')!;
}

/** The _id of a row as the filter needs it; null when its type cannot be written back exactly. */
export function idLiteral(objValue: unknown, strType: string): string | null {
  if (objValue === null || objValue === undefined) return null;
  if (typeof objValue === 'number') return Number.isFinite(objValue) ? String(objValue) : null;
  if (typeof objValue !== 'string') return null;
  switch (strType) {
    case 'objectId': return /^[0-9a-f]{24}$/i.test(objValue) ? `ObjectId("${objValue}")` : null;
    case 'string': return JSON.stringify(objValue);
    case 'int64': return /^-?\d+$/.test(objValue) ? `NumberLong("${objValue}")` : null;
    case 'decimal128': return /^-?\d+(\.\d+)?$/.test(objValue) ? `NumberDecimal("${objValue}")` : null;
    case 'date': return shellValue(objValue, 'date');
    default: return null;
  }
}

/** The collection a find() reads, as the one thing that can be edited. A string: why nothing can. */
export function mongoTarget(strSql: string, objResult: QueryResult): EditTarget | string {
  const arrFind = FIND.exec(strSql);
  if (!arrFind) return 'only the documents of a db.collection.find(...) can be edited.';
  const intId = objResult.columns.findIndex(objColumn => objColumn.name === '_id');
  if (intId < 0) return 'the documents are found by _id: keep it in the projection.';
  const strIdType = objResult.columns[intId].dataType;

  const dicColumns = new Map<number, string>();
  objResult.columns.forEach((objColumn, intCol) => {
    // Binary and mixed-type columns show as text that cannot be turned back; a dotted name would be read as a path.
    if (intCol !== intId && (objColumn.dataType in TYPE_OF || objColumn.dataType === 'object' || objColumn.dataType === 'array')
      && !/^\$|\./.test(objColumn.name)) dicColumns.set(intCol, objColumn.name);
  });
  const strCollection = arrFind[1].trim(); // as written: a quoted name may hold spaces
  return {
    key: 'mongo', label: strCollection, tableSql: strCollection, keyColumns: ['_id'], keyIndexes: [[intId]], columns: dicColumns,
    rowOk: arrRow => idLiteral(arrRow[intId], strIdType) !== null,
    cellError: (intCol, strValue) => {
      const strType = objResult.columns[intCol].dataType;
      if ((strType !== 'object' && strType !== 'array') || documentLiteral(strValue, strType) !== null) return null;
      return strValue.trimEnd().endsWith('…')
        ? `${objResult.columns[intCol].name}: the value is longer than the grid holds, so it cannot be saved from here.`
        : `${objResult.columns[intCol].name} holds ${strType === 'array' ? 'an array: type it as [ … ]' : 'a document: type it as { … }'} with data only (strings, numbers, ObjectId(…), ISODate(…)…).`;
    },
    reason: dicColumns.size === 0 ? 'no field with a simple value' : undefined,
  };
}

/** updateOne ($set) per changed document, insertOne per new row, deleteOne per marked row; each by _id. */
export function buildMongoStatements(objTarget: EditTarget, objResult: QueryResult, dicChanges: Map<string, string | null>,
  arrNew: (string | null)[][], intBase: number, arrDeleted: number[]): RowUpdate[] {
  const intId = objTarget.keyIndexes[0][0];
  const typeOf = (intCol: number) => objResult.columns[intCol].dataType;
  const filterOf = (intRow: number) => `{ _id: ${idLiteral(objResult.rows[intRow][intId], typeOf(intId))} }`;
  const fields = (arrCells: { col: number; value: string | null }[]) =>
    arrCells.map(objCell => `${JSON.stringify(objTarget.columns.get(objCell.col))}: ${fieldLiteral(objCell.value, typeOf(objCell.col))}`).join(', ');

  const dicRows = new Map<number, { col: number; value: string | null }[]>();
  for (const [strCell, strValue] of dicChanges) {
    const [intRow, intCol] = strCell.split(':').map(Number);
    if (objTarget.columns.has(intCol)) dicRows.set(intRow, [...(dicRows.get(intRow) ?? []), { col: intCol, value: strValue }]);
  }
  const arrUpdates = [...dicRows.entries()].sort(([intA], [intB]) => intA - intB).map(([intRow, arrCells]): RowUpdate => ({
    // matched, not modified: writing the value a field already has modifies nothing.
    kind: 'update', row: intRow, cells: arrCells, check: 'matched', sql: `${objTarget.tableSql}.updateOne(${filterOf(intRow)}, { $set: { ${fields(arrCells)} } })`,
  }));
  const arrInserts = arrNew.map((arrRow, intNew): RowUpdate => {
    // Empty cells are left out; _id is not a column here, so the server gives a new one.
    const arrCells = [...objTarget.columns.keys()].map(intCol => ({ col: intCol, value: arrRow[intCol] ?? null }))
      .filter(objCell => objCell.value !== null && objCell.value !== '');
    return { kind: 'insert', row: intBase + intNew, cells: arrCells, sql: `${objTarget.tableSql}.insertOne({ ${fields(arrCells)} })` };
  });
  const arrDeletes = [...arrDeleted].sort((intA, intB) => intA - intB)
    .map((intRow): RowUpdate => ({ kind: 'delete', row: intRow, cells: [], sql: `${objTarget.tableSql}.deleteOne(${filterOf(intRow)})` }));
  return [...arrUpdates, ...arrInserts, ...arrDeletes];
}
