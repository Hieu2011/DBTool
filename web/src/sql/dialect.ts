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

// Text inside a LIKE pattern: the user's characters stand for themselves.
const likeText = (strText: string) => strText.replace(/[\\%_]/g, '\\$&').replace(/'/g, "''");
const PG_USER_SCHEMAS = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'`;

/**
 * Objects whose name holds the text, in every schema the login can see (the tree only filters what it loaded).
 * Columns: schema, name, type, signature. At most 300 rows, the closest names first. Null: not for this kind.
 */
export function findObjectsQuery(strKind: DbKind, strText: string): string | null {
  if (strKind === 'Oracle') {
    const strName = likeText(strText.toUpperCase());
    return `SELECT * FROM (
  SELECT owner, object_name, object_type, CAST(NULL AS VARCHAR2(1)) AS signature
  FROM all_objects
  WHERE object_name LIKE '%${strName}%' ESCAPE '\\'
    AND object_type IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW', 'PROCEDURE', 'FUNCTION', 'PACKAGE', 'TRIGGER', 'SEQUENCE', 'TYPE')
  ORDER BY CASE WHEN object_name LIKE '${strName}' ESCAPE '\\' THEN 0 WHEN object_name LIKE '${strName}%' ESCAPE '\\' THEN 1 ELSE 2 END, object_name, owner
) WHERE ROWNUM <= 300`;
  }
  if (strKind === 'PostgreSql') {
    const strName = likeText(strText);
    return `SELECT * FROM (
  SELECT n.nspname AS schema, c.relname AS name,
         CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END AS type,
         NULL::text AS signature
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND ${PG_USER_SCHEMAS} AND c.relname ILIKE '%${strName}%' ESCAPE '\\'
  UNION ALL
  SELECT n.nspname, p.proname, CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, pg_get_function_identity_arguments(p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prokind IN ('f', 'p') AND ${PG_USER_SCHEMAS} AND p.proname ILIKE '%${strName}%' ESCAPE '\\'
) found
ORDER BY CASE WHEN name ILIKE '${strName}' ESCAPE '\\' THEN 0 WHEN name ILIKE '${strName}%' ESCAPE '\\' THEN 1 ELSE 2 END, name, schema
LIMIT 300`;
  }
  return null;
}

/**
 * Sessions of the server, the blocked ones first. The first column (Oracle: the first two) identifies a session
 * for killSessionQuery; blocked_by names the session(s) holding the lock it waits for. Null: not for this kind.
 */
export function sessionsQuery(strKind: DbKind): string | null {
  if (strKind === 'Oracle') {
    return `SELECT s.sid, s.serial# AS serial, s.username, s.status, s.blocking_session AS blocked_by, s.seconds_in_wait AS wait_s, s.event,
       s.osuser, s.machine, s.program, TO_CHAR(s.logon_time, 'YYYY-MM-DD HH24:MI:SS') AS logon_time,
       (SELECT MAX(q.sql_text) FROM v$sqlarea q WHERE q.sql_id = s.sql_id) AS sql_text
FROM v$session s
WHERE s.type = 'USER'
ORDER BY CASE WHEN s.blocking_session IS NOT NULL THEN 0 WHEN s.status = 'ACTIVE' THEN 1 ELSE 2 END, s.sid`;
  }
  if (strKind === 'PostgreSql') {
    return `SELECT a.pid, a.usename AS username, a.datname AS database, a.state,
       array_to_string(pg_blocking_pids(a.pid), ', ') AS blocked_by,
       a.wait_event_type || ': ' || a.wait_event AS waiting,
       date_trunc('second', now() - a.query_start)::text AS running,
       a.application_name AS application, a.client_addr::text AS client, left(a.query, 500) AS query
FROM pg_stat_activity a
WHERE a.backend_type = 'client backend' AND a.pid <> pg_backend_pid()
ORDER BY CASE WHEN cardinality(pg_blocking_pids(a.pid)) > 0 THEN 0 WHEN a.state = 'active' THEN 1 ELSE 2 END, a.pid`;
  }
  return null;
}

/** Ends a session listed by sessionsQuery (arrRow: one of its rows). boolCancel (PostgreSQL): only its running statement. Null: the row has no usable id. */
export function killSessionQuery(strKind: DbKind, arrRow: unknown[], boolCancel = false): string | null {
  const isId = (objValue: unknown) => /^\d+$/.test(String(objValue ?? ''));
  if (strKind === 'Oracle') return isId(arrRow[0]) && isId(arrRow[1]) ? `ALTER SYSTEM KILL SESSION '${arrRow[0]},${arrRow[1]}' IMMEDIATE` : null;
  if (strKind === 'PostgreSql') return isId(arrRow[0]) ? `SELECT ${boolCancel ? 'pg_cancel_backend' : 'pg_terminate_backend'}(${arrRow[0]})` : null;
  return null;
}
