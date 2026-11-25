import type {
  Connection, ConnectionInput, DbObjectInfo, ExportResult, HistoryEntry, ObjectDetail, QueryError, QueryResult, RoutineArgument, RoutineInfo,
  RedisDatabaseInfo, RedisKeyPage, ResultOrigin, RoutineResult, SchemaMetadata, Snippet, UpdateConfig, UpdateInfo, Workspace,
} from './types';

declare global {
  interface Window {
    __DBSTUDIO_TOKEN__?: string;
    /** Called by the host window just before it closes. */
    __dbstudioSaveTabs?: () => void;
  }
}

/** Thrown for any non-2xx response; carries the server's QueryError. */
export class ApiError extends Error {
  constructor(public status: number, public detail: QueryError) {
    super(detail.message);
  }
}

/** fetch with the JSON header and the app token; throws ApiError for a non-2xx answer. */
async function send(strPath: string, objInit: RequestInit = {}): Promise<Response> {
  const objHeaders = new Headers(objInit.headers);
  if (objInit.body) objHeaders.set('Content-Type', 'application/json');
  if (window.__DBSTUDIO_TOKEN__) objHeaders.set('X-DbStudio-Token', window.__DBSTUDIO_TOKEN__);

  const objResponse = await fetch(`/api${strPath}`, { ...objInit, headers: objHeaders });
  if (!objResponse.ok) {
    let objDetail: QueryError = { message: `${objResponse.status} ${objResponse.statusText}` };
    try { objDetail = await objResponse.json(); } catch { /* empty body */ }
    throw new ApiError(objResponse.status, objDetail);
  }
  return objResponse;
}

async function request<T>(strPath: string, objInit: RequestInit = {}): Promise<T> {
  const objResponse = await send(strPath, objInit);
  return objResponse.status === 204 || objResponse.status === 202 ? (undefined as T) : objResponse.json();
}

type StreamLine =
  | { t: 'columns'; columns: QueryResult['columns'] }
  | { t: 'rows'; rows: unknown[][] }
  | { t: 'done'; result: QueryResult; streamed: boolean }
  | { t: 'error'; error: QueryError };

/**
 * POST /query/stream: NDJSON lines. onProgress gets the result as it grows (the same object each time,
 * its rows array filled in place); the promise resolves with the complete result, as api.query does.
 */
async function queryStream(objBody: object, onProgress?: (objPartial: QueryResult) => void): Promise<QueryResult> {
  const objResponse = await send('/query/stream', { method: 'POST', body: JSON.stringify(objBody) });
  const objReader = objResponse.body!.getReader();
  const objDecoder = new TextDecoder();
  let objLive: QueryResult | null = null;
  let strPending = '';

  for (;;) {
    const { done: boolDone, value: arrChunk } = await objReader.read();
    strPending += boolDone ? objDecoder.decode() : objDecoder.decode(arrChunk, { stream: true });
    const arrLines = strPending.split('\n');
    strPending = arrLines.pop() ?? '';
    if (boolDone && strPending.trim()) arrLines.push(strPending);

    for (const strLine of arrLines) {
      if (!strLine.trim()) continue;
      const objLine = JSON.parse(strLine) as StreamLine;
      if (objLine.t === 'columns') {
        objLive = { columns: objLine.columns, rows: [], recordsAffected: -1, truncated: false, elapsedMs: 0 };
        onProgress?.(objLive);
      } else if (objLine.t === 'rows') {
        if (!objLive) continue;
        for (const arrRow of objLine.rows) objLive.rows.push(arrRow);
        onProgress?.(objLive);
      } else if (objLine.t === 'error') {
        throw new ApiError(400, objLine.error);
      } else {
        return objLine.streamed && objLive ? { ...objLine.result, rows: objLive.rows } : objLine.result;
      }
    }
    if (boolDone) throw new ApiError(0, { message: 'The answer ended before the statement finished.' });
  }
}

export const api = {
  listConnections: () => request<Connection[]>('/connections'),
  saveConnection: (objConnection: ConnectionInput) =>
    request<Connection>('/connections', { method: 'POST', body: JSON.stringify(objConnection) }),
  deleteConnection: (strId: string) => request<void>(`/connections/${strId}`, { method: 'DELETE' }),
  testConnection: (objConnection: ConnectionInput) =>
    request<{ ok: boolean }>('/connections/test', { method: 'POST', body: JSON.stringify(objConnection) }),

  metadata: (strId: string, boolRefresh = false, strSchema?: string) => {
    const objQuery = new URLSearchParams();
    if (boolRefresh) objQuery.set('refresh', 'true');
    if (strSchema) objQuery.set('schema', strSchema);
    return request<SchemaMetadata>(`/connections/${strId}/metadata${objQuery.size ? `?${objQuery}` : ''}`);
  },

  /** File > Open: the Open dialog, then the chosen scripts. [] when cancelled. */
  openSqlFiles: () => request<{ path: string; name: string; text: string }[]>('/files/open', { method: 'POST' }),
  /** strPath null: ask where to save (Save as). Resolves to undefined when that dialog is cancelled. */
  saveSqlFile: (strPath: string | null, strName: string, strText: string) =>
    request<{ path: string; name: string } | undefined>('/files/save', {
      method: 'POST', body: JSON.stringify({ path: strPath, name: strName, text: strText }),
    }),

  /** Opens the Save dialog (Excel or CSV). Resolves to undefined when the user cancels. */
  pickExportFile: (strFileName: string, strFormat: 'csv' | 'xlsx' = 'xlsx') =>
    request<{ path: string } | undefined>('/export/pick', { method: 'POST', body: JSON.stringify({ fileName: strFileName, format: strFormat }) }),
  /** Streams every row of the statement into the picked file, on the server. Stop it with cancel(strQueryId). */
  exportQuery: (strQueryId: string, strConnectionId: string, strSql: string, strPath: string) =>
    request<ExportResult>('/export', {
      method: 'POST',
      body: JSON.stringify({ queryId: strQueryId, connectionId: strConnectionId, sql: strSql, path: strPath }),
    }),
  /** Shows an exported file in Explorer. */
  revealExport: (strPath: string) => request<void>('/export/reveal', { method: 'POST', body: JSON.stringify({ path: strPath }) }),

  /** Where the user dragged the boxes of one diagram; {} when nothing is saved. */
  diagramLayout: (strConnectionId: string, strDiagram: string) =>
    request<Record<string, { x: number; y: number }>>(`/connections/${strConnectionId}/diagram-layout?${new URLSearchParams({ diagram: strDiagram })}`),
  /** An empty layout forgets the diagram. */
  saveDiagramLayout: (strConnectionId: string, strDiagram: string, dicBoxes: Record<string, { x: number; y: number }>) =>
    request<void>(`/connections/${strConnectionId}/diagram-layout?${new URLSearchParams({ diagram: strDiagram })}`,
      { method: 'PUT', body: JSON.stringify(dicBoxes) }),

  /**
   * boolFull false: only the quick detail grids, no DDL (object tree).
   * strSection: only that grid, including the slow ones the quick load leaves out.
   */
  objectDetail: (strConnectionId: string, objObject: DbObjectInfo, boolFull = true, strSection?: string) => {
    const objQuery = new URLSearchParams({ schema: objObject.schema, name: objObject.name, type: objObject.type });
    if (objObject.signature != null) objQuery.set('signature', objObject.signature);
    if (!boolFull) objQuery.set('ddl', 'false');
    if (strSection) objQuery.set('section', strSection);
    return request<ObjectDetail>(`/connections/${strConnectionId}/object?${objQuery}`);
  },

  routineInfo: (strConnectionId: string, objRoutine: DbObjectInfo) => {
    const objQuery = new URLSearchParams({ schema: objRoutine.schema, name: objRoutine.name, type: objRoutine.type });
    if (objRoutine.signature != null) objQuery.set('signature', objRoutine.signature);
    return request<RoutineInfo>(`/connections/${strConnectionId}/routine?${objQuery}`);
  },
  /** Stopped with cancel(strQueryId), like a query. */
  executeRoutine: (strQueryId: string, strConnectionId: string, objRoutine: DbObjectInfo, arrArguments: RoutineArgument[], intMaxRows = 1000) =>
    request<RoutineResult>('/routine/execute', {
      method: 'POST',
      body: JSON.stringify({
        queryId: strQueryId, connectionId: strConnectionId, routine: objRoutine, arguments: arrArguments, maxRows: intMaxRows,
      }),
    }),

  query: (strQueryId: string, strConnectionId: string, strSql: string, intMaxRows = 1000,
    strSessionId?: string, boolAutoCommit = true) =>
    request<QueryResult>('/query', {
      method: 'POST',
      body: JSON.stringify({
        queryId: strQueryId, connectionId: strConnectionId, sql: strSql, maxRows: intMaxRows,
        sessionId: strSessionId, autoCommit: boolAutoCommit,
      }),
    }),
  /** api.query for the editor: the grid can show rows while the statement is still being read. */
  queryStream: (strQueryId: string, strConnectionId: string, strSql: string, intMaxRows: number,
    strSessionId: string | undefined, boolAutoCommit: boolean, onProgress?: (objPartial: QueryResult) => void) =>
    queryStream({
      queryId: strQueryId, connectionId: strConnectionId, sql: strSql, maxRows: intMaxRows,
      sessionId: strSessionId, autoCommit: boolAutoCommit,
    }, onProgress),
  /** Which table each column of a SELECT comes from (the statement is described, not run). */
  describeResult: (strConnectionId: string, strSql: string) =>
    request<ResultOrigin>('/query/describe', { method: 'POST', body: JSON.stringify({ connectionId: strConnectionId, sql: strSql }) }),
  cancel: (strQueryId: string) => request<void>(`/query/${strQueryId}/cancel`, { method: 'POST' }),

  /** UI settings kept by the app (sidebar width...): the browser's own storage is lost on every start. */
  updateConfig: () => request<UpdateConfig>('/update/config'),
  /** password: undefined keeps the saved one, '' means the link has none. */
  saveUpdateConfig: (strUrl: string, strPassword?: string) =>
    request<UpdateConfig>('/update/config', { method: 'PUT', body: JSON.stringify({ url: strUrl, password: strPassword ?? null }) }),
  checkUpdate: () => request<UpdateInfo>('/update/check', { method: 'POST' }),
  /** Resolves when the new exe has been started; the app closes a moment later. */
  applyUpdate: () => request<void>('/update/apply', { method: 'POST' }),
  updateProgress: () => request<{ received: number; total?: number | null } | undefined>('/update/progress'),

  settings: () => request<Record<string, unknown>>('/settings'),
  /** Merges: keys not sent are kept, null removes a key. */
  saveSettings: (dicValues: Record<string, unknown>) => request<void>('/settings', { method: 'PUT', body: JSON.stringify(dicValues) }),

  redisDatabases: (strConnectionId: string) => request<RedisDatabaseInfo[]>(`/connections/${strConnectionId}/redis/databases`),
  /** One SCAN page of keys with their types. strCursor '0' starts the scan. */
  redisKeys: (strConnectionId: string, intDatabase: number, strPattern: string, strCursor: string) =>
    request<RedisKeyPage>(`/connections/${strConnectionId}/redis/keys?${new URLSearchParams({
      db: String(intDatabase), pattern: strPattern, cursor: strCursor,
    })}`),

  /** The editor tabs of the last run; null when there are none (or they are older than a week). */
  workspace: () => request<Workspace | null>('/workspace'),
  saveWorkspace: (objWorkspace: Workspace) => request<void>('/workspace', { method: 'PUT', body: JSON.stringify(objWorkspace) }),
  /** Blocking, for the moment the window closes: an async request would die with the page. */
  saveWorkspaceSync: (objWorkspace: Workspace) => {
    const objRequest = new XMLHttpRequest();
    objRequest.open('PUT', '/api/workspace', false);
    objRequest.setRequestHeader('Content-Type', 'application/json');
    if (window.__DBSTUDIO_TOKEN__) objRequest.setRequestHeader('X-DbStudio-Token', window.__DBSTUDIO_TOKEN__);
    objRequest.send(JSON.stringify(objWorkspace));
  },

  snippets: () => request<Snippet[]>('/snippets'),
  /** Replaces the whole list; resolves to the list as stored. */
  saveSnippets: (arrSnippets: Snippet[]) => request<Snippet[]>('/snippets', { method: 'PUT', body: JSON.stringify(arrSnippets) }),

  /** Statements run on the connection, newest first. */
  history: (strConnectionId: string) => request<HistoryEntry[]>(`/connections/${strConnectionId}/history`),
  addHistory: (strConnectionId: string, strSql: string, intElapsedMs: number, intRows: number | null, strError: string | null) =>
    request<void>('/history', {
      method: 'POST',
      body: JSON.stringify({ connectionId: strConnectionId, sql: strSql, elapsedMs: intElapsedMs, rows: intRows, error: strError }),
    }),
  clearHistory: (strConnectionId: string) => request<void>(`/connections/${strConnectionId}/history`, { method: 'DELETE' }),

  openSession: (strSessionId: string, strConnectionId: string) =>
    request<void>(`/sessions/${strSessionId}/open`, { method: 'POST', body: JSON.stringify({ connectionId: strConnectionId }) }),
  commit: (strSessionId: string) => request<void>(`/sessions/${strSessionId}/commit`, { method: 'POST' }),
  rollback: (strSessionId: string) => request<void>(`/sessions/${strSessionId}/rollback`, { method: 'POST' }),
  closeSession: (strSessionId: string) => request<void>(`/sessions/${strSessionId}`, { method: 'DELETE' }),
};
