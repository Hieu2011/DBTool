/**
 * Short keys the editor always offers (seldt, seltop, upd…), per kind of database. Bodies use Monaco's snippet
 * syntax: ${1:name} tab stops (the same number repeats the text), $CURRENT_YEAR… for today, "\\$" for a real dollar.
 * A snippet of the user's with the same prefix replaces the built-in one.
 */
export type SnippetDialect = 'oracle' | 'pgsql' | 'mongo' | 'redis';

export interface BuiltinSnippet { prefix: string; name: string; body: string }

const TODAY = '$CURRENT_YEAR-$CURRENT_MONTH-$CURRENT_DATE';
const MONTH_START = '$CURRENT_YEAR-$CURRENT_MONTH-01';
const FROM = 'FROM ${1:table} ${2:T}';

const item = (strPrefix: string, strName: string, ...arrLines: string[]): BuiltinSnippet => ({ prefix: strPrefix, name: strName, body: arrLines.join('\n') });

// Written the same way on both.
const SQL_COMMON: BuiltinSnippet[] = [
  item('sel', 'SELECT … WHERE', 'SELECT ${2:T}.*', FROM, 'WHERE ${2:T}.${3:column} = ${4:value};$0'),
  item('selall', 'SELECT * FROM table', 'SELECT * FROM ${1:table};$0'),
  item('selob', 'SELECT … ORDER BY', 'SELECT ${2:T}.*', FROM, 'WHERE ${3:1 = 1}', 'ORDER BY ${2:T}.${4:column} ${5:DESC};$0'),
  item('selin', 'SELECT … WHERE … IN (…)', 'SELECT ${2:T}.*', FROM, "WHERE ${2:T}.${3:column} IN (${4:'a', 'b'});$0"),
  item('sellike', 'SELECT … WHERE … LIKE', 'SELECT ${2:T}.*', FROM, "WHERE UPPER(${2:T}.${3:column}) LIKE UPPER('%${4:text}%');$0"),
  item('selnull', 'SELECT … WHERE … IS NULL', 'SELECT ${2:T}.*', FROM, 'WHERE ${2:T}.${3:column} IS ${4:NOT }NULL;$0'),
  item('selcnt', 'SELECT COUNT(*)', 'SELECT COUNT(*)', FROM, 'WHERE ${3:1 = 1};$0'),
  item('selgb', 'SELECT … GROUP BY', 'SELECT ${2:T}.${3:column}, COUNT(*) AS TOTAL', FROM, 'GROUP BY ${2:T}.${3:column}', 'ORDER BY TOTAL DESC;$0'),
  item('seldup', 'Find duplicated values', 'SELECT ${2:T}.${3:column}, COUNT(*) AS TOTAL', FROM, 'GROUP BY ${2:T}.${3:column}', 'HAVING COUNT(*) > 1', 'ORDER BY TOTAL DESC;$0'),
  item('selmax', 'Row with the largest value', 'SELECT ${2:T}.*', FROM, 'WHERE ${2:T}.${3:column} = (SELECT MAX(${3:column}) FROM ${1:table});$0'),
  item('seljoin', 'SELECT … INNER JOIN', 'SELECT ${2:A}.*, ${4:B}.*', 'FROM ${1:table_a} ${2:A}', 'INNER JOIN ${3:table_b} ${4:B} ON ${4:B}.${5:column} = ${2:A}.${5:column}', 'WHERE ${6:1 = 1};$0'),
  item('selleft', 'SELECT … LEFT JOIN', 'SELECT ${2:A}.*, ${4:B}.*', 'FROM ${1:table_a} ${2:A}', 'LEFT JOIN ${3:table_b} ${4:B} ON ${4:B}.${5:column} = ${2:A}.${5:column}', 'WHERE ${6:1 = 1};$0'),
  item('selex', 'SELECT … WHERE EXISTS', 'SELECT ${2:A}.*', 'FROM ${1:table_a} ${2:A}', 'WHERE ${5:NOT }EXISTS (SELECT 1 FROM ${3:table_b} ${4:B} WHERE ${4:B}.${6:column} = ${2:A}.${6:column});$0'),
  item('seldel', 'Rows not deleted (ISDELETED = 0)', 'SELECT ${2:T}.*', FROM, 'WHERE ${2:T}.ISDELETED = 0', '  AND ${3:1 = 1};$0'),
  item('cte', 'WITH … AS (…)', 'WITH ${1:X} AS (', '  SELECT ${2:*} FROM ${3:table}', ')', 'SELECT * FROM ${1:X};$0'),
  item('ins', 'INSERT INTO … VALUES', 'INSERT INTO ${1:table} (${2:columns})', 'VALUES (${3:values});$0'),
  item('inssel', 'INSERT INTO … SELECT', 'INSERT INTO ${1:target} (${2:columns})', 'SELECT ${2:columns}', 'FROM ${3:source}', 'WHERE ${4:1 = 1};$0'),
  // No alias: PostgreSQL does not take one on the column being set.
  item('upd', 'UPDATE … SET … WHERE', 'UPDATE ${1:table}', 'SET ${2:column} = ${3:value}', 'WHERE ${4:key} = ${5:value};$0'),
  item('del', 'DELETE … WHERE', 'DELETE FROM ${1:table} ${2:T}', 'WHERE ${2:T}.${3:key} = ${4:value};$0'),
  item('case', 'CASE WHEN … END', 'CASE', '  WHEN ${1:condition} THEN ${2:value}', '  ELSE ${3:other}', 'END$0'),
];

const ORACLE: BuiltinSnippet[] = [
  item('seldt', 'Rows of one day (today)', 'SELECT ${2:T}.*', FROM,
    "WHERE ${2:T}.${3:CREATEDDATE} >= TO_DATE('${4:" + TODAY + "}', 'YYYY-MM-DD')",
    "  AND ${2:T}.${3:CREATEDDATE} < TO_DATE('${4:" + TODAY + "}', 'YYYY-MM-DD') + 1;$0"),
  item('selbt', 'Rows between two days (this month)', 'SELECT ${2:T}.*', FROM,
    "WHERE ${2:T}.${3:CREATEDDATE} >= TO_DATE('${4:" + MONTH_START + "}', 'YYYY-MM-DD')",
    "  AND ${2:T}.${3:CREATEDDATE} < TO_DATE('${5:" + TODAY + "}', 'YYYY-MM-DD') + 1;$0"),
  item('selrn', 'First n rows (ROWNUM)', 'SELECT ${2:T}.*', FROM, 'WHERE ROWNUM <= ${3:100};$0'),
  item('seltop', 'Top n rows by a column', 'SELECT * FROM (', '  SELECT ${2:T}.*', '  FROM ${1:table} ${2:T}', '  ORDER BY ${2:T}.${3:column} ${4:DESC}', ')', 'WHERE ROWNUM <= ${5:100};$0'),
  item('selpage', 'One page of rows (ROW_NUMBER)', 'SELECT * FROM (', '  SELECT ${2:T}.*, ROW_NUMBER() OVER (ORDER BY ${2:T}.${3:column}) AS RN', '  FROM ${1:table} ${2:T}', ')',
    'WHERE RN BETWEEN ${4:1} AND ${5:50};$0'),
  item('merge', 'MERGE (insert or update)', 'MERGE INTO ${1:table} T', 'USING (SELECT ${2:value} AS ${3:key} FROM dual) S ON (T.${3:key} = S.${3:key})',
    'WHEN MATCHED THEN UPDATE SET T.${4:column} = ${5:value}', 'WHEN NOT MATCHED THEN INSERT (${3:key}, ${4:column}) VALUES (S.${3:key}, ${5:value});$0'),
  item('today', 'Start of today', 'TRUNC(SYSDATE)$0'),
  item('todate', 'TO_DATE with a format', "TO_DATE('${1:" + TODAY + "}', 'YYYY-MM-DD')$0"),
  item('todt', 'TO_DATE with date and time', "TO_DATE('${1:" + TODAY + " 00:00:00}', 'YYYY-MM-DD HH24:MI:SS')$0"),
  item('tochar', 'TO_CHAR of a date', "TO_CHAR(${1:column}, '${2:YYYY-MM-DD HH24:MI:SS}')$0"),
  item('nvl', 'NVL(value, default)', 'NVL(${1:column}, ${2:0})$0'),
  item('dual', 'SELECT … FROM dual', 'SELECT ${1:SYSDATE} FROM dual;$0'),
  item('blk', 'Anonymous block', 'BEGIN', '  ${0:NULL;}', 'END;'),
  item('decl', 'Block with variables', 'DECLARE', '  ${1:v_value} ${2:NUMBER};', 'BEGIN', '  ${0:NULL;}', 'END;'),
  item('dbout', 'DBMS_OUTPUT.PUT_LINE', "DBMS_OUTPUT.PUT_LINE(${1:'text'});$0"),
  item('forl', 'FOR … IN (SELECT …) LOOP', 'FOR r IN (SELECT ${1:*} FROM ${2:table}) LOOP', '  ${0:NULL;}', 'END LOOP;'),
  item('callcur', 'Call a procedure that returns a cursor', 'BEGIN', '  ${1:schema.procedure}(${2:arguments, }:cur);', 'END;$0'),
];

const PGSQL: BuiltinSnippet[] = [
  item('seldt', 'Rows of one day (today)', 'SELECT ${2:T}.*', FROM,
    "WHERE ${2:T}.${3:created_date} >= DATE '${4:" + TODAY + "}'",
    "  AND ${2:T}.${3:created_date} < DATE '${4:" + TODAY + "}' + INTERVAL '1 day';$0"),
  item('selbt', 'Rows between two days (this month)', 'SELECT ${2:T}.*', FROM,
    "WHERE ${2:T}.${3:created_date} >= DATE '${4:" + MONTH_START + "}'",
    "  AND ${2:T}.${3:created_date} < DATE '${5:" + TODAY + "}' + INTERVAL '1 day';$0"),
  item('selrn', 'First n rows (LIMIT)', 'SELECT ${2:T}.*', FROM, 'LIMIT ${3:100};$0'),
  item('seltop', 'Top n rows by a column', 'SELECT ${2:T}.*', FROM, 'ORDER BY ${2:T}.${3:column} ${4:DESC}', 'LIMIT ${5:100};$0'),
  item('selpage', 'One page of rows (LIMIT / OFFSET)', 'SELECT ${2:T}.*', FROM, 'ORDER BY ${2:T}.${3:column}', 'LIMIT ${4:50} OFFSET ${5:0};$0'),
  item('merge', 'INSERT … ON CONFLICT (insert or update)', 'INSERT INTO ${1:table} (${2:key}, ${3:column})', 'VALUES (${4:key_value}, ${5:value})',
    'ON CONFLICT (${2:key}) DO UPDATE SET ${3:column} = EXCLUDED.${3:column};$0'),
  item('today', 'Start of today', 'CURRENT_DATE$0'),
  item('todate', 'A date literal', "DATE '${1:" + TODAY + "}'$0"),
  item('todt', 'A timestamp literal', "TIMESTAMP '${1:" + TODAY + " 00:00:00}'$0"),
  item('tochar', 'to_char of a date', "to_char(${1:column}, '${2:YYYY-MM-DD HH24:MI:SS}')$0"),
  item('nvl', 'COALESCE(value, default)', 'COALESCE(${1:column}, ${2:0})$0'),
  item('blk', 'DO block', 'DO \\$\\$', 'BEGIN', '  ${0:NULL;}', 'END \\$\\$;'),
  item('decl', 'DO block with variables', 'DO \\$\\$', 'DECLARE', '  ${1:v_value} ${2:integer};', 'BEGIN', '  ${0:NULL;}', 'END \\$\\$;'),
  item('dbout', 'RAISE NOTICE', "RAISE NOTICE '${1:value: %}', ${2:v_value};$0"),
  item('explain', 'EXPLAIN ANALYZE', 'EXPLAIN (ANALYZE, BUFFERS)', '${0:SELECT 1};'),
  item('callcur', 'Call a function that returns a cursor', 'SELECT ${1:schema.function}(${2:arguments});$0'),
];

const MONGO: BuiltinSnippet[] = [
  item('find', 'find with a filter', 'db.${1:collection}.find({ ${2:field}: ${3:value} })$0'),
  item('findid', 'find by _id', 'db.${1:collection}.find({ _id: ObjectId("${2:id}") })$0'),
  item('finddt', 'Documents of one day (today)', 'db.${1:collection}.find({ ${2:createdDate}: { \\$gte: ISODate("${3:' + TODAY + '}T00:00:00Z"), \\$lt: ISODate("${3:' + TODAY + '}T23:59:59Z") } })$0'),
  item('findtop', 'find, sorted, first n', 'db.${1:collection}.find({ ${2} }).sort({ ${3:_id}: ${4:-1} }).limit(${5:100})$0'),
  item('findin', 'find … $in', 'db.${1:collection}.find({ ${2:field}: { \\$in: [${3:values}] } })$0'),
  item('findlike', 'find by a regular expression', 'db.${1:collection}.find({ ${2:field}: { \\$regex: "${3:text}", \\$options: "i" } })$0'),
  item('cnt', 'countDocuments', 'db.${1:collection}.countDocuments({ ${2} })$0'),
  item('dist', 'distinct values of a field', 'db.${1:collection}.distinct("${2:field}")$0'),
  item('agg', 'aggregate: match, group, sort', 'db.${1:collection}.aggregate([', '  { \\$match: { ${2} } },', '  { \\$group: { _id: "\\$${3:field}", total: { \\$sum: 1 } } },', '  { \\$sort: { total: -1 } }', '])$0'),
  item('ins', 'insertOne', 'db.${1:collection}.insertOne({ ${2:field}: ${3:value} })$0'),
  item('upd', 'updateOne … $set', 'db.${1:collection}.updateOne({ ${2:_id}: ${3:value} }, { \\$set: { ${4:field}: ${5:value} } })$0'),
  item('updmany', 'updateMany … $set', 'db.${1:collection}.updateMany({ ${2:field}: ${3:value} }, { \\$set: { ${4:field}: ${5:value} } })$0'),
  item('del', 'deleteOne', 'db.${1:collection}.deleteOne({ ${2:_id}: ${3:value} })$0'),
  item('foreach', 'Loop over the documents (JavaScript)', 'db.${1:collection}.find({ ${2} }).forEach(doc => {', '  ${0:printjson(doc);}', '});'),
];

const REDIS: BuiltinSnippet[] = [
  item('get', 'GET key', 'GET ${1:key}$0'),
  item('set', 'SET key value', 'SET ${1:key} "${2:value}"$0'),
  item('setex', 'SET with a lifetime in seconds', 'SET ${1:key} "${2:value}" EX ${3:3600}$0'),
  item('scan', 'SCAN keys by pattern', 'SCAN 0 MATCH ${1:prefix:*} COUNT ${2:500}$0'),
  item('ttl', 'TTL of a key', 'TTL ${1:key}$0'),
  item('exp', 'EXPIRE a key', 'EXPIRE ${1:key} ${2:3600}$0'),
  item('type', 'TYPE of a key', 'TYPE ${1:key}$0'),
  item('del', 'DEL key', 'DEL ${1:key}$0'),
  item('hget', 'HGETALL key', 'HGETALL ${1:key}$0'),
  item('hset', 'HSET key field value', 'HSET ${1:key} ${2:field} "${3:value}"$0'),
  item('lrange', 'Whole list', 'LRANGE ${1:key} 0 ${2:-1}$0'),
  item('smem', 'Members of a set', 'SMEMBERS ${1:key}$0'),
  item('zrange', 'Sorted set with scores', 'ZRANGE ${1:key} 0 ${2:-1} WITHSCORES$0'),
  item('info', 'INFO section', 'INFO ${1:memory}$0'),
  item('dbsize', 'Number of keys', 'DBSIZE$0'),
];

/** A snippet body as plain code: tab stops show their default text, today's date as a word. */
export const snippetCode = (strBody: string) => strBody
  .replace(/\$CURRENT_YEAR-\$CURRENT_MONTH-\$CURRENT_DATE/g, 'today').replace(/\$CURRENT_YEAR-\$CURRENT_MONTH-01/g, 'month start')
  .replace(/\$\{\d+:([^{}]*)\}/g, '$1').replace(/\$\{\d+\}|\$\d+/g, '').replace(/\\\$/g, '$');

/**
 * How a snippet shows in the suggestion list: its key, then the code it writes on one line, and what it is for
 * at the right edge.
 */
export function snippetLabel(objSnippet: { prefix: string; name: string; body: string }) {
  const strLine = snippetCode(objSnippet.body).replace(/\s+/g, ' ').trim();
  return { label: objSnippet.prefix, detail: `  ${strLine.length > 64 ? `${strLine.slice(0, 63)}…` : strLine}`, description: objSnippet.name };
}

/** PostgreSQL style: everything in lower case but quoted text (date formats) and the $VARIABLES of the snippet syntax. */
const lowerSql = (strBody: string) => strBody.replace(/'[^']*'|\$[A-Z_]+|[A-Z][A-Z_0-9]*/g, strPart => (/^['$]/.test(strPart) ? strPart : strPart.toLowerCase()));

const BY_DIALECT: Record<SnippetDialect, BuiltinSnippet[]> = {
  oracle: [...SQL_COMMON, ...ORACLE],
  pgsql: [...SQL_COMMON, ...PGSQL].map(objSnippet => ({
    ...objSnippet, body: lowerSql(objSnippet.body),
    name: objSnippet.name.replace(/\b[A-Z]{2,}[A-Z_]*\b/g, strWord => strWord.toLowerCase()), // the description too: select … where
  })),
  mongo: MONGO, redis: REDIS,
};

/** The built-in snippets of a dialect, without the prefixes the user has snippets of their own for. */
export function builtinSnippets(strDialect: SnippetDialect, arrUser: { prefix: string }[]): BuiltinSnippet[] {
  const hsTaken = new Set(arrUser.map(objSnippet => objSnippet.prefix));
  return BY_DIALECT[strDialect].filter(objSnippet => !hsTaken.has(objSnippet.prefix));
}
