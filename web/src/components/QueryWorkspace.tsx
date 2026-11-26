import { useCallback, useEffect, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import { monaco } from '../monaco';
import { api, ApiError } from '../api';
import { showToast } from '../toast';
import { metadataFor, registerSqlCompletion, schemaLoaderFor } from '../sql/completion';
import { dialectOf, editorLanguage, hasTransactions, isSqlKind } from '../sql/dialect';
import { registerRedisCompletion } from '../sql/redisCompletion';
import { foldByStatement, registerSqlFolding } from '../sql/folding';
import { registerMongoCompletion } from '../sql/mongoCompletion';
import { objectAt, registerSqlHover, routinesFor } from '../sql/hover';
import { formatSql, isUnfilteredWrite } from '../sql/format';
import { splitStatements, statementAt } from '../sql/statements';
import type { Connection, DbObjectInfo, QueryError, QueryResult, SchemaMetadata } from '../types';
import { KIND_LABEL } from '../types';
import { envVar } from '../envColor';
import { CodeView } from './CodeView';
import { ResultGrid } from './ResultGrid';
import { EditableResult } from './EditableResult';
import { KindIcon, IconCheck, IconChevronDown, IconChevronUp, IconClose, IconComment, IconFormat, IconPlay, IconPlayAll, IconPlug, IconRedo, IconRefresh, IconStop, IconUndo, IconUnplug } from './icons';

registerSqlCompletion(monaco);
registerSqlFolding(monaco);
registerMongoCompletion(monaco);
registerRedisCompletion(monaco);
registerSqlHover(monaco);

export const FORMAT_ACTION = 'dbstudio.formatSql';

interface Props {
  strTabId: string;
  objConnection: Connection;
  /** Every saved connection, for the toolbar's connection box. */
  arrConnections: Connection[];
  /** The tab moves to another connection: the app remounts this editor with the same text. */
  onChangeConnection: (strTabId: string, strConnectionId: string) => void;
  boolActive: boolean;
  objMetadata: SchemaMetadata | undefined;
  loadMetadata: (strId: string, boolRefresh?: boolean, strSchema?: string) => Promise<SchemaMetadata>;
  /** F12 on a table / routine name: opens its object tab. */
  onOpenObject?: (objObject: DbObjectInfo) => void;
  /** Lets the app warn before closing a tab that has uncommitted work. */
  onTransactionChange: (strTabId: string, boolOpen: boolean) => void;
  /** Gives the app menu a way to drive this editor; null when the tab closes. */
  onHandle?: (strTabId: string, objHandle: EditorHandle | null) => void;
  /** The text was edited. */
  onContentChange?: (strTabId: string) => void;
  /** Editor text for a tab opened from the object explorer; boolAutoRun runs it once. */
  strInitialSql?: string;
  boolAutoRun?: boolean;
  /** A tab restored from the last run: no session until Connect or the first statement. */
  boolLazyConnect?: boolean;
  /** Long lines wrap inside the editor (View > Word wrap, Alt+Z); kept in the app settings. */
  boolWordWrap: boolean;
  onToggleWordWrap: () => void;
  /** Raised by the app when the connection is disconnected: this tab closes its session. */
  intDisconnect: number;
  /** The Disconnect button: the app asks about open transactions, then disconnects every tab of the connection. */
  onDisconnect: (strConnectionId: string) => void;
  /** This tab's session changed state; null when the tab goes away. */
  onSessionState: (strTabId: string, strConnectionId: string, strState: SessionState | null) => void;
}

/** What the app menu and its shortcuts can ask of an editor tab. */
export interface EditorHandle {
  getSql: () => string;
  run: (boolAll: boolean) => void;
  stop: () => void;
  commit: () => void;
  rollback: () => void;
  /** Runs a Monaco action by id: undo, redo, actions.find... */
  trigger: (strAction: string) => void;
  /** Puts text at the cursor (replacing the selection), as one undo step. */
  insertText: (strText: string) => void;
  /** Inserts a snippet body ($1, ${1:name}) and starts its tab stops. */
  insertSnippet: (strBody: string) => void;
}

/** Outcome of one statement: a result or an error. */
interface StatementRun { sql: string; result?: QueryResult; error?: QueryError }

type RunState =
  | { status: 'idle' }
  | { status: 'running'; queryId: string; startedAt: number; index: number; total: number }
  | { status: 'done'; skipped: number };

export type SessionState = 'closed' | 'opening' | 'open' | 'failed';

const SESSION_LABEL: Record<SessionState, string> = {
  closed: 'Disconnected', opening: 'Connecting…', open: 'Connected', failed: 'Connection failed',
};

const MAX_ROWS = [100, 1000, 10000, 100000];
/** How often the grid redraws while rows are still arriving. */
const LIVE_REFRESH_MS = 200;
const MARKER_OWNER = 'dbstudio';

const toQueryError = (objEx: unknown): QueryError =>
  objEx instanceof ApiError ? objEx.detail : { message: (objEx as Error).message };

const runLabel = ({ result: objResult, error: objError }: StatementRun) => {
  if (objError || !objResult) return 'Error';
  if (objResult.columns.length > 0) return `${objResult.rows.length.toLocaleString()} rows`;
  return objResult.recordsAffected >= 0 ? `${objResult.recordsAffected.toLocaleString()} affected` : 'Done';
};

export function QueryWorkspace({
  strTabId, objConnection, arrConnections, onChangeConnection, boolActive, objMetadata, loadMetadata, onTransactionChange, onHandle, onContentChange, strInitialSql, boolAutoRun, boolLazyConnect, boolWordWrap, onToggleWordWrap, intDisconnect, onDisconnect, onSessionState, onOpenObject,
}: Props) {
  const refOnSessionState = useRef(onSessionState);
  refOnSessionState.current = onSessionState;
  const refOnToggleWordWrap = useRef(onToggleWordWrap);
  refOnToggleWordWrap.current = onToggleWordWrap;
  const refOnOpenObject = useRef(onOpenObject);
  refOnOpenObject.current = onOpenObject;
  const refLoadMetadata = useRef(loadMetadata);
  refLoadMetadata.current = loadMetadata;
  const refOnContentChange = useRef(onContentChange);
  refOnContentChange.current = onContentChange;
  const refAutoRan = useRef(false);
  const refHost = useRef<HTMLDivElement>(null);
  const refEditor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const refMetadata = useRef(objMetadata);
  refMetadata.current = objMetadata;
  const refRun = useRef<(boolAll: boolean) => void>(() => {});

  const [objRun, setObjRun] = useState<RunState>({ status: 'idle' });
  const [arrRuns, setArrRuns] = useState<StatementRun[]>([]);
  const [intActiveRun, setIntActiveRun] = useState(0);
  // MongoDB and Redis have their own statement syntax: no SQL formatter, no WHERE check.
  const boolSql = isSqlKind(objConnection.kind);
  const boolTransactions = hasTransactions(objConnection.kind);
  // Document results: grid, or the documents as JSON.
  const [boolJson, setBoolJson] = useState(false);
  // Rows of the running statement, shown while more are still being read.
  const [objLive, setObjLive] = useState<QueryResult | null>(null);
  const [intMaxRows, setIntMaxRows] = useState(1000);
  const [intEditorHeight, setIntEditorHeight] = useState(280);
  // Which of the two panes are shown: the arrows on the splitter give one of them the whole tab.
  const [strPane, setStrPane] = useState<'both' | 'editor' | 'results'>('both');
  const [strMetaState, setStrMetaState] = useState<'idle' | 'loading' | string>('idle');
  const [lngNow, setLngNow] = useState(Date.now());
  // One DB session per tab: keeps the transaction and session settings between runs.
  const [strSessionId] = useState(() => crypto.randomUUID());
  const [boolAutoCommit, setBoolAutoCommit] = useState(true);
  const [boolTxOpen, setBoolTxOpen] = useState(false);
  const [strSession, setStrSession] = useState<SessionState>('closed');
  const refOpening = useRef<Promise<void> | null>(null);
  const refCursor = useRef<HTMLSpanElement>(null);
  const [boolCanUndo, setBoolCanUndo] = useState(false);
  const [boolCanRedo, setBoolCanRedo] = useState(false);

  const showError = (strSql: string, objEx: unknown) => {
    setArrRuns([{ sql: strSql, error: toQueryError(objEx) }]);
    setIntActiveRun(0);
    setObjRun({ status: 'done', skipped: 0 });
  };

  /** Opens the tab's DB session now, so a bad connection shows before the first query. */
  const connect = () => {
    setStrSession('opening');
    const objOpening: Promise<void> = api.openSession(strSessionId, objConnection.id).then(
      () => { if (refOpening.current === objOpening) setStrSession('open'); },
      objEx => {
        if (refOpening.current !== objOpening) return; // a newer attempt owns the state
        setStrSession('failed');
        showError('CONNECT', objEx);
        showToast('error', `${objConnection.name}: connection failed`, toQueryError(objEx).message);
      },
    );
    refOpening.current = objOpening;
  };

  // Disconnect is for the whole connection: the app raises intDisconnect and every tab of it closes its session.
  const refDisconnect = useRef(intDisconnect);
  useEffect(() => {
    if (intDisconnect === refDisconnect.current) return;
    refDisconnect.current = intDisconnect;
    refOpening.current = null;
    api.closeSession(strSessionId).catch(() => {});
    setStrSession('closed');
    setBoolTxOpen(false);
  }, [intDisconnect, strSessionId]);

  // The sidebar shows one state per connection, made of its tabs' sessions: tell the app every change, and the end.
  useEffect(() => {
    refOnSessionState.current(strTabId, objConnection.id, strSession);
  }, [strTabId, objConnection.id, strSession]);
  useEffect(() => () => refOnSessionState.current(strTabId, objConnection.id, null), [strTabId, objConnection.id]);

  // Connects when the tab opens (an auto-run tab connects with its first statement) and closes with it.
  useEffect(() => {
    if (!boolAutoRun && !boolLazyConnect) connect();
    return () => { api.closeSession(strSessionId).catch(() => {}); };
  }, [strSessionId]);

  useEffect(() => {
    onTransactionChange(strTabId, boolTxOpen);
    return () => onTransactionChange(strTabId, false);
  }, [strTabId, boolTxOpen, onTransactionChange]);

  // ---- editor ----
  useEffect(() => {
    const objModel = monaco.editor.createModel(
      strInitialSql ?? (objConnection.kind === 'Oracle'
        ? 'SELECT * FROM dual'
        : objConnection.kind === 'MongoDb' ? 'db.getCollectionNames()' : objConnection.kind === 'Redis' ? 'PING' : 'SELECT now();'),
      editorLanguage(objConnection.kind),
    );
    foldByStatement(objModel);
    const objEditor = monaco.editor.create(refHost.current!, {
      model: objModel,
      automaticLayout: true,
      showFoldingControls: 'always',
      minimap: { enabled: false },
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 20,
      tabSize: 2,
      scrollBeyondLastLine: false,
      wordBasedSuggestions: 'off',
      suggest: { showWords: false },
      quickSuggestions: { other: true, comments: false, strings: false },
      fixedOverflowWidgets: true,
      renderLineHighlight: 'line',
      padding: { top: 8 },
      // Alt + drag selects a column block (dbForge / Visual Studio); Ctrl + click adds a cursor.
      multiCursorModifier: 'ctrlCmd',
      wordWrap: boolWordWrap ? 'on' : 'off',
      wrappingIndent: 'same',
    });
    // Alt + click adds a cursor where it lands (Alt + drag stays the column block). Monaco moves the only cursor there
    // on the press, so the cursors are remembered just before it (capture phase) and put back on the release.
    let objAltPress: { x: number; y: number; selections: Monaco.Selection[] } | null = null;
    const onAltPress = (objEvent: PointerEvent) => {
      objAltPress = objEvent.altKey && !objEvent.ctrlKey && !objEvent.shiftKey && !objEvent.metaKey && objEvent.button === 0
        ? { x: objEvent.pageX, y: objEvent.pageY, selections: objEditor.getSelections() ?? [] }
        : null;
    };
    const elHost = refHost.current!;
    elHost.addEventListener('pointerdown', onAltPress, true);
    objEditor.onMouseUp(objEvent => {
      const objPress = objAltPress;
      objAltPress = null;
      const objAt = objEvent.target.position;
      if (!objPress || !objAt || objEvent.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT &&
        objEvent.target.type !== monaco.editor.MouseTargetType.CONTENT_EMPTY) return;
      // Moved while pressed: that was a column block, leave it alone.
      if (Math.abs(objEvent.event.posx - objPress.x) > 3 || Math.abs(objEvent.event.posy - objPress.y) > 3) return;
      // A second Alt + click on a cursor takes it away again (never the last one).
      const arrKept = objPress.selections.filter(objItem => !(objItem.isEmpty() && objItem.getPosition().equals(objAt)));
      if (arrKept.length === 0) return;
      const boolRemove = arrKept.length < objPress.selections.length;
      objEditor.setSelections(boolRemove ? arrKept : [...arrKept, new monaco.Selection(objAt.lineNumber, objAt.column, objAt.lineNumber, objAt.column)]);
    });
    // Alt+Z is Monaco's own toggle, but for one editor only: here it switches every tab and is remembered.
    objEditor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyZ, () => refOnToggleWordWrap.current());
    objEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => refRun.current(false));
    objEditor.addCommand(monaco.KeyCode.F5, () => refRun.current(true));
    // Formats the selection, or the whole editor. One edit, so one Ctrl+Z brings the text back.
    objEditor.addAction({
      id: FORMAT_ACTION,
      label: 'Format SQL',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF],
      contextMenuGroupId: '1_modification',
      run: () => {
        const objSelection = objEditor.getSelection();
        const objRange = objSelection && !objSelection.isEmpty() ? objSelection : objModel.getFullModelRange();
        const strBefore = objModel.getValueInRange(objRange);
        if (!isSqlKind(objConnection.kind)) return; // the formatter only knows SQL
        const strAfter = formatSql(strBefore, dialectOf(objConnection.kind));
        if (strAfter === strBefore) return;
        objEditor.pushUndoStop();
        objEditor.executeEdits('format', [{ range: objRange, text: strAfter }]);
        objEditor.pushUndoStop();
      },
    });
    const goToObject = async (objPosition: monaco.Position | null) => {
      if (!objPosition) return;
      let objFound = objectAt(objModel, objPosition);
      if (objFound && 'loadSchema' in objFound) {
        await refLoadMetadata.current(objConnection.id, false, objFound.loadSchema).catch(() => {});
        objFound = objectAt(objModel, objPosition);
      }
      if (objFound && !('loadSchema' in objFound)) {
        objEditor.setPosition(objPosition); // drops the cursor Ctrl + click just added
        refOnOpenObject.current?.(objFound);
      }
    };
    // F12 (and the right-click menu): the table, view or routine under the cursor opens in its own tab.
    objEditor.addAction({
      id: 'dbstudio.goToObject',
      label: 'Go to object',
      keybindings: [monaco.KeyCode.F12],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1,
      run: () => { void goToObject(objEditor.getPosition()); },
    });
    // With Ctrl held, a name that can be opened is underlined and takes the hand cursor, like a link.
    const objLink = objEditor.createDecorationsCollection();
    let strLinkAt = '';
    const clearLink = () => { if (strLinkAt) { strLinkAt = ''; objLink.clear(); } };
    objEditor.onMouseMove(objEvent => {
      const objPosition = objEvent.target.position;
      const objWord = objPosition && objEvent.event.ctrlKey && objEvent.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT
        ? objModel.getWordAtPosition(objPosition) : null;
      if (!objPosition || !objWord) return clearLink();
      const strAt = `${objPosition.lineNumber}:${objWord.startColumn}:${objWord.word}`;
      if (strAt === strLinkAt) return;
      clearLink();
      if (!objectAt(objModel, objPosition)) return;
      strLinkAt = strAt;
      objLink.set([{
        range: new monaco.Range(objPosition.lineNumber, objWord.startColumn, objPosition.lineNumber, objWord.endColumn),
        options: { inlineClassName: 'dbstudio-link' },
      }]);
    });
    objEditor.onMouseLeave(clearLink);
    objEditor.onKeyUp(objEvent => { if (objEvent.keyCode === monaco.KeyCode.Ctrl) clearLink(); });
    objModel.onDidChangeContent(clearLink);
    // Ctrl + click on a name does the same.
    objEditor.onMouseDown(objEvent => {
      if (objEvent.event.ctrlKey && objEvent.event.leftButton && objEvent.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT)
        void goToObject(objEvent.target.position);
    });
    // Written straight to the DOM: a cursor move must not re-render the result grid.
    const showCursor = () => {
      const objPosition = objEditor.getPosition();
      if (refCursor.current && objPosition)
        refCursor.current.textContent = `Ln ${objPosition.lineNumber}, Col ${objPosition.column}`;
    };
    objEditor.onDidChangeCursorPosition(showCursor);
    objModel.onDidChangeContent(() => refOnContentChange.current?.(strTabId));
    // Undo / Redo buttons go dim when there is nothing to step to. Same value = no re-render, so typing stays cheap.
    const showHistory = () => { setBoolCanUndo(objModel.canUndo()); setBoolCanRedo(objModel.canRedo()); };
    objModel.onDidChangeContent(showHistory);
    showHistory();
    // Suggestions follow every edit. Monaco alone opens them only for a character typed at the end of a word: not after
    // Backspace, not inside a word. So whenever the text changes and the list is closed, ask again (quietly: no
    // "No suggestions" box).
    let intSuggestTimer: number | undefined;
    objModel.onDidChangeContent(objEvent => {
      clearTimeout(intSuggestTimer);
      if (objEvent.isFlush || objEvent.isUndoing || objEvent.isRedoing || !objEditor.hasTextFocus()) return;
      // One typed character or a deletion only: a pasted text or an accepted suggestion must not reopen the list.
      if (objEvent.changes.some(objChange => objChange.text.length > 1)) return;
      intSuggestTimer = window.setTimeout(() => {
        const arrSelections = objEditor.getSelections();
        const objPosition = objEditor.getPosition();
        if (!objPosition || arrSelections?.length !== 1 || !arrSelections[0].isEmpty()) return;
        // Right after a name or a dot; nothing to offer after a blank or a bracket.
        if (!/[\w$#.]$/.test(objModel.getLineContent(objPosition.lineNumber).slice(0, objPosition.column - 1))) return;
        const objSuggest = objEditor.getContribution('editor.contrib.suggestController') as { model?: { state?: number } } | null;
        if (objSuggest?.model?.state) return; // already open: Monaco filters it itself
        objEditor.trigger('dbstudio', 'editor.action.triggerSuggest', { auto: true });
      }, 120);
    });
    showCursor();
    refEditor.current = objEditor;
    if (boolAutoRun && !refAutoRan.current) {
      refAutoRan.current = true;
      setTimeout(() => refRun.current(true), 0); // after the editor is in place
    }
    const fnUnregister = metadataFor(objModel, () => refMetadata.current);
    const fnForgetLoader = schemaLoaderFor(objModel, strSchema => refLoadMetadata.current(objConnection.id, false, strSchema));
    const fnForgetRoutines = routinesFor(objModel, objRoutine => api.routineInfo(objConnection.id, objRoutine));
    return () => {
      fnUnregister();
      fnForgetRoutines();
      fnForgetLoader();
      elHost.removeEventListener('pointerdown', onAltPress, true);
      objEditor.dispose();
      objModel.dispose();
    };
  }, [objConnection.kind]);

  useEffect(() => {
    if (boolActive) refEditor.current?.focus();
  }, [boolActive]);

  useEffect(() => {
    refEditor.current?.updateOptions({ wordWrap: boolWordWrap ? 'on' : 'off' });
  }, [boolWordWrap]);

  // ---- metadata (loaded once per connection, refreshed on demand) ----
  const fetchMeta = useCallback(async (boolRefresh: boolean) => {
    setStrMetaState('loading');
    try {
      await loadMetadata(objConnection.id, boolRefresh);
      setStrMetaState('idle');
    } catch (objEx) {
      setStrMetaState(objEx instanceof ApiError ? objEx.detail.message : (objEx as Error).message);
    }
  }, [objConnection.id, loadMetadata]);

  useEffect(() => {
    // Not while disconnected: loading the schema would connect again behind the user's back.
    if (boolActive && !objMetadata && strMetaState === 'idle' && strSession !== 'closed') fetchMeta(false);
  }, [boolActive, objMetadata, strMetaState, fetchMeta, strSession]);

  // ---- running ----
  useEffect(() => {
    if (objRun.status !== 'running') return;
    const intTimer = setInterval(() => setLngNow(Date.now()), 100);
    return () => clearInterval(intTimer);
  }, [objRun.status]);

  /**
   * Runs the statements of the selection if there is one; otherwise the statement under
   * the cursor, or every statement in the editor with boolAll. One request per statement,
   * in order, stopping at the first error.
   */
  const execute = async (boolAll: boolean) => {
    const objEditor = refEditor.current;
    const objModel = objEditor?.getModel();
    if (!objEditor || !objModel || objRun.status === 'running') return;

    const objSelection = objEditor.getSelection();
    const boolUseSelection = !!objSelection && !objSelection.isEmpty();
    const strSource = boolUseSelection ? objModel.getValueInRange(objSelection) : objModel.getValue();
    const intSourceOffset = boolUseSelection ? objModel.getOffsetAt(objSelection.getStartPosition()) : 0;

    let arrStatements = splitStatements(strSource, dialectOf(objConnection.kind));
    if (!boolUseSelection && !boolAll) {
      const objPosition = objEditor.getPosition();
      const objStatement = statementAt(arrStatements, strSource, objPosition ? objModel.getOffsetAt(objPosition) : 0);
      arrStatements = objStatement ? [objStatement] : [];
    }
    if (arrStatements.length === 0) return;

    // Red = production: an UPDATE / DELETE without WHERE asks first.
    const strDialect = dialectOf(objConnection.kind);
    const arrUnfiltered = objConnection.color === 'red' && boolSql
      ? arrStatements.filter(objStatement => isUnfilteredWrite(objStatement.text, strDialect))
      : [];
    if (arrUnfiltered.length > 0) {
      const strList = arrUnfiltered.slice(0, 3).map(objStatement => objStatement.text.replace(/\s+/g, ' ').slice(0, 160)).join('\n\n');
      const strMore = arrUnfiltered.length > 3 ? `\n\n…and ${arrUnfiltered.length - 3} more` : '';
      if (!confirm(`"${objConnection.name}" is marked as production (red).\n\nNo WHERE clause, every row is affected:\n\n${strList}${strMore}\n\nRun anyway?`)) {
        objEditor.focus();
        return;
      }
    }

    // A run shows its result: hidden results come back.
    setStrPane(strPrev => (strPrev === 'editor' ? 'both' : strPrev));
    monaco.editor.setModelMarkers(objModel, MARKER_OWNER, []);
    const lngStartedAt = Date.now();
    setLngNow(lngStartedAt);

    const arrDone: StatementRun[] = [];
    let intRan = 0; // arrDone can hold several entries per statement
    for (const [intIndex, objStatement] of arrStatements.entries()) {
      intRan = intIndex + 1;
      const strQueryId = crypto.randomUUID();
      setObjRun({ status: 'running', queryId: strQueryId, startedAt: lngStartedAt, index: intIndex, total: arrStatements.length });
      await refOpening.current; // a session connects one call at a time
      const lngStatementAt = Date.now();
      let lngShownAt = 0;
      setObjLive(null);
      try {
        const objResult = await api.queryStream(strQueryId, objConnection.id, objStatement.text, intMaxRows, strSessionId, boolAutoCommit,
          objPartial => {
            // The rows array grows in place: hand React a copy, a few times a second at most.
            if (Date.now() - lngShownAt < LIVE_REFRESH_MS) return;
            lngShownAt = Date.now();
            setObjLive({ ...objPartial, rows: objPartial.rows.slice() });
          });
        api.addHistory(objConnection.id, objStatement.text, objResult.elapsedMs,
          objResult.columns.length > 0 ? objResult.rows.length : objResult.recordsAffected >= 0 ? objResult.recordsAffected : null,
          null).catch(() => {});
        arrDone.push({ sql: objStatement.text, result: objResult });
        for (const objMore of objResult.more ?? []) arrDone.push({ sql: objStatement.text, result: objMore }); // one tab per cursor
      } catch (objEx) {
        const objError = toQueryError(objEx);
        api.addHistory(objConnection.id, objStatement.text, Date.now() - lngStatementAt, null, objError.message).catch(() => {});
        arrDone.push({ sql: objStatement.text, error: objError });
        if (objError.position) {
          const objStart = objModel.getPositionAt(intSourceOffset + objStatement.start + objError.position - 1);
          const objWord = objModel.getWordAtPosition(objStart);
          monaco.editor.setModelMarkers(objModel, MARKER_OWNER, [{
            severity: monaco.MarkerSeverity.Error,
            message: objError.message,
            startLineNumber: objStart.lineNumber,
            startColumn: objStart.column,
            endLineNumber: objStart.lineNumber,
            endColumn: objWord ? objWord.endColumn : objStart.column + 1,
          }]);
        }
        break;
      }
    }

    if (arrDone.some(objItem => objItem.result)) setStrSession('open'); // the first statement connects a closed tab
    // A MongoDB standalone has no transactions: nothing was opened, go back to auto-commit.
    if (arrDone.some(objItem => objItem.error?.code === 'TransactionsUnavailable')) setBoolAutoCommit(true);
    else if (!boolAutoCommit) setBoolTxOpen(true); // also after an error: the transaction stays open
    // Show the failed statement, else the last one that returned rows.
    const intLast = arrDone.length - 1;
    const intLastGrid = arrDone.map(objItem => (objItem.result?.columns.length ?? 0) > 0).lastIndexOf(true);
    setObjLive(null);
    setArrRuns(arrDone);
    setIntActiveRun(arrDone[intLast].error || intLastGrid < 0 ? intLast : intLastGrid);
    setObjRun({ status: 'done', skipped: arrStatements.length - intRan });
  };
  refRun.current = execute;

  const stop = () => {
    if (objRun.status === 'running') api.cancel(objRun.queryId).catch(() => {});
  };

  const endTransaction = async (boolCommit: boolean) => {
    try {
      await (boolCommit ? api.commit(strSessionId) : api.rollback(strSessionId));
      setBoolTxOpen(false);
    } catch (objEx) {
      showError(boolCommit ? 'COMMIT' : 'ROLLBACK', objEx);
    }
  };

  const changeConnection = (strConnectionId: string) => {
    if (strConnectionId === objConnection.id) return;
    if (boolTxOpen && !confirm('This tab has an uncommitted transaction. Changing the connection rolls it back.\n\nChange anyway?')) return;
    onChangeConnection(strTabId, strConnectionId);
  };

  const format = () => {
    refEditor.current?.focus();
    refEditor.current?.trigger('toolbar', FORMAT_ACTION, null);
  };

  const undoRedo = (strAction: 'undo' | 'redo') => {
    refEditor.current?.trigger('toolbar', strAction, null);
    refEditor.current?.focus();
  };

  const toggleComment = () => {
    refEditor.current?.trigger('toolbar', 'editor.action.commentLine', null);
    refEditor.current?.focus();
  };

  // The app menu holds one stable handle per tab; it always reaches this render's functions.
  const refActions = useRef<EditorHandle>(null!);
  refActions.current = {
    getSql: () => refEditor.current?.getValue() ?? '',
    run: execute,
    stop,
    commit: () => { endTransaction(true); },
    rollback: () => { endTransaction(false); },
    trigger: strAction => { refEditor.current?.focus(); refEditor.current?.trigger('menu', strAction, null); },
    insertText: strText => {
      const objEditor = refEditor.current;
      const objSelection = objEditor?.getSelection();
      if (!objEditor || !objSelection) return;
      objEditor.pushUndoStop();
      objEditor.executeEdits('history', [{ range: objSelection, text: strText, forceMoveMarkers: true }]);
      objEditor.pushUndoStop();
      objEditor.focus();
    },
    insertSnippet: strBody => {
      const objEditor = refEditor.current;
      if (!objEditor) return;
      objEditor.focus();
      // Monaco's own snippet engine; it has no typed entry in the public API.
      (objEditor.getContribution('snippetController2') as { insert(strTemplate: string): void } | null)?.insert(strBody);
    },
  };
  useEffect(() => {
    onHandle?.(strTabId, {
      getSql: () => refActions.current.getSql(),
      run: boolAll => refActions.current.run(boolAll),
      stop: () => refActions.current.stop(),
      commit: () => refActions.current.commit(),
      rollback: () => refActions.current.rollback(),
      trigger: strAction => refActions.current.trigger(strAction),
      insertText: strText => refActions.current.insertText(strText),
      insertSnippet: strBody => refActions.current.insertSnippet(strBody),
    });
    return () => onHandle?.(strTabId, null);
  }, [strTabId, onHandle]);

  // ---- splitter between editor and results ----
  const startResize = (objEvent: React.PointerEvent) => {
    const intStartY = objEvent.clientY;
    const intStartHeight = intEditorHeight;
    const move = (objMoveEvent: PointerEvent) =>
      setIntEditorHeight(Math.min(Math.max(intStartHeight + objMoveEvent.clientY - intStartY, 80), window.innerHeight - 160));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const boolRunning = objRun.status === 'running';
  const objActiveRun = objRun.status === 'done' ? arrRuns[intActiveRun] : undefined;
  const objActiveResult = objActiveRun?.result;

  return (
    <section className={`@container absolute inset-0 flex-col bg-panel ${boolActive ? 'flex' : 'hidden'}`}>
      {/* toolbar: labels drop out as the tab gets narrower (container width, the sidebar can be resized); what still does not fit wraps to a second row, nothing is cut off */}
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-1 gap-y-1 border-b border-line px-2 py-1"
        style={{ boxShadow: `inset 3px 0 0 ${envVar(objConnection.color)}` }}>
        {/* run */}
        <button className="btn btn-primary" onClick={() => execute(false)} disabled={boolRunning}
          title="Run the selection, or the statement under the cursor (Ctrl+Enter)">
          <IconPlay intSize={13} /> Run
        </button>
        <button className="icon-btn" onClick={() => execute(true)} disabled={boolRunning} aria-label="Run all"
          title="Run every statement of the selection, or of the whole editor, one by one (F5)">
          <IconPlayAll /> <span className="hidden @6xl:inline">Run all</span>
        </button>
        <button className={`icon-btn ${boolRunning ? 'text-danger' : ''}`} onClick={stop} disabled={!boolRunning}
          aria-label="Stop" title="Stop the running statement">
          <IconStop intSize={14} />
        </button>

        <span className="toolbar-sep" />
        <button className="icon-btn" onClick={() => undoRedo('undo')} disabled={!boolCanUndo} aria-label="Undo" title="Undo (Ctrl+Z)">
          <IconUndo /> <span className="hidden @7xl:inline">Undo</span>
        </button>
        <button className="icon-btn" onClick={() => undoRedo('redo')} disabled={!boolCanRedo} aria-label="Redo" title="Redo (Ctrl+Y)">
          <IconRedo /> <span className="hidden @7xl:inline">Redo</span>
        </button>

        <span className="toolbar-sep" />
        <button className="icon-btn" onClick={toggleComment} title="Comment / uncomment the selected lines (Ctrl+/)">
          <IconComment /> Comment
        </button>
        <button className={`icon-btn ${boolSql ? '' : 'hidden'}`} onClick={format} title="Format the selection, or the whole editor (Ctrl+Shift+F)">
          <IconFormat /> Format
        </button>

        {/* transaction */}
        <div className={boolTransactions ? 'contents' : 'hidden'}>
        <span className="toolbar-sep" />
        <div className="segmented" role="group" aria-label="Transaction mode"
          title="Manual: statements run in one transaction until you commit or roll back">
          <button aria-pressed={boolAutoCommit} disabled={boolRunning || boolTxOpen} onClick={() => setBoolAutoCommit(true)}>
            Auto-commit
          </button>
          <button aria-pressed={!boolAutoCommit} disabled={boolRunning || boolTxOpen} onClick={() => setBoolAutoCommit(false)}>
            Manual
          </button>
        </div>
        {!boolAutoCommit && (
          <>
            <button className={`icon-btn ${boolTxOpen ? 'text-success' : ''}`} onClick={() => endTransaction(true)}
              disabled={boolRunning || !boolTxOpen} title="Commit the transaction">
              <IconCheck /> <span className="hidden @5xl:inline">Commit</span>
            </button>
            <button className="icon-btn" onClick={() => endTransaction(false)} disabled={boolRunning || !boolTxOpen}
              title="Roll back the transaction">
              <IconUndo /> <span className="hidden @5xl:inline">Rollback</span>
            </button>
          </>
        )}

        </div>

        <span className="toolbar-sep" />
        <label className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted" title="Rows fetched per statement">
          <span className="hidden @6xl:inline">Limit</span>
          <select className="field h-[26px] w-auto py-0 text-xs" value={intMaxRows} onChange={objEvent => setIntMaxRows(Number(objEvent.target.value))}>
            {MAX_ROWS.map(intCount => <option key={intCount} value={intCount}>{intCount.toLocaleString()}</option>)}
          </select>
        </label>

        {/* session */}
        <div className="ml-auto flex min-w-[12rem] flex-1 basis-0 items-center justify-end gap-1 pl-2">
          {/* the connection this tab runs on */}
          <label className="flex min-w-0 items-center gap-1.5" title="Connection of this tab. Changing it keeps the text and opens a new session.">
            <span className="shrink-0"><KindIcon strKind={objConnection.kind} intSize={16} /></span>
            {/* the one part of the toolbar that gives way when the tab is narrow */}
            <select className="field h-[26px] w-auto min-w-[4.5rem] max-w-[13rem] shrink py-0 text-xs" aria-label="Connection" value={objConnection.id}
              disabled={boolRunning} onChange={objEvent => changeConnection(objEvent.target.value)}>
              {arrConnections.map(objItem => (
                <option key={objItem.id} value={objItem.id}>{objItem.name} · {KIND_LABEL[objItem.kind]}</option>
              ))}
            </select>
          </label>
          <span className="flex shrink-0 items-center gap-2 whitespace-nowrap px-1.5 text-xs text-muted"
            title={`${SESSION_LABEL[strSession]}: ${KIND_LABEL[objConnection.kind]} ${objConnection.username}@${objConnection.host}/${objConnection.database}`}>
            <span className="status-dot" data-state={strSession} />
            <span className={`hidden @[92rem]:inline ${strSession === 'open' ? 'text-fg' : strSession === 'failed' ? 'text-danger' : ''}`}>
              {SESSION_LABEL[strSession]}
            </span>
            <span className="hidden @[110rem]:inline">{objConnection.username}@{objConnection.host}/{objConnection.database}</span>
          </span>
          {strSession === 'open'
            ? (
              <button className="icon-btn shrink-0" onClick={() => onDisconnect(objConnection.id)} disabled={boolRunning} aria-label="Disconnect"
                title="Disconnect: close every session of this connection">
                <IconUnplug /> <span className="hidden @[92rem]:inline">Disconnect</span>
              </button>
            )
            : (
              <button className="icon-btn shrink-0" onClick={connect} disabled={boolRunning || strSession === 'opening'} aria-label="Connect"
                title="Connect: open this tab's database session">
                <IconPlug /> <span className="hidden @[92rem]:inline">Connect</span>
              </button>
            )}
          <button className="icon-btn shrink-0" onClick={() => fetchMeta(true)} disabled={strMetaState === 'loading'}
            aria-label="Refresh schema"
            title={strMetaState === 'loading'
              ? 'Loading schema…'
              : strMetaState !== 'idle'
                ? `Schema failed: ${strMetaState}`
                : `Refresh schema for autocomplete${objMetadata ? ` (${objMetadata.tables.length.toLocaleString()} tables loaded)` : ''}`}>
            <IconRefresh className={strMetaState !== 'idle' && strMetaState !== 'loading' ? 'text-danger' : ''} />
          </button>
        </div>
      </div>

      {/* editor */}
      <div ref={refHost} style={strPane === 'both' ? { height: intEditorHeight } : undefined}
        className={strPane === 'both' ? 'shrink-0' : strPane === 'editor' ? 'min-h-0 flex-1' : 'hidden'} />

      {/* splitter: drag to resize, arrows to give one pane the whole tab, cross to hide the results */}
      <div className="flex h-4 shrink-0 items-stretch border-y border-line bg-bg text-muted">
        <div onPointerDown={strPane === 'both' ? startResize : undefined} role="separator" aria-orientation="horizontal"
          className={`flex-1 ${strPane === 'both' ? 'cursor-row-resize hover:bg-hover' : ''}`} />
        <button className="flex w-7 items-center justify-center hover:bg-hover hover:text-fg disabled:opacity-30" disabled={strPane === 'results'}
          aria-label="Results up" title={strPane === 'editor' ? 'Show the results' : 'Results take the whole tab'}
          onClick={() => setStrPane(strPrev => (strPrev === 'editor' ? 'both' : 'results'))}>
          <IconChevronUp intSize={13} />
        </button>
        <button className="flex w-7 items-center justify-center hover:bg-hover hover:text-fg disabled:opacity-30" disabled={strPane === 'editor'}
          aria-label="Results down" title={strPane === 'results' ? 'Show the editor' : 'Hide the results'}
          onClick={() => setStrPane(strPrev => (strPrev === 'results' ? 'both' : 'editor'))}>
          <IconChevronDown intSize={13} />
        </button>
        <div onPointerDown={strPane === 'both' ? startResize : undefined}
          className={`flex-1 ${strPane === 'both' ? 'cursor-row-resize hover:bg-hover' : ''}`} />
        <button className={`flex w-7 items-center justify-center hover:bg-hover hover:text-fg ${strPane === 'editor' ? 'invisible' : ''}`}
          aria-label="Hide results" title="Hide the results" onClick={() => setStrPane('editor')}>
          <IconClose intSize={12} />
        </button>
      </div>

      {/* results: hidden, not unmounted (pending grid edits stay) */}
      <div className={`min-h-0 flex-1 flex-col ${strPane === 'editor' ? 'hidden' : 'flex'}`}>
        {boolRunning && objRun.status === 'running' && (
          <div className="shrink-0 border-b border-line">
            <div className="progress-bar rounded-none" />
            <div className="flex h-7 items-center gap-3 px-3 text-xs">
              <span>Running{objRun.total > 1 && ` statement ${objRun.index + 1} of ${objRun.total}`}…</span>
              <span className="tabular-nums text-fg">{((lngNow - objRun.startedAt) / 1000).toFixed(1)} s</span>
              {objLive && <span className="text-muted">{objLive.rows.length.toLocaleString()} rows so far</span>}
              <button className="btn ml-auto h-5 px-2 text-danger" onClick={stop}><IconStop intSize={11} /> Stop</button>
            </div>
          </div>
        )}
        {/* one tab per statement of the last run */}
        {objRun.status === 'done' && arrRuns.length > 1 && (
          <div className="flex h-7 shrink-0 items-end gap-px overflow-x-auto border-b border-line px-2" role="tablist">
            {arrRuns.map((objItem, intIndex) => (
              <button key={intIndex} role="tab" aria-selected={intIndex === intActiveRun}
                title={objItem.sql.slice(0, 300)} onClick={() => setIntActiveRun(intIndex)}
                className={`h-6 whitespace-nowrap rounded-t border border-b-0 px-2 text-xs ${
                  intIndex === intActiveRun ? 'border-line bg-panel' : 'border-transparent hover:bg-hover'
                } ${objItem.error ? 'text-danger' : intIndex === intActiveRun ? '' : 'text-muted'}`}>
                {intIndex + 1}. {runLabel(objItem)}
              </button>
            ))}
          </div>
        )}

        <div className="min-h-0 flex-1">
          {objActiveResult && objActiveResult.columns.length > 0 && (
            <div className="flex h-full flex-col">
              {objActiveResult.documents && (
                <div className="flex h-8 shrink-0 items-center border-b border-line px-2">
                  <div className="segmented" role="group" aria-label="Result view">
                    <button aria-pressed={!boolJson} onClick={() => setBoolJson(false)}>Grid</button>
                    <button aria-pressed={boolJson} onClick={() => setBoolJson(true)}>JSON</button>
                  </div>
                </div>
              )}
              <div className="min-h-0 flex-1">
                {objActiveResult.documents && boolJson
                  ? <CodeView strText={objActiveResult.documents.join(',\n')} strLanguage="mongodb" />
                  : objActiveRun
                    // The updates run in the tab's own session, so its transaction mode applies to them.
                    ? (
                      <EditableResult key={intActiveRun} objConnection={objConnection} strSql={objActiveRun.sql} objResult={objActiveResult}
                        strSessionId={strSessionId} boolAutoCommit={boolAutoCommit} intMaxRows={intMaxRows} onRan={() => { if (!boolAutoCommit) setBoolTxOpen(true); }} />
                    )
                    : <ResultGrid key={intActiveRun} objResult={objActiveResult} />}
              </div>
            </div>
          )}
          {objActiveResult && objActiveResult.columns.length === 0 && (
            <p className="p-4 text-muted">
              Statement finished. {objActiveResult.recordsAffected >= 0 && `${objActiveResult.recordsAffected.toLocaleString()} rows affected.`}
            </p>
          )}
          {objActiveRun?.error && (
            <div className="p-4">
              <p className="whitespace-pre-wrap font-mono text-xs text-danger" style={{ userSelect: 'text' }}>
                {objActiveRun.error.code && <strong>{objActiveRun.error.code}: </strong>}{objActiveRun.error.message}
              </p>
            </div>
          )}
          {objRun.status === 'idle' && (
            <p className="p-4 text-muted">Results appear here. Ctrl+Enter runs the statement under the cursor, F5 runs them all.</p>
          )}
          {boolRunning && (objLive
            ? <ResultGrid key="live" objResult={objLive} />
            : <p className="p-4 text-muted">Waiting for the first rows…</p>)}
        </div>
      </div>

      {/* status bar */}
      <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-bg px-3 text-xs text-muted">
        {objRun.status === 'running' && (
          <span>
            Running{objRun.total > 1 && ` statement ${objRun.index + 1} of ${objRun.total}`} for {((lngNow - objRun.startedAt) / 1000).toFixed(1)} s
            {objLive && ` · ${objLive.rows.length.toLocaleString()} rows so far`}
          </span>
        )}
        {objActiveResult && (
          <>
            <span>
              {objActiveResult.columns.length > 0
                ? `${objActiveResult.rows.length.toLocaleString()} rows`
                : `${Math.max(objActiveResult.recordsAffected, 0).toLocaleString()} rows affected`}
              {objActiveResult.truncated && ` (stopped at ${intMaxRows.toLocaleString()}, more rows exist)`}
            </span>
            <span>{objActiveResult.elapsedMs.toLocaleString()} ms</span>
          </>
        )}
        {objActiveRun?.error && <span className="text-danger">Query failed</span>}
        {objRun.status === 'done' && arrRuns.length > 1 && <span>Statement {intActiveRun + 1} of {arrRuns.length}</span>}
        {objRun.status === 'done' && objRun.skipped > 0 && (
          <span className="text-danger">{objRun.skipped} {objRun.skipped === 1 ? 'statement' : 'statements'} not run</span>
        )}
        <span className="ml-auto flex items-center gap-4">
          {boolTxOpen && <span className="text-danger">Uncommitted transaction</span>}
          <span ref={refCursor} className="tabular-nums" />
        </span>
      </footer>
    </section>
  );
}
