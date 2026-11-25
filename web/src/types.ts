export type DbKind = 'PostgreSql' | 'Oracle' | 'MongoDb' | 'Redis';
export type EnvColor = 'slate' | 'green' | 'amber' | 'red';

export interface Connection {
  id: string;
  name: string;
  kind: DbKind;
  host: string;
  port: number;
  database: string;
  username: string;
  hasPassword: boolean;
  extra?: string | null;
  color: EnvColor;
}

/** What the connection dialog sends. Empty password on edit = keep the stored one. */
export interface ConnectionInput extends Omit<Connection, 'hasPassword'> {
  password?: string;
}

export interface ResultColumn { name: string; dataType: string }

export interface QueryResult {
  columns: ResultColumn[];
  rows: unknown[][];
  recordsAffected: number;
  truncated: boolean;
  elapsedMs: number;
  /** Further result sets of the same statement (it returned several cursors). */
  more?: QueryResult[] | null;
  /** Document databases: row i as formatted JSON, for the JSON view. */
  documents?: string[] | null;
}

/** A file the server wrote into the Downloads folder. truncated: the format's row limit cut the data (Excel: 1,048,576 rows). */
export interface ExportResult { path: string; rows: number; truncated: boolean; elapsedMs: number }

/** One statement run from an editor. rows: returned or affected, when known. */
export interface HistoryEntry {
  id: string; connectionId: string; sql: string; at: string; elapsedMs: number; rows?: number | null; error?: string | null;
}

/** SQL inserted by typing its prefix. body uses snippet syntax: $1, ${1:name}, $0. */
export interface Snippet { id: string; name: string; prefix: string; body: string }

export interface RedisDatabaseInfo { index: number; keys: number }
/** type: STRING, HASH, LIST, SET, ZSET, STREAM, or a module type. */
export interface RedisKeyInfo { key: string; type: string }
/** One SCAN page; cursor "0" means the scan is complete. */
export interface RedisKeyPage { cursor: string; keys: RedisKeyInfo[] }

/** Where a result column comes from; schema / table / column are null for an expression. */
export interface ColumnOrigin { name: string; schema?: string | null; table?: string | null; column?: string | null }
/** keyColumns: the table's primary key, empty when it has none. */
export interface EditableTable { schema: string; name: string; keyColumns: string[] }
/** columns: one entry per result column, in order. */
export interface ResultOrigin { columns: ColumnOrigin[]; tables: EditableTable[] }

export interface QueryError { message: string; position?: number | null; code?: string | null }

export interface ColumnMeta { name: string; dataType: string }
/** rows: estimate from the catalog statistics, absent when the database has none. */
export interface TableMeta { schema: string; name: string; type: string; columns: ColumnMeta[]; rows?: number | null }
/** Function, procedure, sequence, package... signature tells PostgreSQL overloads apart. */
export interface DbObjectInfo { schema: string; name: string; type: string; signature?: string | null }
export interface SchemaMetadata {
  tables: TableMeta[];
  loadedAt: string;
  objects: DbObjectInfo[];
  objectsError?: string | null;
  /** Set when the database loads one schema at a time (Oracle): every schema name. */
  schemas?: string[] | null;
  /** With schemas: the ones whose tables / objects are loaded. The first is the login's own schema. */
  loadedSchemas?: string[] | null;
}

/** mode: IN, OUT, INOUT, or RETURN (a function's return value). */
export interface RoutineParameter { name: string; dataType: string; mode: string; position: number }
export interface RoutineInfo { parameters: RoutineParameter[] }
/** value null = SQL NULL. */
export interface RoutineArgument { name: string; position: number; value: string | null }
export interface RoutineOutput { name: string; value?: string | null }
export interface RoutineResult { results: ObjectSection[]; outputs: RoutineOutput[]; elapsedMs: number }

export interface ObjectSection { title: string; result: QueryResult }
export interface ObjectDetail { sections: ObjectSection[]; ddl?: string | null; ddlError?: string | null; comment?: string | null }

export interface UpdateConfig { url?: string | null; hasPassword: boolean; currentVersion: string; canApply: boolean; builtOn?: string | null }
export interface UpdateInfo { currentVersion: string; latestVersion: string; available: boolean; notes?: string | null; releasedOn?: string | null }

export const KIND_LABEL: Record<DbKind, string> = {
  PostgreSql: 'PostgreSQL',
  Oracle: 'Oracle',
  MongoDb: 'MongoDB',
  Redis: 'Redis',
};

export const DEFAULT_PORT: Record<DbKind, number> = {
  PostgreSql: 5432,
  Oracle: 1521,
  MongoDb: 27017,
  Redis: 6379,
};
