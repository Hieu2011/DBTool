import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { buildInsertMany, parseDocumentFile, shellValue, FIELD_TYPES, type DocumentFile, type FieldType } from '../importDocuments';
import type { Connection, QueryResult } from '../types';
import { ResultGrid } from './ResultGrid';

interface Props {
  objConnection: Connection;
  strDatabase: string;
  strCollection: string;
  /** Field -> BSON types sampled from the collection ("string", "int32 | double"...): the default type of a file column. */
  dicFieldTypes: Record<string, string>;
  /** The file the user picked before this screen opened. */
  objInitialFile: File;
  onImported: () => void;
  onClose: () => void;
}

interface FieldMap { include: boolean; name: string; type: FieldType }

type RunState =
  | { status: 'idle' }
  | { status: 'running'; done: number }
  | { status: 'done'; rows: number; elapsedMs: number; transaction: boolean }
  | { status: 'failed'; message: string };

const PREVIEW_ROWS = 50;
const errorMessage = (objEx: unknown) => (objEx instanceof ApiError ? objEx.detail.message : (objEx as Error).message);

function defaultType(strSampled: string | undefined): FieldType {
  if (!strSampled || strSampled.includes('|')) return 'auto';
  if (/^(int32|int64|double|decimal128)$/.test(strSampled)) return 'number';
  return (FIELD_TYPES as readonly string[]).includes(strSampled) ? strSampled as FieldType : 'auto';
}

/** Adds the documents of a JSON file, or the rows of a CSV / Excel file, to a collection. */
export function CollectionImport({ objConnection, strDatabase, strCollection, dicFieldTypes, objInitialFile, onImported, onClose }: Props) {
  const [objFile, setObjFile] = useState<{ name: string; data: DocumentFile } | null>(null);
  const [strFileError, setStrFileError] = useState<string | null>(null);
  const [boolReading, setBoolReading] = useState(false);
  const [boolHeader, setBoolHeader] = useState(true);
  const [arrFields, setArrFields] = useState<FieldMap[]>([]);
  const [objRun, setObjRun] = useState<RunState>({ status: 'idle' });
  const refPicker = useRef<HTMLInputElement>(null);
  const refStop = useRef(false);
  const refQueryId = useRef<string | null>(null);

  const arrSheet = objFile?.data.rows ?? null; // CSV / Excel; null for a JSON file
  const arrDataRows = useMemo(() => (arrSheet ? (boolHeader ? arrSheet.slice(1) : arrSheet) : []), [arrSheet, boolHeader]);
  const intCount = arrSheet ? arrDataRows.length : objFile?.data.documents?.length ?? 0;

  const mapFields = (arrRows: (string | null)[][], boolNames: boolean) => {
    const intColumns = arrRows.reduce((intMax, arrRow) => Math.max(intMax, arrRow.length), 0);
    setArrFields(Array.from({ length: intColumns }, (_, intCol) => {
      const strName = (boolNames ? arrRows[0]?.[intCol]?.trim() : null) || `field${intCol + 1}`;
      return { include: true, name: strName, type: defaultType(dicFieldTypes[strName]) };
    }));
  };

  const pick = async (objPicked: File | undefined) => {
    if (!objPicked) return;
    setBoolReading(true);
    setStrFileError(null);
    setObjRun({ status: 'idle' });
    try {
      const objData = await parseDocumentFile(objPicked);
      if ((objData.rows?.length ?? objData.documents?.length ?? 0) === 0) throw new Error('The file holds no rows or documents.');
      setObjFile({ name: objPicked.name, data: objData });
      setBoolHeader(true);
      if (objData.rows) mapFields(objData.rows, true);
    } catch (objEx) {
      setObjFile(null);
      setStrFileError((objEx as Error).message);
    } finally {
      setBoolReading(false);
    }
  };

  // The screen opens on a file already chosen (the caller keys this component by file).
  useEffect(() => { pick(objInitialFile); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setField = (intIndex: number, objChange: Partial<FieldMap>) =>
    setArrFields(arrPrev => arrPrev.map((objField, intOther) => (intOther === intIndex ? { ...objField, ...objChange } : objField)));

  const arrUsed = arrFields.map((objField, intCol) => ({ ...objField, col: intCol })).filter(objField => objField.include);
  const strFieldProblem = !arrSheet ? null
    : arrUsed.length === 0 ? 'Tick at least one column.'
      : arrUsed.some(objField => objField.name.trim() === '') ? 'Every imported column needs a field name.'
        : new Set(arrUsed.map(objField => objField.name.trim())).size < arrUsed.length ? 'Two columns have the same field name.'
          : null;
  const boolRunning = objRun.status === 'running';
  const boolCanImport = intCount > 0 && !boolRunning && objRun.status !== 'done' && !strFieldProblem;

  /** Every document as shell text. Throws naming the file row of a value that does not fit its type. */
  const documents = (): string[] => {
    if (!arrSheet) return objFile?.data.documents ?? [];
    return arrDataRows.map((arrRow, intRow) => {
      const arrParts: string[] = [];
      for (const objField of arrUsed) {
        const strCell = arrRow[objField.col];
        if (strCell === null || strCell === undefined || strCell === '') continue; // an empty cell: the field is left out
        const strValue = shellValue(strCell, objField.type);
        if (strValue === null) {
          throw new Error(`File row ${(intRow + 1 + (boolHeader ? 1 : 0)).toLocaleString()}, column "${objField.name}": `
            + `"${strCell.slice(0, 60)}" is not a ${objField.type}. Fix the file or change the column's type.`);
        }
        arrParts.push(`${JSON.stringify(objField.name.trim())}: ${strValue}`);
      }
      return `{ ${arrParts.join(', ')} }`;
    });
  };

  // One transaction when the server has them (replica set); a standalone gets plain inserts, batch by batch.
  const run = async () => {
    let arrStatements: { text: string; rows: number }[];
    try {
      arrStatements = buildInsertMany(strDatabase, strCollection, documents());
    } catch (objEx) {
      setObjRun({ status: 'failed', message: (objEx as Error).message });
      return;
    }
    const strSessionId = crypto.randomUUID();
    const lngStarted = Date.now();
    refStop.current = false;
    let intDone = 0;
    let boolTransaction = true;
    const send = (strText: string) => {
      refQueryId.current = crypto.randomUUID();
      return api.query(refQueryId.current, objConnection.id, strText, 1, strSessionId, !boolTransaction);
    };
    setObjRun({ status: 'running', done: 0 });
    try {
      for (const objStatement of arrStatements) {
        if (refStop.current) throw new Error('Stopped.');
        try {
          await send(objStatement.text);
        } catch (objEx) {
          if (!(objEx instanceof ApiError) || objEx.detail.code !== 'TransactionsUnavailable' || intDone > 0) throw objEx;
          boolTransaction = false;
          await send(objStatement.text);
        }
        intDone += objStatement.rows;
        setObjRun({ status: 'running', done: intDone });
      }
      if (boolTransaction) await api.commit(strSessionId);
      setObjRun({ status: 'done', rows: intDone, elapsedMs: Date.now() - lngStarted, transaction: boolTransaction });
      onImported();
    } catch (objEx) {
      if (boolTransaction) await api.rollback(strSessionId).catch(() => {});
      else if (intDone > 0) onImported();
      setObjRun({
        status: 'failed',
        message: `${refStop.current ? 'Stopped.' : errorMessage(objEx)}\n\n`
          + (boolTransaction ? 'Nothing was imported: the transaction was rolled back.'
            : `The first ${intDone.toLocaleString()} documents are already in the collection (a standalone server has no transactions); `
              + 'part of the failed batch may be too.'),
      });
    } finally {
      refQueryId.current = null;
      api.closeSession(strSessionId).catch(() => {});
    }
  };

  const stop = () => {
    refStop.current = true;
    if (refQueryId.current) api.cancel(refQueryId.current).catch(() => {});
  };

  const objPreview = useMemo<QueryResult>(() => {
    if (arrSheet) {
      return {
        columns: arrFields.map(objField => ({ name: objField.name, dataType: '' })),
        rows: arrDataRows.slice(0, PREVIEW_ROWS).map(arrRow => arrFields.map((_, intCol) => arrRow[intCol] ?? null)),
        recordsAffected: -1, truncated: false, elapsedMs: 0,
      };
    }
    return {
      columns: [{ name: 'document', dataType: '' }],
      rows: (objFile?.data.documents ?? []).slice(0, PREVIEW_ROWS).map(strDoc => [strDoc.length > 2000 ? `${strDoc.slice(0, 2000)}…` : strDoc]),
      recordsAffected: -1, truncated: false, elapsedMs: 0,
    };
  }, [arrSheet, arrFields, arrDataRows, objFile]);

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <button className="btn h-6 px-2" onClick={() => refPicker.current?.click()} disabled={boolRunning || boolReading}>Choose another file…</button>
        <input ref={refPicker} type="file" accept=".json,.jsonl,.ndjson,.csv,.txt,.tsv,.xlsx" className="hidden"
          onChange={objEvent => { pick(objEvent.target.files?.[0]); objEvent.target.value = ''; }} />
        <span className="min-w-0 truncate text-muted">
          {boolReading ? 'Reading the file…' : objFile ? `${objFile.name} · ${intCount.toLocaleString()} documents` : ''}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {boolRunning && (
            <>
              <span className="text-muted">{objRun.done.toLocaleString()} of {intCount.toLocaleString()} documents</span>
              <button className="btn btn-danger h-6 px-2" onClick={stop}>Stop</button>
            </>
          )}
          {!boolRunning && objFile && (
            <button className="btn btn-primary h-6 px-2" onClick={run} disabled={!boolCanImport}
              title="Documents are added with insertMany; existing documents are never changed">
              Import {intCount.toLocaleString()} documents
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
          Imported {objRun.rows.toLocaleString()} documents in {(objRun.elapsedMs / 1000).toFixed(1)} s
          {objRun.transaction ? ' (one transaction).' : ' (no transaction: standalone server).'} Choose another file or close.
        </p>
      )}

      {objFile && (
        <div className="flex min-h-0 flex-1">
          {arrSheet && (
            <div className="flex w-[30rem] shrink-0 flex-col border-r border-line">
              <label className="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-1.5 text-muted">
                <input type="checkbox" checked={boolHeader} disabled={boolRunning}
                  onChange={objEvent => { setBoolHeader(objEvent.target.checked); mapFields(arrSheet, objEvent.target.checked); }} />
                The first row holds field names
              </label>
              {strFieldProblem && <p className="shrink-0 border-b border-line px-3 py-1.5 text-danger">{strFieldProblem}</p>}
              <div className="flex shrink-0 items-center gap-2 border-b border-line bg-bg px-3 py-1 font-semibold">
                <span className="w-5 shrink-0" />
                <span className="min-w-0 flex-1">Field name</span>
                <span className="w-28 shrink-0">Type</span>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {arrFields.map((objField, intIndex) => (
                  <div key={intIndex} className="flex items-center gap-2 border-b border-line/60 px-3 py-1">
                    <input type="checkbox" className="w-5 shrink-0" checked={objField.include} disabled={boolRunning}
                      aria-label={`Import column ${intIndex + 1}`} onChange={objEvent => setField(intIndex, { include: objEvent.target.checked })} />
                    <input className="field h-6 min-w-0 flex-1 font-mono text-xs" value={objField.name} disabled={boolRunning || !objField.include}
                      aria-label={`Field name of column ${intIndex + 1}`} onChange={objEvent => setField(intIndex, { name: objEvent.target.value })} />
                    <select className="field h-6 w-28 shrink-0 py-0 text-xs" value={objField.type} disabled={boolRunning || !objField.include}
                      aria-label={`Type of column ${intIndex + 1}`} onChange={objEvent => setField(intIndex, { type: objEvent.target.value as FieldType })}>
                      {FIELD_TYPES.map(strType => <option key={strType} value={strType}>{strType}</option>)}
                    </select>
                  </div>
                ))}
              </div>
              <p className="shrink-0 border-t border-line px-3 py-1.5 text-muted">
                auto: whole and decimal numbers become numbers, true / false booleans, the rest text. An empty cell leaves the field out.
                Dates are read as UTC (2026-11-04 10:30:00).
              </p>
            </div>
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="shrink-0 border-b border-line px-3 py-1.5 text-muted">
              File preview{intCount > PREVIEW_ROWS ? ` (first ${PREVIEW_ROWS})` : ''}
              {!arrSheet && ' — documents are inserted as they are written, Extended JSON ({"$oid": …}, {"$date": …}) included'}
            </div>
            <div className="min-h-0 flex-1"><ResultGrid objResult={objPreview} strExportName="import-preview" /></div>
          </div>
        </div>
      )}
    </div>
  );
}
