/** What differs per kind of database when the UI writes a statement itself. */
import type { DbKind } from '../types';
import { qualifiedName } from './identifiers';
import type { SqlDialect } from './statements';

export const dialectOf = (strKind: DbKind): SqlDialect =>
  (strKind === 'Oracle' ? 'oracle' : strKind === 'MongoDb' ? 'mongo' : strKind === 'Redis' ? 'redis' : 'pgsql');

/** PostgreSQL / Oracle: SQL text, transactions, the SQL formatter and parser apply. */
export const isSqlKind = (strKind: DbKind) => strKind === 'PostgreSql' || strKind === 'Oracle';

/** Auto-commit / Manual applies: SQL databases, and MongoDB (replica set or sharded cluster). */
export const hasTransactions = (strKind: DbKind) => isSqlKind(strKind) || strKind === 'MongoDb';

/** Monaco language id of the editors. */
export const editorLanguage = (strKind: DbKind) =>
  (strKind === 'PostgreSql' ? 'pgsql' : strKind === 'MongoDb' ? 'mongodb' : strKind === 'Redis' ? 'redis' : 'sql');

/** A key or value as the Redis console reads it back: quoted only when it has to be. */
export function redisQuote(strText: string) {
  // eslint-disable-next-line no-control-regex
  if (strText !== '' && !/[\s"'\\\u0000-\u001f]/.test(strText)) return strText;
  // The escapes RedisProvider.SplitCommand reads back: \n \r \t \xHH.
  const dicEscapes: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
  // eslint-disable-next-line no-control-regex
  return `"${strText.replace(/["\\\u0000-\u001f]/g, strChar =>
    dicEscapes[strChar] ?? `\\x${strChar.charCodeAt(0).toString(16).padStart(2, '0')}`)}"`;
}

/** `db.getSiblingDB("shop").getCollection("orders")`: works whatever database the tab is in and whatever the name holds. */
export const mongoCollection = (strDatabase: string, strName: string) =>
  `db.getSiblingDB(${JSON.stringify(strDatabase)}).getCollection(${JSON.stringify(strName)})`;

/** Every row of a table / every document of a collection. */
export const selectAllQuery = (strKind: DbKind, strSchema: string, strName: string) =>
  (strKind === 'MongoDb' ? `${mongoCollection(strSchema, strName)}.find({})` : `SELECT * FROM ${qualifiedName(strSchema, strName, strKind)}`);

/** One row, one value: how many rows / documents. */
export const countQuery = (strKind: DbKind, strSchema: string, strName: string) =>
  (strKind === 'MongoDb'
    ? `${mongoCollection(strSchema, strName)}.countDocuments({})`
    : `SELECT COUNT(*) FROM ${qualifiedName(strSchema, strName, strKind)}`);
