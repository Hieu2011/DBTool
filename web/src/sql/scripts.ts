/**
 * Statement templates for the object tree's "Generate" menu. They open in an editor tab and are
 * never run automatically. Values are `:name` placeholders and WHERE is left as a comment, so a
 * template run by accident fails instead of touching every row.
 */
import type { ColumnMeta, DbKind, DbObjectInfo } from '../types';
import { countQuery, mongoCollection } from './dialect';
import { qualifiedName, quoteIdent } from './identifiers';

const mongoOf = (objObject: DbObjectInfo) => mongoCollection(objObject.schema, objObject.name);
/** `{ name: null, total: null }`: top-level fields only, _id left to the server. */
const mongoFields = (arrColumns: ColumnMeta[]) => arrColumns
  .filter(objColumn => objColumn.name !== '_id' && !objColumn.name.includes('.'))
  .map(objColumn => `  ${/^[A-Za-z_$][\w$]*$/.test(objColumn.name) ? objColumn.name : JSON.stringify(objColumn.name)}: null`)
  .join(',\n');

const nameOf = (objObject: DbObjectInfo, strKind: DbKind) => qualifiedName(objObject.schema, objObject.name, strKind);

const columnList = (arrColumns: ColumnMeta[], strKind: DbKind, strIndent: string) =>
  arrColumns.map(objColumn => quoteIdent(objColumn.name, strKind)).join(`,\n${strIndent}`);

const placeholder = (objColumn: ColumnMeta) => `:${objColumn.name.toLowerCase().replace(/\W/g, '_')}`;

export function selectScript(objObject: DbObjectInfo, arrColumns: ColumnMeta[], strKind: DbKind) {
  if (strKind === 'MongoDb') return `${mongoOf(objObject)}.find({ }).limit(100);`;
  const strColumns = arrColumns.length > 0 ? columnList(arrColumns, strKind, '       ') : '*';
  return `SELECT ${strColumns}\nFROM ${nameOf(objObject, strKind)};`;
}

export function insertScript(objObject: DbObjectInfo, arrColumns: ColumnMeta[], strKind: DbKind) {
  if (strKind === 'MongoDb') return `${mongoOf(objObject)}.insertOne({\n${mongoFields(arrColumns)}\n});`;
  return `INSERT INTO ${nameOf(objObject, strKind)} (\n    ${columnList(arrColumns, strKind, '    ')}\n)\n`
    + `VALUES (\n    ${arrColumns.map(placeholder).join(',\n    ')}\n);`;
}

export function updateScript(objObject: DbObjectInfo, arrColumns: ColumnMeta[], strKind: DbKind) {
  // No filter given: the server rejects the call instead of updating every document.
  if (strKind === 'MongoDb') return `${mongoOf(objObject)}.updateMany(/* filter */, { $set: {\n${mongoFields(arrColumns)}\n} });`;
  const strAssignments = arrColumns
    .map(objColumn => `${quoteIdent(objColumn.name, strKind)} = ${placeholder(objColumn)}`)
    .join(',\n    ');
  return `UPDATE ${nameOf(objObject, strKind)}\nSET ${strAssignments}\nWHERE /* condition */;`;
}

export const deleteScript = (objObject: DbObjectInfo, strKind: DbKind) =>
  strKind === 'MongoDb' ? `${mongoOf(objObject)}.deleteMany(/* filter */);` :
  `DELETE FROM ${nameOf(objObject, strKind)}\nWHERE /* condition */;`;

export const countScript = (objObject: DbObjectInfo, strKind: DbKind) => countQuery(strKind, objObject.schema, objObject.name);

export function dropScript(objObject: DbObjectInfo, strKind: DbKind) {
  if (strKind === 'MongoDb') return `${mongoOf(objObject)}.drop();`;
  // PostgreSQL needs the argument types to pick one overload.
  const strArguments = strKind === 'PostgreSql' && objObject.signature != null ? `(${objObject.signature})` : '';
  return `DROP ${objObject.type} ${nameOf(objObject, strKind)}${strArguments};`;
}

/** Call template for a procedure or function. Arguments are left for the user to fill in. */
export function executeScript(objObject: DbObjectInfo, strKind: DbKind) {
  const strCall = `${nameOf(objObject, strKind)}(/* arguments */)`;
  if (strKind === 'Oracle') {
    return objObject.type === 'FUNCTION'
      ? `SELECT ${strCall} FROM dual;`
      : `BEGIN\n  ${strCall};\nEND;\n/`;
  }
  return objObject.type === 'FUNCTION' ? `SELECT ${strCall};` : `CALL ${strCall};`;
}

export const nextValueScript = (objObject: DbObjectInfo, strKind: DbKind) =>
  strKind === 'Oracle'
    ? `SELECT ${nameOf(objObject, strKind)}.NEXTVAL FROM dual;`
    : `SELECT nextval('${nameOf(objObject, strKind).replace(/'/g, "''")}');`;
