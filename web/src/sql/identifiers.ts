import type { DbKind } from '../types';

// Not exhaustive: quoting a name that didn't need it is harmless, the reverse is a syntax error.
const RESERVED = new Set([
  'access', 'add', 'all', 'alter', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'audit', 'between',
  'both', 'by', 'case', 'cast', 'check', 'cluster', 'collate', 'column', 'comment', 'compress', 'connect',
  'constraint', 'create', 'current_date', 'current_user', 'date', 'decimal', 'default', 'delete', 'desc',
  'distinct', 'do', 'drop', 'else', 'end', 'except', 'exclusive', 'exists', 'false', 'fetch', 'file', 'float',
  'for', 'foreign', 'from', 'grant', 'group', 'having', 'identified', 'immediate', 'in', 'increment', 'index',
  'initially', 'insert', 'integer', 'intersect', 'into', 'is', 'leading', 'level', 'like', 'limit', 'lock', 'long',
  'minus', 'mode', 'modify', 'not', 'nowait', 'null', 'number', 'of', 'offset', 'on', 'online', 'only', 'option',
  'or', 'order', 'primary', 'prior', 'public', 'raw', 'references', 'rename', 'resource', 'revoke', 'row', 'rows',
  'select', 'session', 'session_user', 'set', 'share', 'size', 'smallint', 'some', 'start', 'synonym', 'table',
  'then', 'to', 'trailing', 'trigger', 'true', 'uid', 'union', 'unique', 'update', 'user', 'using', 'validate',
  'values', 'varchar', 'varchar2', 'variadic', 'view', 'when', 'whenever', 'where', 'window', 'with',
]);

/** Catalog name -> SQL identifier. Quoted only when the bare name would not resolve to the same object. */
export function quoteIdent(strName: string, strKind: DbKind) {
  if (strKind === 'MongoDb' || strKind === 'Redis') return strName; // no identifier quoting there
  // Unquoted names fold to upper case on Oracle, lower case on PostgreSQL.
  const boolPlain = strKind === 'Oracle' ? /^[A-Z][A-Z0-9_$#]*$/.test(strName) : /^[a-z_][a-z0-9_$]*$/.test(strName);
  return boolPlain && !RESERVED.has(strName.toLowerCase()) ? strName : `"${strName.replace(/"/g, '""')}"`;
}

export const qualifiedName = (strSchema: string, strName: string, strKind: DbKind) =>
  `${quoteIdent(strSchema, strKind)}.${quoteIdent(strName, strKind)}`;
