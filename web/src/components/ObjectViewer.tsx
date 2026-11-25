import { useEffect, useMemo, useRef, useState } from 'react';
import { monaco } from '../monaco';
import { api, ApiError } from '../api';
import { countQuery, editorLanguage, selectAllQuery } from '../sql/dialect';
import { qualifiedName } from '../sql/identifiers';
import type { Connection, DbObjectInfo, ObjectDetail, QueryResult, SchemaMetadata } from '../types';
import { envVar } from '../envColor';
import { IconClose } from './icons';
import { ResultGrid } from './ResultGrid';
import { EditableResult } from './EditableResult';
import { TABLE_LIKE } from './ObjectTree';
import { KeysEditor } from './KeysEditor';
import { RoutineDiagram } from './RoutineDiagram';
import { TableDiagram } from './TableDiagram';
import { TableEditor } from './TableEditor';
import { TableImport } from './TableImport';
import { CollectionImport } from './CollectionImport';
import { RedisValueEditor } from './RedisValueEditor';

interface Props {
  objConnection: Connection;
  objObject: DbObjectInfo;
  boolActive: boolean;
  /** Opens a query tab on this connection holding the SQL. */
  onOpenSql: (strSql: string, boolAutoRun: boolean) => void;
  /** Opens the Execute form (procedures and functions). */
  onExecute: () => void;
  /** Column lists of the related tables in the diagram. */
  objMetadata?: SchemaMetadata;
  /** Opens another object's tab (a table double-clicked in the diagram). */
  onOpenObject: (objObject: DbObjectInfo) => void;
  /** The table was renamed: the tab now shows it under the new name. */
  onRenamed: (strNewName: string) => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  // partial: the quick grids are in; the slow ones (code using the table), the DDL and the comment are still loading.
  | { status: 'done'; detail: ObjectDetail; partial?: boolean };

type DataState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; result: QueryResult };

const DATA_TAB = 'Data';
const DIAGRAM_TAB = 'Diagram';
const SOURCE_TAB = 'Source'; // routines: the code is a tab of its own instead of the pane below
const ROUTINE_TYPES = ['FUNCTION', 'PROCEDURE', 'PACKAGE']; // their diagram shows the tables they use
const COLUMNS_TAB = 'Columns'; // section title from the providers
const EDITABLE_TABS = [COLUMNS_TAB, 'Constraints', 'Indexes'];
const DATA_ROWS = 1000;

const errorMessage = (objEx: unknown) => (objEx instanceof ApiError ? objEx.detail.message : (objEx as Error).message);

function DdlView({ strDdl, strLanguage }: { strDdl: string; strLanguage: string }) {
  const refHost = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const objModel = monaco.editor.createModel(strDdl, strLanguage);
    const objEditor = monaco.editor.create(refHost.current!, {
      model: objModel,
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 20,
      scrollBeyondLastLine: false,
      renderLineHighlight: 'none',
      padding: { top: 8 },
    });
    return () => {
      objEditor.dispose();
      objModel.dispose();
    };
  }, [strDdl, strLanguage]);

  return <div ref={refHost} className="h-full" />;
}

const cellOf = (objGrid: QueryResult | undefined, arrRow: unknown[] | undefined, strColumn: string): unknown => {
  const intCol = objGrid?.columns.findIndex(objColumn => objColumn.name === strColumn) ?? -1;
  return intCol < 0 ? undefined : arrRow?.[intCol];
};

/** Columns covered by a PRIMARY KEY / UNIQUE constraint, read from the Constraints grid. */
function keyColumns(objConstraints: QueryResult | undefined, strType: string): Set<string> {
  const hsColumns = new Set<string>();
  for (const arrRow of objConstraints?.rows ?? []) {
    if (cellOf(objConstraints, arrRow, 'type') !== strType) continue;
    // Oracle lists the columns; PostgreSQL gives the definition, e.g. PRIMARY KEY (a, b).
    const strColumns = cellOf(objConstraints, arrRow, 'columns')
      ?? /\(([^)]*)\)/.exec(String(cellOf(objConstraints, arrRow, 'definition') ?? ''))?.[1] ?? '';
    for (const strColumn of String(strColumns).split(',')) hsColumns.add(strColumn.trim().replace(/^"|"$/g, ''));
  }
  return hsColumns;
}

/** Properties of the column selected in the Columns grid. */
function ColumnProperties({ objColumns, arrRow, objConstraints }: { objColumns: QueryResult; arrRow: unknown[] | undefined; objConstraints?: QueryResult }) {
  if (!arrRow) return <p className="p-3 text-muted">Select a column.</p>;

  const strName = String(cellOf(objColumns, arrRow, 'column') ?? '');
  const strFullType = String(cellOf(objColumns, arrRow, 'type') ?? '');
  // varchar2(4000 BYTE), numeric(20,4), timestamp(6) without time zone
  const arrType = /^(.*?)\s*\((\d+)(?:\s*,\s*(\d+))?(?:\s+\w+)?\)(.*)$/.exec(strFullType);
  const strBaseType = arrType ? `${arrType[1]}${arrType[4]}` : strFullType;
  const boolSized = /char|raw|bit|binary/i.test(strBaseType);
  const objNullable = cellOf(objColumns, arrRow, 'nullable');
  const objDefault = cellOf(objColumns, arrRow, 'default');
  const objComment = cellOf(objColumns, arrRow, 'comment');

  const flag = (boolValue: boolean) => (boolValue ? '✓' : '–');
  const arrGroups: [string, [string, string][]][] = [
    ['Main', [
      ['Name', strName],
      ['Primary', flag(keyColumns(objConstraints, 'PRIMARY KEY').has(strName))],
      ['Unique', flag(keyColumns(objConstraints, 'PRIMARY KEY').has(strName) || keyColumns(objConstraints, 'UNIQUE').has(strName))],
      ['Not Null', flag(objNullable === false || objNullable === 'N')],
    ]],
    ['Data Type', [
      ['Data Type', strBaseType],
      ['Length', arrType && boolSized ? arrType[2] : ''],
      ['Precision', arrType && !boolSized ? arrType[2] : ''],
      ['Scale', arrType && !boolSized ? arrType[3] ?? '0' : ''],
    ]],
    ['Other', [
      ...(objDefault === undefined ? [] : [['Default', objDefault === null ? '' : String(objDefault).trim()] as [string, string]]),
      ['Comment', objComment == null ? '' : String(objComment)],
    ]],
  ];

  return (
    <div className="text-xs" style={{ userSelect: 'text' }}>
      {arrGroups.map(([strGroup, arrItems]) => (
        <div key={strGroup}>
          <div className="border-b border-line bg-bg px-3 py-1 font-semibold">{strGroup}</div>
          {arrItems.map(([strLabel, strValue]) => (
            <div key={strLabel} className="flex border-b border-line/60">
              <span className="w-24 shrink-0 border-r border-line/60 px-3 py-1 text-muted">{strLabel}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words px-2 py-1 font-mono">{strValue}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function ObjectViewer({ objConnection, objObject, boolActive, objMetadata, onOpenSql, onExecute, onOpenObject, onRenamed }: Props) {
  const [objState, setObjState] = useState<LoadState>({ status: 'loading' });
  const [strActive, setStrActive] = useState<string | null>(null);
  const [strCount, setStrCount] = useState<string | null>(null);
  const [intCounted, setIntCounted] = useState<number | null>(null);
  const [intReload, setIntReload] = useState(0);
  const [objData, setObjData] = useState<DataState>({ status: 'idle' });
  // Whole-table export: null = idle. queryId is set while it runs (for Stop), path once the file exists.
  const [objExport, setObjExport] = useState<{ text: string; error: boolean; queryId?: string; path?: string } | null>(null);
  const [boolDdl, setBoolDdl] = useState(true);
  const [intDdlPercent, setIntDdlPercent] = useState(45);
  const refBody = useRef<HTMLDivElement>(null);
  const [intColumnRow, setIntColumnRow] = useState(0);
  const [strEditing, setStrEditing] = useState<string | null>(null); // section title being edited
  // Data tab shows the import screen for the file the user just picked.
  const [objImportFile, setObjImportFile] = useState<File | null>(null);
  const refImportPicker = useRef<HTMLInputElement>(null);

  const { schema: strSchema, name: strName, type: strType, signature: strSignature } = objObject;
  const strQualified = qualifiedName(strSchema, strName, objConnection.kind);
  const boolTableLike = TABLE_LIKE.has(strType);
  const strSelectAll = selectAllQuery(objConnection.kind, strSchema, strName);

  useEffect(() => {
    let boolStale = false;
    setObjState({ status: 'loading' });
    const objTarget = { schema: strSchema, name: strName, type: strType, signature: strSignature };
    // A table shows its columns as soon as the quick grids answer; the full answer (DDL, usages) replaces them when it comes.
    if (TABLE_LIKE.has(strType)) {
      api.objectDetail(objConnection.id, objTarget, false).then(
        objQuick => { if (!boolStale) setObjState(objPrev => (objPrev.status === 'loading' ? { status: 'done', detail: objQuick, partial: true } : objPrev)); },
        () => {}, // the full load reports the error
      );
    }
    api.objectDetail(objConnection.id, objTarget).then(
      objDetail => { if (!boolStale) setObjState({ status: 'done', detail: objDetail }); },
      objEx => {
        if (boolStale) return;
        // Keep the grids already shown; the error takes the DDL's place.
        setObjState(objPrev => (objPrev.status === 'done' && objPrev.partial
          ? { status: 'done', detail: { ...objPrev.detail, ddlError: errorMessage(objEx) } }
          : { status: 'error', message: errorMessage(objEx) }));
      },
    );
    return () => { boolStale = true; };
  }, [objConnection.id, strSchema, strName, strType, strSignature, intReload]);

  const countRows = async () => {
    setStrCount('Counting…');
    try {
      const objResult = await api.query(crypto.randomUUID(), objConnection.id, countQuery(objConnection.kind, strSchema, strName), 1);
      setStrCount(`${Number(objResult.rows[0]?.[0]).toLocaleString()} rows`);
      setIntCounted(Number(objResult.rows[0]?.[0]));
    } catch (objEx) {
      setStrCount(errorMessage(objEx));
    }
  };

  // Number on the Data tab: every row loaded = exact; else the last Count rows, the rows loaded so far, the catalog's estimate.
  const intEstimate = objMetadata?.tables.find(objTable => objTable.schema === strSchema && objTable.name === strName)?.rows;
  const strDataCount = objData.status === 'done' && !objData.result.truncated ? objData.result.rows.length.toLocaleString()
    : intCounted != null && Number.isFinite(intCounted) ? intCounted.toLocaleString()
    : objData.status === 'done' ? `${objData.result.rows.length.toLocaleString()}+`
    : intEstimate != null ? intEstimate.toLocaleString() : null;

  const loadData = async () => {
    setObjData({ status: 'loading' });
    try {
      const objResult = await api.query(crypto.randomUUID(), objConnection.id, strSelectAll, DATA_ROWS);
      setObjData({ status: 'done', result: objResult });
    } catch (objEx) {
      setObjData({ status: 'error', message: errorMessage(objEx) });
    }
  };

  // The user picks the file in the Save dialog, then the server reads the whole table into it: no row limit.
  const exportTable = async () => {
    let strPath: string | undefined;
    try {
      strPath = (await api.pickExportFile(`${strSchema}.${strName}`))?.path;
    } catch (objEx) {
      setObjExport({ text: errorMessage(objEx), error: true });
      return;
    }
    if (!strPath) return; // dialog cancelled

    const strQueryId = crypto.randomUUID();
    setObjExport({ text: `Exporting to ${strPath}…`, error: false, queryId: strQueryId });
    try {
      const objResult = await api.exportQuery(strQueryId, objConnection.id, strSelectAll, strPath);
      setObjExport({
        text: `Exported ${objResult.rows.toLocaleString()} rows in ${(objResult.elapsedMs / 1000).toFixed(1)} s to ${objResult.path}`
          + (objResult.truncated ? ' — an Excel sheet is full at 1,048,575 rows: the rest was left out, use CSV for everything' : ''),
        error: objResult.truncated, path: objResult.path,
      });
    } catch (objEx) {
      setObjExport({ text: errorMessage(objEx), error: true });
    }
  };

  const objDetail = objState.status === 'done' ? objState.detail : undefined;
  const boolPartial = objState.status === 'done' && !!objState.partial;
  const boolRoutine = ROUTINE_TYPES.includes(strType);
  const arrTabs = objDetail
    ? [
      ...(boolRoutine ? [SOURCE_TAB] : []), // first, so a routine opens on its code
      ...objDetail.sections.map(objSection => objSection.title),
      ...(boolTableLike ? [DATA_TAB] : []),
      ...(strType === 'TABLE' || boolRoutine ? [DIAGRAM_TAB] : []),
    ]
    : [];
  const strShown = strActive && arrTabs.includes(strActive) ? strActive : arrTabs[0];
  const objSection = objDetail?.sections.find(objItem => objItem.title === strShown);
  // Nothing to show on top (e.g. a procedure without sections): the DDL takes the whole tab.
  const boolTop = arrTabs.length > 0;
  // Under the structure tab (Columns / Fields) only: data and the other grids get the whole height.
  const boolDdlTab = strShown === arrTabs[0];
  const boolDdlShown = !boolRoutine && ((boolDdl && boolDdlTab) || !boolTop);

  const boolEditingShown = strEditing !== null && strEditing === strShown;
  const objColumnsGrid = objDetail?.sections.find(objItem => objItem.title === COLUMNS_TAB)?.result;
  const arrColumnNames = (objColumnsGrid?.rows ?? []).map(arrRow => String(cellOf(objColumnsGrid, arrRow, 'column') ?? ''));
  const objConstraintsGrid = objDetail?.sections.find(objItem => objItem.title === 'Constraints')?.result;
  const hsPrimary = useMemo(() => keyColumns(objConstraintsGrid, 'PRIMARY KEY'), [objConstraintsGrid]);
  const arrImportColumns = (objColumnsGrid?.rows ?? []).map(arrRow => ({
    name: String(cellOf(objColumnsGrid, arrRow, 'column') ?? ''), type: String(cellOf(objColumnsGrid, arrRow, 'type') ?? ''),
  }));
  const applied = () => { setStrEditing(null); setIntReload(intPrev => intPrev + 1); };
  // Redis: the Value grid can be edited; the TTL comes from the Properties grid ("42 s" / "no expiry").
  const boolRedis = objConnection.kind === 'Redis';
  const objRedisProperties = objDetail?.sections.find(objItem => objItem.title === 'Properties')?.result;
  const arrRedisTtl = /^(\d+) s$/.exec(String(objRedisProperties?.rows.find(arrRow => arrRow[0] === 'ttl')?.[1] ?? ''));
  // MongoDB: field types sampled from the collection, to type the imported values.
  const objFieldsGrid = objDetail?.sections.find(objItem => objItem.title === 'Fields')?.result;
  const dicFieldTypes = useMemo(() => Object.fromEntries((objFieldsGrid?.rows ?? []).map(arrRow => [String(arrRow[0]), String(arrRow[1] ?? '')])),
    [objFieldsGrid]);

  const openTab = (strTab: string) => {
    setStrActive(strTab);
    if (strTab === DATA_TAB && objData.status === 'idle') loadData();
  };

  // Drag the bar between the grid and the DDL.
  const resize = (objEvent: React.PointerEvent<HTMLDivElement>) => {
    if (!objEvent.currentTarget.hasPointerCapture(objEvent.pointerId) || !refBody.current) return;
    const objRect = refBody.current.getBoundingClientRect();
    const intPercent = ((objRect.bottom - objEvent.clientY) / objRect.height) * 100;
    setIntDdlPercent(Math.min(Math.max(intPercent, 15), 85));
  };

  return (
    <section className={`absolute inset-0 flex-col bg-panel ${boolActive ? 'flex' : 'hidden'}`}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3"
        style={{ boxShadow: `inset 3px 0 0 ${envVar(objConnection.color)}` }}>
        <span className="text-xs text-muted">{strType}</span>
        <span className="truncate font-medium" title={`${strSchema}.${strName}`}>
          {strSchema}.{strName}{strSignature != null && <span className="text-muted">({strSignature})</span>}
        </span>

        {(strType === 'PROCEDURE' || strType === 'FUNCTION') && (
          <button className="btn ml-2" onClick={onExecute} title="Fill in the parameters and run it">Execute…</button>
        )}
        {boolTableLike && (
          <>
            <button className="btn ml-2" onClick={() => onOpenSql(strSelectAll, true)}>Open data</button>
            <button className="btn" onClick={countRows} disabled={strCount === 'Counting…'}>Count rows</button>
            {strCount && <span className="truncate text-muted" title={strCount}>{strCount}</span>}
          </>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="truncate text-muted">{objConnection.name}</span>
          <button className="btn h-7" onClick={() => setIntReload(intPrev => intPrev + 1)} disabled={objState.status === 'loading'}>
            Refresh
          </button>
        </div>
      </div>

      {objState.status === 'loading' && <p className="p-4 text-muted">Loading…</p>}
      {objState.status === 'error' && (
        <p className="whitespace-pre-wrap p-4 font-mono text-xs text-danger" style={{ userSelect: 'text' }}>{objState.message}</p>
      )}

      {objDetail && boolTableLike && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-xs">
          <label className="flex min-w-0 items-center gap-1.5 text-muted">Name
            <input className="field h-6 w-48 font-mono text-xs" readOnly value={strName} />
          </label>
          <label className="flex min-w-0 items-center gap-1.5 text-muted">Owner
            <input className="field h-6 w-36 font-mono text-xs" readOnly value={strSchema} />
          </label>
          <label className="flex min-w-0 flex-1 items-center gap-1.5 text-muted">Comment
            <input className="field h-6 min-w-0 flex-1 text-xs" readOnly value={objDetail.comment ?? ''} title={objDetail.comment ?? ''} />
          </label>
        </div>
      )}

      {objDetail && (
        <div ref={refBody} className="flex min-h-0 flex-1 flex-col">
          {/* top: details and data */}
          {boolTop && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex h-8 shrink-0 items-end gap-px border-b border-line px-2" role="tablist">
                {arrTabs.map(strTab => (
                  <button key={strTab} role="tab" aria-selected={strTab === strShown} onClick={() => openTab(strTab)}
                    className={`h-7 whitespace-nowrap rounded-t border border-b-0 px-3 text-xs ${
                      strTab === strShown ? 'border-line bg-panel' : 'border-transparent text-muted hover:bg-hover'}`}>
                    {strTab}
                    {strTab === DATA_TAB && strDataCount && <span className="ml-1.5 text-muted" title="Rows">{strDataCount}</span>}
                    {strTab !== DATA_TAB && strTab !== DIAGRAM_TAB && strTab !== SOURCE_TAB && (
                      <span className="ml-1.5 text-muted">
                        {objDetail.sections.find(objItem => objItem.title === strTab)?.result.rows.length}
                      </span>
                    )}
                  </button>
                ))}
                <div className="mb-0.5 ml-auto flex items-center gap-1.5">
                  {strShown && strType === 'TABLE' && EDITABLE_TABS.includes(strShown) && !boolEditingShown && (
                    <button className="btn h-6 px-2" title="Add, change or drop; the script is shown before it runs"
                      onClick={() => setStrEditing(strShown)}>
                      {strShown === COLUMNS_TAB ? 'Edit table…' : `Edit ${strShown.toLowerCase()}…`}
                    </button>
                  )}
                  {strShown === SOURCE_TAB && objDetail.ddl && (
                    <>
                      <button className="btn h-6 px-2" onClick={() => navigator.clipboard.writeText(objDetail.ddl ?? '')}>Copy</button>
                      <button className="btn h-6 px-2" onClick={() => onOpenSql(objDetail.ddl ?? '', false)}>Open in editor</button>
                    </>
                  )}
                  {!boolRoutine && boolDdlTab && (
                    <button className={`btn h-6 px-2 ${boolDdl ? 'text-accent' : ''}`} aria-pressed={boolDdl}
                      title="Show or hide the DDL below" onClick={() => setBoolDdl(boolPrev => !boolPrev)}>DDL</button>
                  )}
                </div>
              </div>

              <div className="min-h-0 flex-1">
                {objSection && boolEditingShown && (objSection.title === COLUMNS_TAB
                  ? (
                    <TableEditor objConnection={objConnection} strTable={strQualified} strSchema={strSchema} strName={strName}
                      objColumns={objSection.result} strComment={objDetail.comment ?? ''}
                      objConstraints={objDetail.sections.find(objItem => objItem.title === 'Constraints')?.result}
                      objIndexes={objDetail.sections.find(objItem => objItem.title === 'Indexes')?.result}
                      onOpenSql={onOpenSql} onClose={() => setStrEditing(null)}
                      onApplied={strNewName => { applied(); if (strNewName) onRenamed(strNewName); }} />
                  )
                  : (
                    <KeysEditor key={objSection.title} objConnection={objConnection} strMode={objSection.title as 'Constraints' | 'Indexes'}
                      strTable={strQualified} strSchema={strSchema} objGrid={objSection.result} arrColumnNames={arrColumnNames}
                      onOpenSql={onOpenSql} onApplied={applied} onClose={() => setStrEditing(null)} />
                  ))}
                {objSection && !boolEditingShown && (objSection.title === COLUMNS_TAB
                  ? (
                    <div className="flex h-full">
                      <div className="min-w-0 flex-1">
                        <ResultGrid key={objSection.title} objResult={objSection.result} onSelectRow={setIntColumnRow} />
                      </div>
                      <aside className="w-72 shrink-0 overflow-auto border-l border-line" aria-label="Column properties">
                        <div className="border-b border-line px-3 py-1 text-xs text-muted">Column properties</div>
                        <ColumnProperties objColumns={objSection.result} arrRow={objSection.result.rows[intColumnRow]}
                          objConstraints={objDetail.sections.find(objItem => objItem.title === 'Constraints')?.result} />
                      </aside>
                    </div>
                  )
                  : boolRedis && objSection.title === 'Value'
                    ? (
                      <RedisValueEditor objConnection={objConnection} intDatabase={Number(strSchema.replace(/^db/, '')) || 0} strKey={strName}
                        strType={strType} objValue={objSection.result} intTtl={arrRedisTtl ? Number(arrRedisTtl[1]) : null}
                        onChanged={() => setIntReload(intPrev => intPrev + 1)} />
                    )
                    : <ResultGrid key={objSection.title} objResult={objSection.result} strExportName={`${strName}-${objSection.title.toLowerCase()}`} />)}
                {strShown === SOURCE_TAB && (objDetail.ddl
                  ? <DdlView strDdl={objDetail.ddl} strLanguage={editorLanguage(objConnection.kind)} />
                  : (
                    <p className="whitespace-pre-wrap p-4 text-muted" style={{ userSelect: 'text' }}>
                      {boolPartial ? 'Loading…' : objDetail.ddlError ?? 'No source is available for this object.'}
                    </p>
                  ))}
                {strShown === DIAGRAM_TAB && boolRoutine && (
                  <RoutineDiagram objConnection={objConnection} objObject={objObject} objMetadata={objMetadata} onOpenObject={onOpenObject} />
                )}
                {strShown === DIAGRAM_TAB && strType === 'TABLE' && (
                  <TableDiagram objConnection={objConnection} objObject={objObject} objColumns={objColumnsGrid} objMetadata={objMetadata}
                    hsPrimary={hsPrimary} onOpenObject={onOpenObject} />
                )}
                {strShown === DATA_TAB && objImportFile && objConnection.kind === 'MongoDb' && (
                  <CollectionImport key={`${objImportFile.name}-${objImportFile.lastModified}`} objConnection={objConnection}
                    strDatabase={strSchema} strCollection={strName} dicFieldTypes={dicFieldTypes} objInitialFile={objImportFile}
                    onImported={loadData} onClose={() => setObjImportFile(null)} />
                )}
                {strShown === DATA_TAB && objImportFile && objConnection.kind !== 'MongoDb' && (
                  <TableImport key={`${objImportFile.name}-${objImportFile.lastModified}`} objConnection={objConnection} strTable={strQualified}
                    arrColumns={arrImportColumns} arrKeyColumns={[...hsPrimary]} objInitialFile={objImportFile}
                    onImported={loadData} onClose={() => setObjImportFile(null)} />
                )}
                {strShown === DATA_TAB && !objImportFile && (
                  <div className="flex h-full flex-col">
                    <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-3">
                      {(strType === 'TABLE' || strType === 'COLLECTION') && (
                        <>
                          <button className="btn h-6 px-2" onClick={() => refImportPicker.current?.click()}
                            title={strType === 'COLLECTION'
                              ? 'Add the documents of a JSON file, or the rows of a CSV / Excel file, to this collection'
                              : 'Add the rows of a CSV or Excel file to this table'}>Import…</button>
                          <input ref={refImportPicker} type="file" className="hidden"
                            accept={strType === 'COLLECTION' ? '.json,.jsonl,.ndjson,.csv,.txt,.tsv,.xlsx' : '.csv,.txt,.tsv,.xlsx'}
                            onChange={objEvent => { setObjImportFile(objEvent.target.files?.[0] ?? null); objEvent.target.value = ''; }} />
                        </>
                      )}
                      <button className="btn h-6 px-2" onClick={exportTable} disabled={objExport?.queryId != null}
                        title="Save every row of the table as Excel or CSV; you choose the file">Export…</button>
                      <button className="btn h-6 px-2" onClick={loadData} disabled={objData.status === 'loading'}>Reload data</button>
                    </div>
                    {objExport && (
                      <div className={`flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-xs ${objExport.error ? 'text-danger' : 'text-muted'}`}>
                        <span className="min-w-0 flex-1 truncate" title={objExport.text} style={{ userSelect: 'text' }}>{objExport.text}</span>
                        {objExport.path && (
                          <button className="btn h-6 shrink-0 px-2" onClick={() => { api.revealExport(objExport.path!).catch(() => {}); }}>Show in folder</button>
                        )}
                        {objExport.queryId
                          ? <button className="btn btn-danger h-6 shrink-0 px-2" onClick={() => { api.cancel(objExport.queryId!).catch(() => {}); }}>Stop</button>
                          : (
                            <button className="icon-btn icon-btn-sm shrink-0" aria-label="Dismiss" title="Dismiss" onClick={() => setObjExport(null)}>
                              <IconClose intSize={13} />
                            </button>
                          )}
                      </div>
                    )}
                    <div className="min-h-0 flex-1">
                    {objData.status === 'loading' && <p className="p-4 text-muted">Loading data…</p>}
                    {objData.status === 'error' && (
                      <p className="whitespace-pre-wrap p-4 font-mono text-xs text-danger" style={{ userSelect: 'text' }}>{objData.message}</p>
                    )}
                    {objData.status === 'done' && (
                      <div className="flex h-full flex-col">
                        <div className="min-h-0 flex-1">
                          {TABLE_LIKE.has(strType)
                            ? <EditableResult objConnection={objConnection} strSql={strSelectAll} objResult={objData.result} intMaxRows={DATA_ROWS} strExportName={`${strSchema}.${strName}`} />
                            : <ResultGrid objResult={objData.result} strExportName={`${strSchema}.${strName}`} />}
                        </div>
                        <div className="shrink-0 border-t border-line bg-bg px-3 py-0.5 text-xs text-muted">
                          {objData.result.rows.length.toLocaleString()} rows
                          {objData.result.truncated && ` (first ${DATA_ROWS.toLocaleString()} only; use Open data for more)`}
                        </div>
                      </div>
                    )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* bottom: DDL */}
          {boolDdlShown && (
            <div className="flex min-h-0 shrink-0 flex-col" style={boolTop ? { height: `${intDdlPercent}%` } : { flex: '1 1 0' }}>
              {boolTop && (
                <div role="separator" aria-orientation="horizontal" title="Drag to resize"
                  className="h-1 shrink-0 cursor-row-resize bg-line hover:bg-accent"
                  onPointerDown={objEvent => objEvent.currentTarget.setPointerCapture(objEvent.pointerId)}
                  onPointerMove={resize} />
              )}
              <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-line px-3 text-xs text-muted">
                DDL
                {objDetail.ddl && (
                  <div className="ml-auto flex gap-1.5">
                    <button className="btn h-6 px-2" onClick={() => navigator.clipboard.writeText(objDetail.ddl ?? '')}>Copy</button>
                    <button className="btn h-6 px-2" onClick={() => onOpenSql(objDetail.ddl ?? '', false)}>Open in editor</button>
                  </div>
                )}
              </div>
              <div className="min-h-0 flex-1">
                {objDetail.ddl
                  ? <DdlView strDdl={objDetail.ddl} strLanguage={editorLanguage(objConnection.kind)} />
                  : (
                    <p className="whitespace-pre-wrap p-4 text-muted" style={{ userSelect: 'text' }}>
                      {boolPartial ? 'Loading the DDL…' : objDetail.ddlError ?? 'No DDL is available for this kind of object.'}
                    </p>
                  )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
