import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import {
  binaryHex, buildDeletes, buildInserts, buildUpdates, cellKey, editTargets, isBinaryType, keyGeneratorSql, looksLikeSelect, primaryKeySql, rowEditable, rowIdTargets, type EditTarget, type RowUpdate,
} from '../sql/editData';
import { buildMongoStatements, mongoTarget } from '../sql/mongoEdit';
import { mapColumns, parseSelect, rowIdSql, ROWID_ALIAS, type FromItem, type ParsedSelect } from '../sql/oracleEdit';
import type { Connection, QueryResult, SchemaMetadata } from '../types';
import { IconDownload, IconDuplicate, IconFirst, IconLast, IconNext, IconPencil, IconPlus, IconPrev, IconRefresh, IconSave, IconTrash, IconUndo } from './icons';
import { display, ResultGrid, type GridBlock, type GridCommand, type GridEdit } from './ResultGrid';
import { RecordView, TextView } from './ResultViews';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { generateScript, type ScriptKind, type ScriptSource } from '../sql/generateScript';
import { showToast } from '../toast';

interface Props {
  objConnection: Connection;
  /** The statement that produced the result. */
  strSql: string;
  objResult: QueryResult;
  /** The editor tab's session. In Manual mode the changes run in it (they stay in its transaction). */
  strSessionId?: string;
  boolAutoCommit?: boolean;
  /** A session used only to read rows, so a cut result can stay open for scrolling (the Data tab of a table). */
  strDataSessionId?: string;
  /**
   * Scrolling to the end may run the statement again when its open result is gone. Only for statements the app wrote
   * itself: a user's statement can be slow or have side effects, so there it takes a click on "More rows".
   */
  boolRerunOnScroll?: boolean;
  /** Rows to read when the statement is run again (Refresh, Oracle ROWIDs). */
  intMaxRows?: number;
  /** Statements were sent on the tab's session (it may now hold an open transaction). */
  onRan?: () => void;
  strExportName?: string;
  /** Generate script as... > To SQL tab: opens a new editor tab holding the script. */
  onOpenSql?: (strSql: string) => void;
}

type EditState =
  | { status: 'loading' }
  | { status: 'unavailable'; message: string }
  // parsed: Oracle, where rows are found by ROWID.
  | { status: 'on'; targets: EditTarget[]; parsed?: ParsedSelect };

type ApplyState =
  | { status: 'idle' }
  | { status: 'running'; total: number; done: number };

/** The statement run again: by Refresh, after a save, or (Oracle) with the ROWID of the table `target`. */
interface Reloaded { result: QueryResult; target?: string; rowIds?: (string | null)[] }

type ViewMode = 'grid' | 'text' | 'record';
const VIEWS: { mode: ViewMode; label: string; title: string }[] = [
  { mode: 'grid', label: 'Grid', title: 'Rows in a grid; double-click a cell to edit it' },
  { mode: 'text', label: 'Text', title: 'The selected rows (or all) as plain text' },
  { mode: 'record', label: 'Record', title: 'The selected rows turned on their side: one line per column' },
];

const errorMessage = (objEx: unknown) => (objEx instanceof ApiError ? objEx.detail.message : (objEx as Error).message);
const upper = (strName: string) => (strName.startsWith('"') ? strName.slice(1, -1) : strName.toUpperCase());
const plural = (intCount: number, strWord: string) => `${intCount.toLocaleString()} ${strWord}${intCount === 1 ? '' : 's'}`;
const sameRows = (arrA: unknown[][], arrB: unknown[][]) =>
  arrA.length === arrB.length && arrA.every((arrRow, intRow) => JSON.stringify(arrRow) === JSON.stringify(arrB[intRow]));

/** Columns of a FROM item from the loaded metadata; a bare name is looked up in the login's own schema. */
/** "More rows" on a result that is still open on the server. */
const FETCH_MANY_ROWS = 10000;

function columnsFrom(objMeta: SchemaMetadata, objItem: FromItem) {
  if (objItem.subquery) return undefined;
  const arrParts = objItem.ref.split('.').map(upper);
  const [strSchema, strName] = arrParts.length === 2 ? arrParts : [objMeta.loadedSchemas?.[0], arrParts[0]];
  return objMeta.tables.find(objTable => objTable.schema === strSchema && objTable.name === strName)?.columns.map(objColumn => objColumn.name);
}

/**
 * A result grid that can be edited in place when the statement is a SELECT: cells, new rows, copies of rows, deletions.
 * With several tables in the query the Table box picks the one being edited (its columns stay bright, the others dim).
 * Nothing reaches the database before Save, which shows the statements first. PostgreSQL finds the rows by primary
 * key (the driver says where each column comes from); Oracle by ROWID, as dbForge does: the statement's own FROM
 * clause gives the tables, and it is run again with the chosen table's ROWID when the first change needs it.
 */
export function EditableResult({ objConnection, strSql, objResult, strSessionId, boolAutoCommit = true, intMaxRows = 1000, onRan, strExportName, onOpenSql, strDataSessionId, boolRerunOnScroll = false }: Props) {
  // Right-click on the grid: where, and the cell under the pointer.
  const [objMenu, setObjMenu] = useState<{ x: number; y: number; row: number | null; col: number | null } | null>(null);
  // The block of cells picked in the grid (drag, Shift + click / arrows).
  const [objBlock, setObjBlock] = useState<GridBlock | null>(null);
  // The current cell, for the Value panel (long text, JSON...).
  const [objCell, setObjCell] = useState<{ row: number; col: number } | null>(null);
  const [boolValuePanel, setBoolValuePanel] = useState(false);
  // Rows asked from the server; "More rows" raises it and runs the statement again.
  const [intLimit, setIntLimit] = useState(intMaxRows);
  // Oracle: primary key columns looked up in the catalog, once per table (null: the lookup failed).
  const refKeys = useRef(new Map<string, Promise<string[] | null>>());
  const [objEdit, setObjEdit] = useState<EditState>({ status: 'loading' });
  const [strTarget, setStrTarget] = useState<string | null>(null);
  const [objReloaded, setObjReloaded] = useState<Reloaded | null>(null);
  // objResult with the rows read on from its open cursor (scrolling to the end).
  const [objGrown, setObjGrown] = useState<QueryResult | null>(null);
  const [boolFetching, setBoolFetching] = useState(false);
  const refFetching = useRef(false);
  const refRerunFailed = useRef(false); // scrolling stops running the statement again after an error; "More rows" still does
  const strReadSession = strSessionId ?? strDataSessionId;
  // Pending work: cell edits of loaded rows (`row:col`), new rows (a value per result column), rows to delete.
  const [dicChanges, setDicChanges] = useState<Map<string, string | null>>(new Map());
  const [arrNew, setArrNew] = useState<(string | null)[][]>([]);
  const [hsDeleted, setHsDeleted] = useState<Set<number>>(new Set());
  const [hsRows, setHsRows] = useState<Set<number>>(new Set());
  const [objApply, setObjApply] = useState<ApplyState>({ status: 'idle' });
  const [objNote, setObjNote] = useState<{ text: string; error: boolean } | null>(null);
  const [boolLoading, setBoolLoading] = useState(false);
  const [strView, setStrView] = useState<ViewMode>('grid');
  const [objReveal, setObjReveal] = useState<{ row: number } | null>(null);
  const [intCurrent, setIntCurrent] = useState<number | null>(null);
  const [objCommand, setObjCommand] = useState<{ name: GridCommand } | null>(null);
  const [boolExportMenu, setBoolExportMenu] = useState(false);
  const refExportButton = useRef<HTMLButtonElement>(null);
  // The menu is placed on the window (fixed): the bar it belongs to clips what sticks out of it.
  const objExportBox = boolExportMenu ? refExportButton.current?.getBoundingClientRect() : undefined;
  useEffect(() => {
    if (!boolExportMenu) return;
    const onDown = (objEvent: MouseEvent) => {
      if (!(objEvent.target as HTMLElement).closest('[data-export-menu]')) setBoolExportMenu(false);
    };
    const onKey = (objEvent: KeyboardEvent) => { if (objEvent.key === 'Escape') setBoolExportMenu(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [boolExportMenu]);
  const [, setIntVersion] = useState(0); // rows are updated in place after a save: this redraws the grid
  const refStart = useRef(0); // only the latest result's check may answer
  // Oracle: table column -> what generates the key (`OWNER.SEQ.NEXTVAL`, `OWNER.TABLE_NEWID()`), looked up once per table.
  const [objAuto, setObjAuto] = useState<{ key: string; columns: Map<string, string>; procedures: Set<string> } | null>(null);

  // Refresh runs the statement again: only offered for what reads (a SELECT; a Mongo find / aggregate / count).
  const boolSelect = objConnection.kind === 'MongoDb' ? /^\s*db\b[\s\S]*\.\s*(?:find|findOne|aggregate|count|countDocuments|distinct)\s*\(/.test(strSql) && !/\$out|\$merge/.test(strSql)
    : objConnection.kind === 'Redis' ? false : looksLikeSelect(strSql);
  const clearPending = () => { setDicChanges(new Map()); setArrNew([]); setHsDeleted(new Set()); setObjApply({ status: 'idle' }); };

  const startOracle = async (): Promise<[EditState, string | null]> => {
    const objParsed = parseSelect(strSql);
    if (typeof objParsed === 'string') return [{ status: 'unavailable', message: objParsed }, null];
    // Column lists tell what "*" and unqualified names stand for. Schemas named in the FROM clause are loaded on the way.
    let objMeta = await api.metadata(objConnection.id);
    for (const strSchema of new Set(objParsed.from.filter(objItem => objItem.ref.includes('.')).map(objItem => upper(objItem.ref.split('.')[0])))) {
      if (objMeta.loadedSchemas?.includes(strSchema) || !objMeta.schemas?.includes(strSchema)) continue;
      objMeta = await api.metadata(objConnection.id, false, strSchema).catch(() => objMeta);
    }
    const objMap = mapColumns(objParsed, objResult.columns.map(objColumn => objColumn.name), objItem => columnsFrom(objMeta, objItem));
    if (typeof objMap === 'string') return [{ status: 'unavailable', message: objMap }, null];
    const arrFound = rowIdTargets(objParsed, objMap, objResult);
    return [{ status: 'on', targets: arrFound, parsed: objParsed }, arrFound.find(objItem => !objItem.reason)?.key ?? null];
  };

  // A new result: find out what can be edited. Nothing is run for this (a describe, or the statement's text).
  useEffect(() => {
    const intStart = ++refStart.current;
    setStrTarget(null);
    setObjReloaded(null);
    setObjGrown(null);
    refRerunFailed.current = false;
    clearPending();
    setHsRows(new Set());
    setObjNote(null);
    setIntLimit(intMaxRows);
    if (objConnection.kind === 'MongoDb') {
      const objFound = mongoTarget(strSql, objResult);
      if (typeof objFound === 'string') return setObjEdit({ status: 'unavailable', message: objFound });
      setObjEdit({ status: 'on', targets: [objFound] });
      return setStrTarget(objFound.reason ? null : objFound.key);
    }
    if (objConnection.kind !== 'PostgreSql' && objConnection.kind !== 'Oracle')
      return setObjEdit({ status: 'unavailable', message: `cells are edited in the grid on PostgreSQL, Oracle and MongoDB only${objConnection.kind === 'Redis' ? ' (a key has its own editor in its Value tab)' : ''}.` });
    if (!boolSelect) return setObjEdit({ status: 'unavailable', message: 'only the result of a SELECT can be edited.' });
    setObjEdit({ status: 'loading' });
    (async (): Promise<[EditState, string | null]> => {
      if (objConnection.kind === 'Oracle') return startOracle();
      const objTargets = editTargets(objResult, await api.describeResult(objConnection.id, strSql), objConnection.kind);
      if (typeof objTargets === 'string') return [{ status: 'unavailable', message: objTargets }, null];
      return [{ status: 'on', targets: objTargets }, objTargets.find(objItem => !objItem.reason)?.key ?? null];
    })().catch((objEx): [EditState, string | null] => [{ status: 'unavailable', message: errorMessage(objEx) }, null])
      .then(([objState, strFirst]) => {
        if (intStart !== refStart.current) return;
        setObjEdit(objState);
        // One table: it is the one being edited. Several: read-only until the Table box says which.
        const intTables = objState.status === 'on' ? objState.targets.length : 0;
        setStrTarget(intTables === 1 ? strFirst : null);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objResult]);

  const arrTargets = objEdit.status === 'on' ? objEdit.targets : [];
  const objTarget = arrTargets.find(objItem => objItem.key === strTarget && !objItem.reason);
  const objShown = objReloaded?.result ?? objGrown ?? objResult;
  // ROWIDs only count for the table they were read for.
  const arrRowIds = objTarget?.byRowId && objReloaded?.target === objTarget.key ? objReloaded.rowIds : undefined;
  const intBase = objShown.rows.length;
  const boolSql = objConnection.kind !== 'MongoDb';
  const boolBusy = objApply.status === 'running' || boolLoading;
  const intPending = dicChanges.size + arrNew.length + hsDeleted.size;

  // What the grid draws: the loaded rows, then the new ones.
  const objGrid = useMemo(() => (arrNew.length === 0 ? objShown : { ...objShown, rows: [...objShown.rows, ...arrNew] }), [objShown, arrNew]);

  /** Runs the statement again (for a ROWID table: with its ROWID as a last column, kept apart from the grid). */
  const reload = async (objFor: EditTarget | undefined, intRows = intLimit): Promise<Reloaded | null> => {
    const objParsed = objEdit.status === 'on' ? objEdit.parsed : undefined;
    const boolRowId = !!objFor?.byRowId && !!objParsed;
    const strRun = boolRowId ? rowIdSql(strSql, objParsed!, objParsed!.from[Number(objFor!.key.slice(1))]) : strSql;
    if (!strRun) {
      setObjNote({ text: 'A subquery in FROM has no alias: "*" cannot be combined with ROWID. List the columns instead.', error: true });
      return null;
    }
    setBoolLoading(true);
    try {
      const objLoaded = await api.query(crypto.randomUUID(), objConnection.id, strRun, intRows, strReadSession, boolAutoCommit, true);
      if (strSessionId) onRan?.();
      if (objConnection.kind === 'MongoDb') {
        // Documents have no fixed columns: what can be edited is worked out again from the rows just read.
        const objFound = mongoTarget(strSql, objLoaded);
        setObjEdit(typeof objFound === 'string' ? { status: 'unavailable', message: objFound } : { status: 'on', targets: [objFound] });
        const objFresh: Reloaded = { result: objLoaded };
        setObjReloaded(objFresh);
        return objFresh;
      }
      const intColumns = objLoaded.columns.length - (boolRowId ? 1 : 0);
      const boolSameShape = intColumns === objResult.columns.length && (!boolRowId || objLoaded.columns[intColumns]?.name === ROWID_ALIAS)
        && objResult.columns.every((objColumn, intCol) => objColumn.name === objLoaded.columns[intCol].name);
      if (!boolSameShape) throw new Error('The statement returned other columns when it was run again.');
      const objNext: Reloaded = !boolRowId ? { result: objLoaded } : {
        target: objFor!.key,
        result: { ...objLoaded, columns: objLoaded.columns.slice(0, intColumns), rows: objLoaded.rows.map(arrRow => arrRow.slice(0, intColumns)) },
        rowIds: objLoaded.rows.map(arrRow => (arrRow[intColumns] === null || arrRow[intColumns] === undefined ? null : String(arrRow[intColumns]))),
      };
      setObjReloaded(objNext);
      return objNext;
    } catch (objEx) {
      setObjNote({ text: errorMessage(objEx), error: true });
      return null;
    } finally {
      setBoolLoading(false);
    }
  };

  /**
   * Before a loaded row is changed or deleted. Oracle reads the ROWIDs now; if the rows read again are not the ones
   * on screen the action is dropped, since a row number may point at another row. Null: not ready.
   */
  const prepare = async (): Promise<{ rowIds?: (string | null)[] } | null> => {
    if (!objTarget) return null;
    if (!objTarget.byRowId) return {};
    if (arrRowIds) return { rowIds: arrRowIds };
    const arrBefore = objShown.rows;
    const objNext = await reload(objTarget, Math.max(intLimit, arrBefore.length)); // rows read by scrolling are compared too
    if (!objNext) return null;
    if (sameRows(arrBefore, objNext.result.rows)) return { rowIds: objNext.rowIds };
    setHsRows(new Set());
    setObjNote({ text: 'The rows were read again with their ROWID and they are not the same as before. Check them, then repeat the change.', error: false });
    return null;
  };

  /** The result stopped at the row limit: the statement runs again for five times as many (the server gives 100,000 at most). */
  const MAX_SERVER_ROWS = 100000;
  // Reading on by running the statement again (its first rows are passed over on the server): only what reads, on
  // the drivers that can keep a result open.
  const boolCanRerun = (objConnection.kind === 'PostgreSql' || objConnection.kind === 'Oracle') && boolSelect && !!strReadSession;

  /**
   * Reads the next rows. From the result the session left open when it still is (nothing runs again); otherwise, when
   * boolRerun allows it, the statement runs again from the row the grid stopped at and stays open from there.
   * The new rows go after the loaded ones, so pending cell edits and deletions keep their row numbers; rows being
   * added sit below and wait.
   */
  const fetchMore = async (intRows: number, boolRerun: boolean) => {
    const strCursor = objShown.cursor;
    if (!strReadSession || refFetching.current || arrNew.length > 0 || !objShown.truncated) return;
    if (!strCursor && !(boolRerun && boolCanRerun)) return;
    const intStart = refStart.current;
    const objFrom = objReloaded;
    const intColumns = objShown.columns.length;
    const intLoaded = objShown.rows.length;
    refFetching.current = true;
    setBoolFetching(true);
    try {
      let objNext = strCursor ? await api.fetchMore(crypto.randomUUID(), strReadSession, strCursor, intRows) : null;
      if (!objNext && boolRerun && boolCanRerun) {
        // The statement the rows on screen came from: with the ROWID column when they were read that way.
        const objFor = objFrom?.rowIds ? arrTargets.find(objItem => objItem.key === objFrom.target) : undefined;
        const objParsed = objEdit.status === 'on' ? objEdit.parsed : undefined;
        const strRun = objFrom?.rowIds ? (objFor && objParsed ? rowIdSql(strSql, objParsed, objParsed.from[Number(objFor.key.slice(1))]) : null) : strSql;
        if (!strRun) return;
        refRerunFailed.current = true; // cleared below once the rows are in
        objNext = await api.query(crypto.randomUUID(), objConnection.id, strRun, intRows, strReadSession, boolAutoCommit, true, intLoaded);
        if (strSessionId) onRan?.();
        if (objNext.columns.length !== intColumns + (objFrom?.rowIds ? 1 : 0)) throw new Error('The statement returned other columns when it was run again.');
        refRerunFailed.current = false;
      }
      if (intStart !== refStart.current) return;
      // Null: closed on the server and not run again. The grid keeps its rows; "More rows" reads on.
      const arrAdded = objNext?.rows ?? [];
      const strNext = objNext?.cursor ?? null;
      const boolTruncated = objNext ? objNext.truncated : true;
      if (objFrom) {
        setObjReloaded(objPrev => (objPrev !== objFrom ? objPrev : {
          ...objPrev,
          result: { ...objPrev.result, rows: [...objPrev.result.rows, ...(objPrev.rowIds ? arrAdded.map(arrRow => arrRow.slice(0, intColumns)) : arrAdded)], cursor: strNext, truncated: boolTruncated },
          rowIds: objPrev.rowIds && [...objPrev.rowIds, ...arrAdded.map(arrRow => (arrRow[intColumns] === null || arrRow[intColumns] === undefined ? null : String(arrRow[intColumns])))],
        }));
      } else {
        setObjGrown(objPrev => {
          const objBase = objPrev ?? objResult;
          return { ...objBase, rows: [...objBase.rows, ...arrAdded], cursor: strNext, truncated: boolTruncated };
        });
      }
    } catch (objEx) {
      // The tab is running something else: the next scroll asks again. Anything else is worth showing.
      if (!(objEx instanceof ApiError && /still running/.test(objEx.detail.message))) setObjNote({ text: errorMessage(objEx), error: true });
    } finally {
      refFetching.current = false;
      setBoolFetching(false);
    }
  };

  const loadMore = async () => {
    if (intPending > 0 && !confirm(`Discard ${plural(intPending, 'unsaved change')} and read more rows?`)) return;
    const intNext = Math.min(Math.max(objShown.rows.length, intLimit) * 5, MAX_SERVER_ROWS);
    setObjNote(null);
    if (!(await reload(objTarget, intNext))) return;
    setIntLimit(intNext);
    clearPending();
    setHsRows(new Set());
  };

  const refresh = async () => {
    if (intPending > 0 && !confirm(`Discard ${plural(intPending, 'unsaved change')} and read the rows again?`)) return;
    setObjNote(null);
    if (!(await reload(objTarget))) return;
    clearPending();
    setHsRows(new Set());
  };

  const cancel = () => { clearPending(); setObjNote(null); };

  const pickTarget = (strKey: string) => {
    if (intPending > 0 && !confirm(strKey ? 'Changes are kept per table. Discard the unsaved changes and edit the other table?' : 'Discard the unsaved changes and go back to read-only?')) return;
    clearPending();
    setObjNote(null);
    setStrTarget(strKey);
  };

  const dicAuto = objAuto && objAuto.key === objTarget?.key ? objAuto.columns : undefined;
  const hsProcedures = objAuto && objAuto.key === objTarget?.key ? objAuto.procedures : undefined;

  /** Finds the key's sequence the first time a row is added. Nothing found (or an error): empty cells stay empty. */
  const loadAuto = async (objFor: EditTarget): Promise<Map<string, string>> => {
    if (dicAuto) return dicAuto;
    const dicFound = new Map<string, string>();
    const hsFoundProcedures = new Set<string>();
    if (objConnection.kind === 'Oracle') {
      try {
        const objFoundRows = await api.query(crypto.randomUUID(), objConnection.id, keyGeneratorSql(objFor.tableSql), 20);
        for (const [strColumn, strType, strOwner, strName] of objFoundRows.rows as string[][]) {
          if (dicFound.has(strColumn) || !/^[\w$#]+$/.test(strOwner) || !/^[\w$#]+$/.test(strName)) continue;
          dicFound.set(strColumn, strType === 'SEQUENCE' ? `${strOwner}.${strName}.NEXTVAL` : `${strOwner}.${strName}()`);
          if (strType === 'PROCEDURE') hsFoundProcedures.add(`${strOwner}.${strName}`.toUpperCase());
        }
      } catch { /* no generator known */ }
    }
    setObjAuto({ key: objFor.key, columns: dicFound, procedures: hsFoundProcedures });
    return dicFound;
  };

  // ---- rows ----
  /** The selected rows in grid order. */
  // Whole rows picked by their number; with none, the row of the current cell is the one the row buttons act on.
  // A block of cells counts as its rows.
  const arrPicked = useMemo(() => (hsRows.size > 0 ? [...hsRows] : objBlock ? objBlock.rows : intCurrent === null ? [] : [intCurrent])
    .filter(intRow => intRow < objGrid.rows.length).sort((intA, intB) => intA - intB), [hsRows, objBlock, intCurrent, objGrid]);

  const addRow = async () => {
    if (!objTarget) return;
    const dicFound = await loadAuto(objTarget);
    setObjReveal({ row: intBase + arrNew.length });
    setHsRows(new Set([intBase + arrNew.length]));
    // The key cell shows the sequence it will take; type a value over it to set the key by hand.
    setArrNew(arrPrev => [...arrPrev, objShown.columns.map((_, intCol) => {
      const strAuto = dicFound.get(objTarget.columns.get(intCol) ?? '');
      return strAuto ? `=${strAuto}` : null;
    })]);
    setObjApply({ status: 'idle' });
  };

  /** Copies of the selected rows as new rows: only the columns of the table being edited, with their pending edits. */
  const duplicateRows = async () => {
    if (!objTarget || arrPicked.length === 0) return;
    const dicFound = await loadAuto(objTarget);
    let intCut = 0;
    const arrCopies = arrPicked.map(intRow => objShown.columns.map((_, intCol) => {
      if (!objTarget.columns.has(intCol)) return null;
      // A copy gets a key of its own.
      const strAuto = dicFound.get(objTarget.columns.get(intCol)!);
      if (strAuto) return `=${strAuto}`;
      const objValue = dicChanges.has(cellKey(intRow, intCol)) ? dicChanges.get(cellKey(intRow, intCol)) : objGrid.rows[intRow][intCol];
      if (objValue === null || objValue === undefined) return null;
      // Binary longer than the preview cannot be copied from what the grid holds.
      if (boolSql && isBinaryType(objShown.columns[intCol].dataType) && binaryHex(display(objValue)) === null) { intCut++; return null; }
      if (objTarget.cellError?.(intCol, display(objValue))) { intCut++; return null; }
      return display(objValue);
    }));
    setObjNote(intCut > 0
      ? { text: `${plural(intCut, 'value')} could not be copied: the grid only holds the first part of them. Those cells are empty in the copy.`, error: true }
      : null);
    setObjReveal({ row: intBase + arrNew.length });
    setHsRows(new Set(arrCopies.map((_, intCopy) => intBase + arrNew.length + intCopy)));
    setArrNew(arrPrev => [...arrPrev, ...arrCopies]);
    setObjApply({ status: 'idle' });
  };

  /** New rows are dropped at once; loaded rows are marked and deleted on Save (again: unmarked). */
  const deleteRows = async () => {
    if (!objTarget || arrPicked.length === 0) return;
    const arrLoaded = arrPicked.filter(intRow => intRow < intBase);
    const hsDropNew = new Set(arrPicked.filter(intRow => intRow >= intBase).map(intRow => intRow - intBase));
    const objReady = arrLoaded.length > 0 ? await prepare() : {};
    if (!objReady) return;
    const arrCan = arrLoaded.filter(intRow => rowEditable(objTarget, objShown.rows[intRow], objReady.rowIds?.[intRow]));
    const boolUnmark = arrCan.length > 0 && arrCan.every(intRow => hsDeleted.has(intRow));
    setHsDeleted(hsPrev => {
      const hsNext = new Set(hsPrev);
      for (const intRow of arrCan) if (boolUnmark) hsNext.delete(intRow); else hsNext.add(intRow);
      return hsNext;
    });
    if (hsDropNew.size > 0) {
      setArrNew(arrPrev => arrPrev.filter((_, intNew) => !hsDropNew.has(intNew)));
      setHsRows(new Set()); // the new rows moved up
    }
    setObjApply({ status: 'idle' });
    setObjNote(arrCan.length < arrLoaded.length
      ? { text: `${plural(arrLoaded.length - arrCan.length, 'row')} cannot be deleted here: no ${objTarget.byRowId ? 'ROWID' : 'whole primary key'} of ${objTarget.label} in that row.`, error: false }
      : null);
  };

  // What the grid needs to know: which columns take edits, which rows, and the edits so far.
  const objGridEdit = useMemo((): GridEdit | undefined => {
    if (!objTarget || boolBusy) return undefined;
    return {
      arrEditable: objShown.columns.map((_, intCol) => objTarget.columns.has(intCol)),
      dicChanges, intBase, hsDeleted,
      // Without ROWIDs yet the answer comes from start().
      canEdit: (intRow: number) => intRow >= intBase
        || (!hsDeleted.has(intRow) && (objTarget.byRowId && !arrRowIds ? true : rowEditable(objTarget, objShown.rows[intRow], arrRowIds?.[intRow]))),
      start: async (intRow: number) => {
        if (intRow >= intBase) return true;
        const objReady = await prepare();
        return !!objReady && rowEditable(objTarget, objShown.rows[intRow], objReady.rowIds?.[intRow]);
      },
      onEdit: (intRow: number, intCol: number, strValue: string | null | undefined) => {
        if (strValue === undefined && intRow >= intBase) return;
        if (boolSql && strValue && !strValue.startsWith('=') && isBinaryType(objShown.columns[intCol].dataType) && binaryHex(strValue) === null) {
          return setObjNote({ text: `${objShown.columns[intCol].name} is binary: type the whole value as hex, like 0x1A2B (an even number of hex digits).`, error: true });
        }
        const strCellError = strValue ? objTarget.cellError?.(intCol, strValue) : null;
        if (strCellError) return setObjNote({ text: strCellError, error: true });
        setObjApply({ status: 'idle' });
        if (intRow >= intBase) {
          return setArrNew(arrPrev => arrPrev.map((arrRow, intNew) => (intNew === intRow - intBase ? arrRow.map((strOld, intAt) => (intAt === intCol ? strValue! : strOld)) : arrRow)));
        }
        setDicChanges(dicPrev => {
          const dicNext = new Map(dicPrev);
          if (strValue === undefined) dicNext.delete(cellKey(intRow, intCol));
          else dicNext.set(cellKey(intRow, intCol), strValue);
          return dicNext;
        });
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objTarget, objShown, arrRowIds, dicChanges, hsDeleted, intBase, boolBusy]);

  // ---- save ----
  // The statements Save will run, shown under the grid as the changes are made.
  const arrStatements = useMemo((): RowUpdate[] => {
    if (!objTarget || intPending === 0) return [];
    // A row marked for deletion is not updated first.
    const dicKept = new Map([...dicChanges].filter(([strCell]) => !hsDeleted.has(Number(strCell.split(':')[0]))));
    if (objConnection.kind === 'MongoDb') return buildMongoStatements(objTarget, objShown, dicKept, arrNew, intBase, [...hsDeleted]);
    return [
      ...buildUpdates(objConnection.kind, objTarget, objShown, dicKept, arrRowIds),
      ...buildInserts(objConnection.kind, objTarget, objShown, arrNew, intBase, dicAuto, hsProcedures),
      ...buildDeletes(objConnection.kind, objTarget, objShown, [...hsDeleted], arrRowIds),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objTarget, objShown, arrRowIds, dicChanges, arrNew, hsDeleted, dicAuto]);

  /** Writes a saved update into the loaded rows (every result column showing that table column). */
  const commitRow = (objTable: EditTarget, objUpdate: RowUpdate) => {
    for (const objCell of objUpdate.cells) {
      const strColumn = objTable.columns.get(objCell.col);
      for (const [intCol, strOther] of objTable.columns) if (strOther === strColumn) objShown.rows[objUpdate.row][intCol] = objCell.value;
    }
  };

  const apply = async (arrUpdates: RowUpdate[]) => {
    if (!objTarget) return;
    // A transaction of its own (all or nothing), unless the tab is in Manual mode: then its open transaction takes them.
    // MongoDB runs where the tab is (its current database, its transaction if it has one): a standalone server has no transactions to wrap them in.
    const boolMongo = objConnection.kind === 'MongoDb';
    const boolTabTransaction = !!strSessionId && !boolAutoCommit;
    const strOwnSession = !boolMongo && !boolTabTransaction ? crypto.randomUUID() : null;
    const arrDone: RowUpdate[] = [];
    setObjNote(null);
    setObjApply({ status: 'running', total: arrUpdates.length, done: 0 });
    let strFailure: string | null = null;
    try {
      for (const objUpdate of arrUpdates) {
        const objDone = await api.query(crypto.randomUUID(), objConnection.id, objUpdate.sql, 1, strOwnSession ?? strSessionId, boolMongo ? !boolTabTransaction : false);
        const intCount = objUpdate.check === 'matched'
          ? Number(objDone.rows[0]?.[objDone.columns.findIndex(objColumn => objColumn.name === 'matchedCount')] ?? 0)
          : objDone.recordsAffected;
        if (!objUpdate.block && intCount !== 1) {
          throw new Error(`${intCount} rows were affected instead of 1: the row was changed or deleted since it was read. Refresh and try again.\n\n${objUpdate.sql}`);
        }
        arrDone.push(objUpdate);
        setObjApply({ status: 'running', total: arrUpdates.length, done: arrDone.length });
      }
      if (strOwnSession) await api.commit(strOwnSession);
    } catch (objEx) {
      strFailure = errorMessage(objEx);
      if (strOwnSession) {
        await api.rollback(strOwnSession).catch(() => {});
        arrDone.length = 0;
      }
    } finally {
      if (strOwnSession) api.closeSession(strOwnSession).catch(() => {});
    }
    if (!strOwnSession && arrDone.length > 0) onRan?.();

    const count = (strKind: RowUpdate['kind']) => arrDone.filter(objUpdate => objUpdate.kind === strKind).length;
    const boolRowsMoved = strFailure === null ? arrDone.some(objUpdate => objUpdate.kind !== 'update') : count('delete') > 0;
    // Saved updates show in place; new and deleted rows need the rows read again.
    for (const objUpdate of arrDone) if (objUpdate.kind === 'update') commitRow(objTarget, objUpdate);
    const hsSavedRows = new Set(arrDone.filter(objUpdate => objUpdate.kind === 'update').map(objUpdate => objUpdate.row));
    setDicChanges(dicPrev => new Map([...dicPrev].filter(([strCell]) => !hsSavedRows.has(Number(strCell.split(':')[0])))));
    const hsInserted = new Set(arrDone.filter(objUpdate => objUpdate.kind === 'insert').map(objUpdate => objUpdate.row - intBase));
    setArrNew(arrPrev => arrPrev.filter((_, intNew) => !hsInserted.has(intNew)));
    setObjApply({ status: 'idle' });
    setIntVersion(intPrev => intPrev + 1);

    if (strFailure !== null) {
      const strDone = strOwnSession ? 'Nothing was changed: everything was rolled back.'
        : arrDone.length === 0 ? 'Nothing was changed.'
          : `Already done${boolTabTransaction ? ' in the open transaction' : ' (each statement is saved as it runs)'}: ${plural(count('update'), 'update')}, ${plural(count('insert'), 'insert')}, ${plural(count('delete'), 'delete')}.`
            + (count('insert') > 0 && !boolRowsMoved ? ' The inserted rows show after Refresh.' : '')
            + (boolRowsMoved ? ' The rows were read again; mark the rows that are left to delete once more.' : '');
      setObjNote({ text: `${strFailure}\n\n${strDone}`, error: true });
    } else {
      setObjNote({ text: `Saved ${plural(arrDone.length, 'row')}${boolTabTransaction ? ' in the open transaction (not committed yet)' : ''}.`, error: false });
    }
    if (boolRowsMoved) {
      setHsDeleted(new Set());
      setHsRows(new Set());
      await reload(objTarget);
    }
  };

  // ---- generate script as (right-click) ----
  const boolScripts = objConnection.kind === 'PostgreSql' || objConnection.kind === 'Oracle';
  // The table being edited, else the first table the statement names.
  const strScriptTable = objTarget?.tableSql ?? (objEdit.status === 'on' ? objEdit.parsed?.from.find(objItem => !objItem.subquery)?.ref : undefined)
    ?? /\bfrom\s+((?:"[^"]+"|[\w$#]+)(?:\.(?:"[^"]+"|[\w$#]+))*)/i.exec(strSql)?.[1] ?? 'table_name';
  // Result column -> table column: the table's own columns when it is known, else every column by its name.
  const dicScriptNames = objTarget?.columns ?? new Map(objShown.columns.map((objColumn, intCol) => [intCol, objColumn.name] as [number, string]));

  /** Oracle rows are found by ROWID, so the grid does not know the primary key: the catalog does. */
  const loadKeys = (): Promise<string[] | null> => {
    if (objConnection.kind !== 'Oracle' || (objTarget && !objTarget.byRowId)) return Promise.resolve(null);
    let objPending = refKeys.current.get(strScriptTable);
    if (!objPending) {
      objPending = api.query(crypto.randomUUID(), objConnection.id, primaryKeySql(strScriptTable), 50)
        .then(objFound => objFound.rows.map(arrRow => String(arrRow[0])), () => null);
      refKeys.current.set(strScriptTable, objPending);
    }
    return objPending;
  };

  /** The result columns of the primary key, or why they are not known. */
  const scriptKeys = async (): Promise<{ keys: number[]; keyNote?: string }> => {
    if (objTarget && !objTarget.byRowId) return { keys: objTarget.keyIndexes.map(arrIndexes => arrIndexes[0]) };
    if (objConnection.kind !== 'Oracle') return { keys: [], keyNote: `The primary key of ${strScriptTable} is not known (the result is read-only)` };
    const arrNames = await loadKeys();
    if (!arrNames) return { keys: [], keyNote: `The primary key of ${strScriptTable} could not be read` };
    if (arrNames.length === 0) return { keys: [], keyNote: `${strScriptTable} has no primary key` };
    const arrKeys = arrNames.map(strKey => [...dicScriptNames].find(([, strColumn]) => strColumn.replace(/^"|"$/g, '').toUpperCase() === strKey.toUpperCase())?.[0] ?? -1);
    return arrKeys.includes(-1)
      ? { keys: [], keyNote: `The primary key of ${strScriptTable} (${arrNames.join(', ')}) is not in this result` }
      : { keys: arrKeys };
  };

  const scriptItems = (): MenuItem[] => {
    if (!objMenu) return [];
    const { row: intRow, col: intCol } = objMenu;
    const arrAll = [...dicScriptNames.keys()];
    const boolInBlock = !!objBlock && intRow !== null && intCol !== null && objBlock.rows.includes(intRow) && objBlock.cols.includes(intCol);
    // What is selected, as dbForge reads it: a block of cells (its columns only), whole rows (every column),
    // or just the cell under the pointer (its row; WHERE is about its column).
    let arrRows: number[];
    let arrCols = arrAll;
    let arrWhere = arrAll;
    if (boolInBlock) {
      arrRows = objBlock!.rows;
      arrCols = arrWhere = objBlock!.cols.filter(intItem => dicScriptNames.has(intItem));
    } else if (hsRows.size > 0 && (intRow === null || hsRows.has(intRow))) {
      arrRows = arrPicked;
    } else {
      arrRows = intRow !== null ? [intRow] : arrPicked;
      if (intCol !== null && dicScriptNames.has(intCol)) arrWhere = [intCol];
    }
    arrRows = arrRows.filter(intItem => intItem < intBase); // rows not saved yet are left out

    const strFile = strScriptTable.replace(/"/g, '').split('.').pop() || 'script';
    const destinations = (strScript: ScriptKind): MenuItem[] => {
      const text = async () => {
        const objBase: ScriptSource = {
          kind: objConnection.kind, result: objShown, rows: arrRows, table: strScriptTable, names: dicScriptNames,
          cols: strScript === 'insert' || strScript === 'update' ? arrCols : arrWhere, keys: [],
        };
        return generateScript(strScript, strScript === 'update' ? { ...objBase, ...(await scriptKeys()) } : objBase);
      };
      const failed = (objEx: unknown) => showToast('error', 'The script could not be written', errorMessage(objEx));
      return [
        { label: 'To SQL tab', disabled: !onOpenSql, onSelect: () => { text().then(strText => onOpenSql?.(strText), failed); } },
        // The server's Save dialog picks the path.
        { label: 'To file…', onSelect: () => { text().then(strText => api.saveSqlFile(null, `${strFile}-${strScript.toLowerCase()}.sql`, strText))
          .then(objSaved => { if (objSaved) showToast('success', 'Script saved', objSaved.path); }, failed); } },
        { label: 'To clipboard', onSelect: () => { text().then(strText => navigator.clipboard.writeText(strText))
          .then(() => showToast('success', `Script of ${plural(arrRows.length, 'row')} copied`), failed); } },
      ];
    };
    const boolNone = arrRows.length === 0 || arrCols.length === 0;
    return [
      { kind: 'header', label: `${strScriptTable} · ${plural(arrRows.length, 'row')}${arrCols.length < arrAll.length ? ` × ${plural(arrCols.length, 'column')}` : ''}` },
      { label: 'Generate script as', disabled: boolNone, items: [
        { label: 'INSERT', items: destinations('insert') },
        // One column only, like dbForge: several columns have no single IN list.
        { label: 'WHERE IN ()', disabled: arrWhere.length !== 1, items: destinations('whereIn') },
        { label: 'WHERE AND OR', disabled: arrWhere.length === 0, items: destinations('whereAndOr') },
        { label: 'UPDATE', items: destinations('update') },
      ] },
    ];
  };

  // ---- selection summary, value of the current cell ----
  // Count of the selected cells that hold a value, and sum / average / min / max when they are all numbers.
  const strSummary = useMemo(() => {
    if (!objBlock) return null;
    const intCells = objBlock.rows.length * objBlock.cols.length;
    if (intCells < 2) return null;
    if (intCells > 500000) return `${intCells.toLocaleString()} cells`;
    let intCount = 0;
    let intNumbers = 0;
    let decSum = 0;
    let decMin = Infinity;
    let decMax = -Infinity;
    for (const intRow of objBlock.rows) {
      for (const intCol of objBlock.cols) {
        const objValue = objGrid.rows[intRow]?.[intCol];
        if (objValue === null || objValue === undefined || objValue === '') continue;
        intCount++;
        const decValue = typeof objValue === 'number' ? objValue : typeof objValue === 'string' && /^-?\d+(\.\d+)?$/.test(objValue) ? Number(objValue) : NaN;
        if (!Number.isFinite(decValue)) continue;
        intNumbers++;
        decSum += decValue;
        decMin = Math.min(decMin, decValue);
        decMax = Math.max(decMax, decValue);
      }
    }
    const format = (decValue: number) => decValue.toLocaleString(undefined, { maximumFractionDigits: 4 });
    return intNumbers > 0 && intNumbers === intCount
      ? `Count ${intCount.toLocaleString()} · Sum ${format(decSum)} · Avg ${format(decSum / intCount)} · Min ${format(decMin)} · Max ${format(decMax)}`
      : `Count ${intCount.toLocaleString()}`;
  }, [objBlock, objGrid]);

  // The current cell's whole value; JSON is laid out.
  const objCellColumn = objCell ? objGrid.columns[objCell.col] : undefined;
  const strCellValue = useMemo(() => {
    if (!objCell || !objCellColumn) return null;
    const strKey = cellKey(objCell.row, objCell.col);
    const objValue = dicChanges.has(strKey) ? dicChanges.get(strKey) : objGrid.rows[objCell.row]?.[objCell.col];
    if (objValue === null || objValue === undefined) return null;
    const strText = display(objValue);
    if (/^\s*[[{]/.test(strText)) {
      try { return JSON.stringify(JSON.parse(strText), null, 2); } catch { /* not JSON: shown as it is */ }
    }
    return strText;
  }, [objCell, objCellColumn, objGrid, dicChanges]);

  // ---- text ----
  const strStatus = objEdit.status === 'loading' ? 'Checking which table each column comes from…'
    : objEdit.status === 'unavailable' ? `Read-only: ${objEdit.message}`
      : !objTarget && arrTargets.some(objItem => !objItem.reason) ? 'Read-only · choose the table to edit in the Table box'
        : !objTarget ? (objConnection.kind === 'Oracle' ? 'Read-only: the SELECT takes no column straight from a table of its FROM clause.'
        : 'Read-only: a table needs a primary key, and its key columns must be in the SELECT.')
        : objApply.status === 'running' ? `Saving… ${objApply.done} of ${objApply.total}`
          : boolLoading ? 'Reading the rows…'
          : `Double-click or Enter to edit · empty = NULL · rows found by ${objTarget.keyColumns.join(', ')}`;
  const arrSummary = [
    dicChanges.size > 0 && `${plural(dicChanges.size, 'cell')} changed`,
    arrNew.length > 0 && `${arrNew.length} new`,
    hsDeleted.size > 0 && `${hsDeleted.size} to delete`,
  ].filter(Boolean);
  const boolCanRows = !!objTarget && !boolBusy;
  // Text and Record show the selected rows; with none (or one, for Text) all of them.
  const arrAll = useMemo(() => objGrid.rows.map((_, intRow) => intRow), [objGrid]);
  const arrTextRows = arrPicked.length > 1 ? arrPicked : arrAll;
  const arrRecordRows = arrPicked.length > 0 ? arrPicked : arrAll.slice(0, 1);

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        {/* view switch, down the left edge */}
        <div className="flex w-6 shrink-0 flex-col items-center gap-1 border-r border-line bg-bg py-1" role="tablist" aria-label="Result view">
          {VIEWS.map(objView => (
            <button key={objView.mode} type="button" role="tab" aria-selected={strView === objView.mode} title={objView.title}
              onClick={() => setStrView(objView.mode)}
              className={`rotate-180 rounded-sm px-0.5 py-2 text-[11px] [writing-mode:vertical-rl] ${
                strView === objView.mode ? 'bg-accent/20 font-semibold text-accent' : 'text-muted hover:bg-hover hover:text-fg'}`}>
              {objView.label}
            </button>
          ))}
        </div>
        <div className="min-h-0 min-w-0 flex-1" onContextMenu={objEvent => {
          if (!boolScripts || strView !== 'grid') return;
          objEvent.preventDefault();
          // data-cell = "row:col" on every grid cell
          const arrCell = (objEvent.target as Element).closest?.('[data-cell]')?.getAttribute('data-cell')?.split(':').map(Number);
          setObjMenu({ x: objEvent.clientX, y: objEvent.clientY, row: arrCell?.[0] ?? null, col: arrCell?.[1] ?? null });
          void loadKeys(); // ready by the time UPDATE is picked
        }}>
          {objMenu && <ContextMenu intX={objMenu.x} intY={objMenu.y} arrItems={scriptItems()} onClose={() => setObjMenu(null)} />}
          {strView === 'grid' && (
            <ResultGrid objResult={objGrid} strExportName={strExportName} onNearEnd={objShown.truncated && (objShown.cursor || (boolRerunOnScroll && boolCanRerun)) ? () => { void fetchMore(intMaxRows, boolRerunOnScroll && !refRerunFailed.current); } : undefined} objEdit={objGridEdit} hsRows={hsRows} onRows={setHsRows} onSelectRow={setIntCurrent} objReveal={objReveal}
              objCommand={objCommand} boolNoExport onBlock={setObjBlock}
              onSelectCell={(intRow, intCol) => setObjCell({ row: intRow, col: intCol })} />
          )}
          {strView === 'text' && <TextView objResult={objGrid} arrRows={arrTextRows} />}
          {strView === 'record' && <RecordView objResult={objGrid} arrRows={arrRecordRows} />}
        </div>
        {boolValuePanel && (
          <aside className="flex w-80 shrink-0 flex-col border-l border-line" aria-label="Cell value">
            <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-bg px-2 text-xs">
              <span className="truncate font-semibold" title={objCellColumn?.name}>{objCellColumn?.name ?? 'Value'}</span>
              <span className="truncate text-muted">{objCellColumn?.dataType}</span>
              {strCellValue !== null && <span className="ml-auto shrink-0 text-muted">{strCellValue.length.toLocaleString()} chars</span>}
              <button type="button" className={`btn h-5 shrink-0 px-1.5 ${strCellValue === null ? 'ml-auto' : ''}`} disabled={strCellValue === null}
                onClick={() => { if (strCellValue !== null) navigator.clipboard.writeText(strCellValue); }}>Copy</button>
              <button type="button" className="icon-btn icon-btn-sm shrink-0" aria-label="Close the value panel" onClick={() => setBoolValuePanel(false)}>✕</button>
            </div>
            {!objCell
              ? <p className="p-3 text-xs text-muted">Click a cell to see its whole value here.</p>
              : strCellValue === null
                ? <p className="p-3 text-xs italic text-muted">NULL</p>
                : <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-xs" style={{ userSelect: 'text' }}>{strCellValue}</pre>}
          </aside>
        )}
      </div>

      {objNote && (
        <div className={`flex max-h-40 shrink-0 items-start gap-2 overflow-auto border-t border-line px-3 py-1.5 text-xs ${objNote.error ? 'text-danger' : 'text-muted'}`}>
          <p className="min-w-0 flex-1 whitespace-pre-wrap font-mono" style={{ userSelect: 'text' }}>{objNote.text}</p>
          <button type="button" className="icon-btn icon-btn-sm shrink-0" aria-label="Dismiss" onClick={() => setObjNote(null)}>✕</button>
        </div>
      )}

      {/* bottom bar */}
      <div className="flex h-8 shrink-0 items-center gap-1 overflow-hidden border-t border-line bg-bg px-1.5 text-xs">
        {boolSelect && (
          <>
            <button className="btn h-6 px-2" onClick={refresh} disabled={boolBusy} title="Run the statement again and show its rows">
              <IconRefresh intSize={13} /> Refresh
            </button>
            <span className="toolbar-sep" />
          </>
        )}
        <button className={`btn h-6 px-2 ${intPending > 0 ? 'btn-primary' : ''}`} onClick={() => apply(arrStatements)} disabled={arrStatements.length === 0 || boolBusy}
          title={arrStatements.length === 0 ? 'Save the pending changes'
            // The statements are only in this tooltip: the panel that listed them took too much room.
            : `Runs ${plural(arrStatements.length, 'statement')} on ${objConnection.name}${strSessionId && !boolAutoCommit ? ' (in the tab\'s transaction)' : objConnection.kind === 'MongoDb' ? ', one after the other' : ' in one transaction'}:\n\n${
              arrStatements.slice(0, 15).map(objUpdate => `${objUpdate.sql.length > 300 ? `${objUpdate.sql.slice(0, 300)}…` : objUpdate.sql};`).join('\n')}${arrStatements.length > 15 ? '\n…' : ''}`}>
          <IconSave intSize={13} /> Save
        </button>
        <button className="btn h-6 px-2" onClick={cancel} disabled={intPending === 0 || boolBusy} title="Drop every change that is not saved">
          <IconUndo intSize={13} /> Cancel
        </button>
        <span className="toolbar-sep" />
        <button type="button" className="icon-btn icon-btn-sm" onClick={() => setObjCommand({ name: 'edit' })} disabled={!boolCanRows || strView !== 'grid'}
          aria-label="Edit cell" title="Edit the selected cell (Enter, F2 or double-click)">
          <IconPencil intSize={14} />
        </button>
        <button type="button" className="icon-btn icon-btn-sm" onClick={addRow} disabled={!boolCanRows} aria-label="Add row" title="Add an empty row (inserted on Save)">
          <IconPlus intSize={14} />
        </button>
        <button type="button" className="icon-btn icon-btn-sm" onClick={duplicateRows} disabled={!boolCanRows || arrPicked.length === 0}
          aria-label="Duplicate rows" title="Duplicate the selected rows as new rows (inserted on Save)">
          <IconDuplicate intSize={14} />
        </button>
        <button type="button" className="icon-btn icon-btn-sm" onClick={deleteRows} disabled={!boolCanRows || arrPicked.length === 0}
          aria-label="Delete rows" title="Mark the selected rows for deletion (deleted on Save; again to unmark)">
          <IconTrash intSize={14} />
        </button>
        <span className="toolbar-sep" />
        {([['first', 'First row', IconFirst], ['prev', 'Previous row', IconPrev], ['next', 'Next row', IconNext], ['last', 'Last row', IconLast]] as const).map(([strName, strLabel, Icon]) => (
          <button key={strName} type="button" className="icon-btn icon-btn-sm" onClick={() => setObjCommand({ name: strName })}
            disabled={strView !== 'grid' || objGrid.rows.length === 0} aria-label={strLabel} title={strLabel}>
            <Icon intSize={14} />
          </button>
        ))}
        <span className="toolbar-sep" />
        <div className="relative shrink-0" onBlur={objEvent => { if (!objEvent.currentTarget.contains(objEvent.relatedTarget)) setBoolExportMenu(false); }}>
          <button ref={refExportButton} data-export-menu className="btn h-6 px-2" aria-haspopup="menu" aria-expanded={boolExportMenu} disabled={strView !== 'grid' || objGrid.columns.length === 0}
            onClick={() => setBoolExportMenu(boolPrev => !boolPrev)} title="Export the rows shown in the grid (after filter and sort)">
            <IconDownload intSize={13} /> Export data
          </button>
          <button className={`btn ml-1 h-6 px-2 ${boolValuePanel ? 'text-accent' : ''}`} aria-pressed={boolValuePanel} disabled={strView !== 'grid'}
            onClick={() => setBoolValuePanel(boolPrev => !boolPrev)} title="Show the whole value of the current cell in a side panel (long text, JSON)">
            Value
          </button>
          {objShown.truncated && (objShown.cursor || boolCanRerun) && (
            <button className="btn ml-1 h-6 px-2" onClick={() => fetchMore(FETCH_MANY_ROWS, true)} disabled={boolBusy || boolFetching || arrNew.length > 0}
              title={arrNew.length > 0 ? 'Save or cancel the new rows first: they sit below the loaded ones'
                : objShown.cursor ? `Reads the next ${FETCH_MANY_ROWS.toLocaleString()} rows. Scrolling to the end reads the next ${intMaxRows.toLocaleString()}; the statement is not run again.`
                : `The result is no longer open on the server: runs the statement again and reads on from row ${(objShown.rows.length + 1).toLocaleString()} (next ${FETCH_MANY_ROWS.toLocaleString()} rows). After that, scrolling reads on.`}>
              {boolFetching ? 'Reading…' : 'More rows'}
            </button>
          )}
          {boolSelect && objShown.truncated && !objShown.cursor && !boolCanRerun && intLimit < MAX_SERVER_ROWS && (
            <button className="btn ml-1 h-6 px-2" onClick={loadMore} disabled={boolBusy}
              title={`The result stopped at ${objShown.rows.length.toLocaleString()} rows. Runs the statement again for ${Math.min(Math.max(objShown.rows.length, intLimit) * 5, MAX_SERVER_ROWS).toLocaleString()}.`}>
              More rows
            </button>
          )}
          {boolExportMenu && objExportBox && (
            <div role="menu" data-export-menu className="fixed z-50 min-w-44 rounded border border-line bg-panel py-1 text-xs shadow-lg"
              style={{ left: objExportBox.left, bottom: window.innerHeight - objExportBox.top + 4 }}>
              <button type="button" role="menuitem" className="block w-full whitespace-nowrap px-3 py-1 text-left hover:bg-hover"
                onClick={() => { setBoolExportMenu(false); setObjCommand({ name: 'xlsx' }); }}>Export to Excel (.xlsx)</button>
              <button type="button" role="menuitem" className="block w-full whitespace-nowrap px-3 py-1 text-left hover:bg-hover"
                onClick={() => { setBoolExportMenu(false); setObjCommand({ name: 'csv' }); }}>Export to CSV</button>
            </div>
          )}
        </div>
        <span className="toolbar-sep" />
        {objEdit.status === 'on' && (
          <label className="flex shrink-0 items-center gap-1.5 text-muted">
            Table
            <select className="field h-6 max-w-72 py-0 font-mono text-xs" value={objTarget?.key ?? ''} disabled={boolBusy}
              onChange={objEvent => pickTarget(objEvent.target.value)} aria-label="Table to edit"
              title="The table being edited: its columns stay bright, the others are dimmed">
              {arrTargets.some(objItem => !objItem.reason)
                ? (arrTargets.length > 1 || !objTarget) && <option value="">Read-only</option>
                : <option value="">(none can be edited)</option>}
              {arrTargets.map(objItem => (
                <option key={objItem.key} value={objItem.key} disabled={!!objItem.reason} title={objItem.reason}>
                  {objItem.label}{objItem.reason ? ` (${objItem.reason})` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="min-w-0 flex-1 truncate px-1 text-muted" title={strStatus}>{strStatus}</span>
        <div className="flex shrink-0 items-center gap-2 pr-1">
          {arrSummary.length > 0 && <span className="font-semibold text-env-amber">{arrSummary.join(' · ')}</span>}
          {strSummary && <span className="text-fg" title="The selected cells">{strSummary}</span>}
          {arrPicked.length > 1 && <span className="text-muted">{arrPicked.length.toLocaleString()} selected</span>}
          <span className="text-muted" title={objShown.cursor ? 'More rows are waiting on the server: scroll to the end' : objShown.truncated ? 'There are more rows' : undefined}>
            {plural(intBase, 'row')}{objShown.truncated ? '+' : ''}
          </span>
        </div>
      </div>
    </div>
  );
}
