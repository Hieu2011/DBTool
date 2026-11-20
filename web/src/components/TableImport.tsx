import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { buildInserts, buildUpserts, dedupeByKey, parseImportFile, type ImportedSheet, type TargetColumn } from '../importData';
import type { Connection, QueryResult } from '../types';
import { ResultGrid } from './ResultGrid';

interface Props {
  objConnection: Connection;
  /** Qualified, quoted table name. */
  strTable: string;
  arrColumns: TargetColumn[];
  /** Primary key columns: the default key for "update existing rows". */
  arrKeyColumns: string[];
  /** The file the user picked before this screen opened. */
  objInitialFile: File;
  /** Rows were committed: the caller reloads the data. */
  onImported: () => void;
  onClose: () => void;
}

type RunState =
  | { status: 'idle' }
  | { status: 'running'; done: number }
  | { status: 'done'; rows: number; elapsedMs: number; dropped: number; upsert: boolean }
  | { status: 'failed'; message: string };

const SKIP = -1;
const PREVIEW_ROWS = 50;

const normalize = (strName: string) => strName.toLowerCase().replace(/[^a-z0-9]/g, '');
const errorMessage = (objEx: unknown) => (objEx instanceof ApiError ? objEx.detail.message : (objEx as Error).message);

/** Adds the rows of a CSV / Excel file to a table: pick the file, check the column mapping, import in one transaction. */
export function TableImport({ objConnection, strTable, arrColumns, arrKeyColumns, objInitialFile, onImported, onClose }: Props) {
  const [objFile, setObjFile] = useState<{ name: string; sheet: ImportedSheet } | null>(null);
  const [strFileError, setStrFileError] = useState<string | null>(null);
  const [boolReading, setBoolReading] = useState(false);
  const [boolHeader, setBoolHeader] = useState(true);
  // For each table column, the file column that feeds it (SKIP = leave to the table's default).
  const [arrMapping, setArrMapping] = useState<number[]>([]);
  const [objRun, setObjRun] = useState<RunState>({ status: 'idle' });
  // Upsert: a row whose key already exists updates that row instead of failing.
  const [boolUpsert, setBoolUpsert] = useState(false);
  const [arrKeys, setArrKeys] = useState<string[]>(arrKeyColumns);
  const refPicker = useRef<HTMLInputElement>(null);
  const refStop = useRef(false);
  const refQueryId = useRef<string | null>(null);

  const arrAllRows = objFile?.sheet.rows ?? [];
  const arrDataRows = useMemo(() => (boolHeader ? arrAllRows.slice(1) : arrAllRows), [arrAllRows, boolHeader]);
  const intFileColumns = useMemo(() => arrAllRows.reduce((intMax, arrRow) => Math.max(intMax, arrRow.length), 0), [arrAllRows]);
  const arrFileNames = useMemo(
    () => Array.from({ length: intFileColumns }, (_, intCol) => (boolHeader ? arrAllRows[0]?.[intCol] : null) ?? `Column ${intCol + 1}`),
    [arrAllRows, boolHeader, intFileColumns]);

  // With a header: same name, ignoring case and punctuation. Without: by position.
  const autoMap = (arrNames: string[], boolByName: boolean) => arrColumns.map((objColumn, intIndex) => {
    if (!boolByName) return intIndex < arrNames.length ? intIndex : SKIP;
    return arrNames.findIndex(strName => normalize(strName) === normalize(objColumn.name));
  });

  const pick = async (objPicked: File | undefined) => {
    if (!objPicked) return;
    setBoolReading(true);
    setStrFileError(null);
    setObjRun({ status: 'idle' });
    try {
      const objSheet = await parseImportFile(objPicked);
      if (objSheet.rows.length === 0) throw new Error('The file has no rows.');
      setObjFile({ name: objPicked.name, sheet: objSheet });
      setBoolHeader(true);
      setArrMapping(autoMap((objSheet.rows[0] ?? []).map(strCell => strCell ?? ''), true));
    } catch (objEx) {
      setObjFile(null);
      setStrFileError((objEx as Error).message);
    } finally {
      setBoolReading(false);
    }
  };

  // The screen opens on a file already chosen (the caller keys this component by file).
  useEffect(() => { pick(objInitialFile); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleHeader = (boolNext: boolean) => {
    setBoolHeader(boolNext);
    setArrMapping(autoMap((arrAllRows[0] ?? []).map(strCell => strCell ?? ''), boolNext));
  };

  const arrMapped = arrColumns.map((objColumn, intIndex) => ({ column: objColumn, source: arrMapping[intIndex] ?? SKIP }))
    .filter(objItem => objItem.source !== SKIP);
  const boolRunning = objRun.status === 'running';
  const strKeyProblem = !boolUpsert ? null
    : arrKeys.length === 0 ? 'Tick the key columns that identify a row.'
      : arrKeys.some(strKey => !arrMapped.some(objItem => objItem.column.name === strKey)) ? 'Every key column must be filled from the file.'
        : null;
  const boolCanImport = arrMapped.length > 0 && arrDataRows.length > 0 && !boolRunning && objRun.status !== 'done' && !strKeyProblem;

  // Every statement runs in one session with auto-commit off: all rows go in, or none.
  const run = async () => {
    const arrTargets = arrMapped.map(objItem => objItem.column);
    const arrSources = arrMapped.map(objItem => objItem.source);
    let arrStatements: { sql: string; rows: number }[];
    let intDropped = 0;
    if (boolUpsert) {
      // The same key twice in one statement is an error on PostgreSQL: the file's last line for a key wins.
      const objUnique = dedupeByKey(arrDataRows, arrMapped.filter(objItem => arrKeys.includes(objItem.column.name)).map(objItem => objItem.source));
      intDropped = objUnique.dropped;
      arrStatements = buildUpserts(strTable, objConnection.kind, arrTargets, arrSources, objUnique.rows, arrKeys);
    } else arrStatements = buildInserts(strTable, objConnection.kind, arrTargets, arrSources, arrDataRows);
    const strSessionId = crypto.randomUUID();
    const lngStarted = Date.now();
    refStop.current = false;
    let intDone = 0;
    setObjRun({ status: 'running', done: 0 });
    try {
      for (const objStatement of arrStatements) {
        if (refStop.current) throw new Error('Stopped.');
        refQueryId.current = crypto.randomUUID();
        try {
          await api.query(refQueryId.current, objConnection.id, objStatement.sql, 1, strSessionId, false);
        } catch (objEx) {
          const intFirst = intDone + 1 + (boolHeader ? 1 : 0); // file row numbers, as a spreadsheet shows them
          throw new Error(`${refStop.current ? 'Stopped' : errorMessage(objEx)}\n\n`
            + (intDropped > 0
              ? `Rows ${(intDone + 1).toLocaleString()}–${(intDone + objStatement.rows).toLocaleString()} of the rows left after removing repeated keys.`
              : `File rows ${intFirst.toLocaleString()}–${(intFirst + objStatement.rows - 1).toLocaleString()}.`));
        }
        intDone += objStatement.rows;
        setObjRun({ status: 'running', done: intDone });
      }
      await api.commit(strSessionId);
      setObjRun({ status: 'done', rows: intDone, elapsedMs: Date.now() - lngStarted, dropped: intDropped, upsert: boolUpsert });
      onImported();
    } catch (objEx) {
      await api.rollback(strSessionId).catch(() => {});
      setObjRun({ status: 'failed', message: `${(objEx as Error).message}\n\nNothing was imported: the transaction was rolled back.` });
    } finally {
      refQueryId.current = null;
      api.closeSession(strSessionId).catch(() => {});
    }
  };

  const stop = () => {
    refStop.current = true;
    if (refQueryId.current) api.cancel(refQueryId.current).catch(() => {});
  };

  const objPreview = useMemo<QueryResult>(() => ({
    columns: arrFileNames.map(strName => ({ name: strName, dataType: '' })),
    rows: arrDataRows.slice(0, PREVIEW_ROWS).map(arrRow => arrFileNames.map((_, intCol) => arrRow[intCol] ?? null)),
    recordsAffected: -1, truncated: false, elapsedMs: 0,
  }), [arrFileNames, arrDataRows]);

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <button className="btn h-6 px-2" onClick={() => refPicker.current?.click()} disabled={boolRunning || boolReading}>
          {objFile ? 'Choose another file…' : 'Choose a CSV or Excel file…'}
        </button>
        <input ref={refPicker} type="file" accept=".csv,.txt,.tsv,.xlsx" className="hidden"
          onChange={objEvent => { pick(objEvent.target.files?.[0]); objEvent.target.value = ''; }} />
        <span className="min-w-0 truncate text-muted">
          {boolReading ? 'Reading the file…'
            : objFile ? `${objFile.name} · ${arrDataRows.length.toLocaleString()} rows · ${intFileColumns} columns`
              : 'Rows are added to the table; existing rows change only when "Update rows that already exist" is ticked.'}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {boolRunning && (
            <>
              <span className="text-muted">{objRun.done.toLocaleString()} of {arrDataRows.length.toLocaleString()} rows</span>
              <button className="btn btn-danger h-6 px-2" onClick={stop}>Stop</button>
            </>
          )}
          {!boolRunning && objFile && (
            <button className="btn btn-primary h-6 px-2" onClick={run} disabled={!boolCanImport}
              title="All rows go in one transaction: an error rolls everything back">
              Import {arrDataRows.length.toLocaleString()} rows
            </button>
          )}
          <button className="btn h-6 px-2" onClick={onClose} disabled={boolRunning}>Close</button>
        </div>
      </div>

      {strFileError && <p className="shrink-0 whitespace-pre-wrap px-3 py-2 text-danger" style={{ userSelect: 'text' }}>{strFileError}</p>}
      {objRun.status === 'failed' && (
        <p className="shrink-0 whitespace-pre-wrap border-b border-line px-3 py-2 font-mono text-danger" style={{ userSelect: 'text' }}>{objRun.message}</p>
      )}
      {objRun.status === 'done' && (
        <p className="shrink-0 border-b border-line px-3 py-2 text-success">
          {objRun.upsert ? 'Added or updated' : 'Imported'} {objRun.rows.toLocaleString()} rows in {(objRun.elapsedMs / 1000).toFixed(1)} s.
          {objRun.dropped > 0 && ` ${objRun.dropped.toLocaleString()} earlier lines with a repeated key were skipped (the last line of each key was used).`}
          {' '}Choose another file or close.
        </p>
      )}

      {!objFile && !strFileError && (
        <p className="p-4 text-muted">
          CSV (comma, semicolon or tab separated) and .xlsx (first sheet) are read. The first row is taken as the column names.
          Dates should look like 2026-11-04 10:30:00; an empty cell becomes NULL.
        </p>
      )}

      {objFile && (
        <div className="flex min-h-0 flex-1">
          {/* mapping */}
          <div className="flex w-[26rem] shrink-0 flex-col border-r border-line">
            <label className="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-1.5 text-muted">
              <input type="checkbox" checked={boolHeader} disabled={boolRunning} onChange={objEvent => toggleHeader(objEvent.target.checked)} />
              The first row holds column names
            </label>
            <label className="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-1.5 text-muted"
              title="A file row whose key is already in the table updates that row; the others are added">
              <input type="checkbox" checked={boolUpsert} disabled={boolRunning} onChange={objEvent => setBoolUpsert(objEvent.target.checked)} />
              Update rows that already exist (match by key)
            </label>
            {strKeyProblem && <p className="shrink-0 border-b border-line px-3 py-1.5 text-danger">{strKeyProblem}</p>}
            <div className="flex shrink-0 items-center gap-2 border-b border-line bg-bg px-3 py-1 font-semibold">
              {boolUpsert && <span className="w-7 shrink-0">Key</span>}
              <span className="w-1/2">Table column</span>
              <span>Filled from file column</span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {arrColumns.map((objColumn, intIndex) => (
                <div key={objColumn.name} className="flex items-center gap-2 border-b border-line/60 px-3 py-1">
                  {boolUpsert && (
                    <span className="w-7 shrink-0">
                      <input type="checkbox" checked={arrKeys.includes(objColumn.name)} disabled={boolRunning} aria-label={`${objColumn.name} is a key column`}
                        onChange={objEvent => setArrKeys(arrPrev => (objEvent.target.checked
                          ? [...arrPrev, objColumn.name]
                          : arrPrev.filter(strKey => strKey !== objColumn.name)))} />
                    </span>
                  )}
                  <span className="w-1/2 min-w-0 truncate font-mono" title={`${objColumn.name} ${objColumn.type}`}>
                    {objColumn.name} <span className="text-muted">{objColumn.type.toLowerCase()}</span>
                  </span>
                  <select className="field h-6 min-w-0 flex-1 py-0 text-xs" value={arrMapping[intIndex] ?? SKIP} disabled={boolRunning}
                    aria-label={`File column for ${objColumn.name}`}
                    onChange={objEvent => setArrMapping(arrPrev => arrColumns.map((_, intOther) =>
                      (intOther === intIndex ? Number(objEvent.target.value) : arrPrev[intOther] ?? SKIP)))}>
                    <option value={SKIP}>(not imported)</option>
                    {arrFileNames.map((strName, intCol) => <option key={intCol} value={intCol}>{strName}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <p className="shrink-0 border-t border-line px-3 py-1.5 text-muted">
              {arrMapped.length} of {arrColumns.length} columns are filled.{' '}
              {boolUpsert
                ? 'New rows get defaults for the others; updated rows keep what they have there. The key needs a primary key or unique index.'
                : 'The others get their default value or NULL.'}
            </p>
          </div>

          {/* preview */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="shrink-0 border-b border-line px-3 py-1.5 text-muted">
              File preview{arrDataRows.length > PREVIEW_ROWS ? ` (first ${PREVIEW_ROWS} rows)` : ''}
            </div>
            <div className="min-h-0 flex-1"><ResultGrid objResult={objPreview} strExportName="import-preview" /></div>
          </div>
        </div>
      )}
    </div>
  );
}
