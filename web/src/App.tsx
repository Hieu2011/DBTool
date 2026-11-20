import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { Connection, DbObjectInfo, SchemaMetadata } from './types';
import { ConnectionList } from './components/ConnectionList';
import { ConnectionDialog, type DialogState } from './components/ConnectionDialog';
import { FORMAT_ACTION, QueryWorkspace, type EditorHandle } from './components/QueryWorkspace';
import { MenuBar, type MenuDef } from './components/MenuBar';
import { ApiError } from './api';
import { ObjectTree } from './components/ObjectTree';
import { RedisTree } from './components/RedisTree';
import { ObjectViewer } from './components/ObjectViewer';
import { selectAllQuery } from './sql/dialect';
import { envVar } from './envColor';
import { RoutineRunner } from './components/RoutineRunner';
import { HistoryDialog } from './components/HistoryDialog';
import { SnippetsDialog } from './components/SnippetsDialog';
import { getSnippets, setSnippets } from './sql/snippets';
import { IconClose, IconHistory, IconPlay, IconPlus, IconSidebar, IconSqlFile, IconTable } from './components/icons';

/** A connection can have several tabs: editors (each with its own DB session) and object viewers. */
type AppTab =
  | {
    id: string; connectionId: string; kind: 'query'; number: number; initialSql?: string; autoRun?: boolean;
    /** Set for a tab opened from, or saved to, a .sql file: its file name and full path. */
    title?: string; filePath?: string;
  }
  | { id: string; connectionId: string; kind: 'object'; object: DbObjectInfo }
  /** The form that runs a procedure / function. */
  | { id: string; connectionId: string; kind: 'routine'; object: DbObjectInfo };

const SIDEBAR_DEFAULT = 288;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 720;

const sameObject =(objLeft: DbObjectInfo, objRight: DbObjectInfo) =>
  objLeft.schema === objRight.schema && objLeft.name === objRight.name && objLeft.type === objRight.type &&
  (objLeft.signature ?? null) === (objRight.signature ?? null);

export default function App() {
  const [arrConnections, setArrConnections] = useState<Connection[]>([]);
  const [arrTabs, setArrTabs] = useState<AppTab[]>([]);
  const [strActiveTabId, setStrActiveTabId] = useState<string | null>(null);
  const [dicMetadata, setDicMetadata] = useState<Record<string, SchemaMetadata | undefined>>({});
  const [objDialog, setObjDialog] = useState<DialogState>(null);
  const [strLoadError, setStrLoadError] = useState<string | null>(null);
  // Tabs with an uncommitted transaction: closing one asks first.
  const refTxTabIds = useRef(new Set<string>());
  // The editor and the object tree both ask for metadata when a connection opens: share one request.
  const refMetadataLoads = useRef(new Map<string, Promise<SchemaMetadata>>());

  // Editors by tab id, for the menu: Save needs the text, Query > Run needs the editor.
  const refEditors = useRef(new Map<string, EditorHandle>());
  // Tabs edited since they were opened / saved.
  const [hsDirty, setHsDirty] = useState<Set<string>>(new Set());
  // What the global shortcuts call: replaced on every render so they see current state.
  const refShortcuts = useRef<Record<string, () => void>>({});

  const [intSidebarWidth, setIntSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const [boolSidebarOpen, setBoolSidebarOpen] = useState(true);
  const [boolHistory, setBoolHistory] = useState(false);
  const [boolSnippets, setBoolSnippets] = useState(false);

  // Snippets feed every editor's autocomplete.
  useEffect(() => { api.snippets().then(setSnippets).catch(() => {}); }, []);

  // Sidebar width / visibility live in the app's settings file: browser storage is lost on every start.
  const refSettingsLoaded = useRef(false);
  useEffect(() => {
    api.settings().then(dicSettings => {
      const intWidth = Number(dicSettings.sidebarWidth);
      if (Number.isFinite(intWidth) && intWidth >= SIDEBAR_MIN && intWidth <= SIDEBAR_MAX) setIntSidebarWidth(intWidth);
      if (typeof dicSettings.sidebarOpen === 'boolean') setBoolSidebarOpen(dicSettings.sidebarOpen);
    }).catch(() => {}).finally(() => { refSettingsLoaded.current = true; });
  }, []);
  useEffect(() => {
    if (!refSettingsLoaded.current) return;
    const intTimer = setTimeout(() => {
      api.saveSettings({ sidebarWidth: intSidebarWidth, sidebarOpen: boolSidebarOpen }).catch(() => {});
    }, 400);
    return () => clearTimeout(intTimer);
  }, [intSidebarWidth, boolSidebarOpen]);

  // App shortcuts (Ctrl+B sidebar, Ctrl+N / O / S / W for the File menu). Capture phase: the editor must not eat them.
  useEffect(() => {
    const onKeyDown = (objEvent: KeyboardEvent) => {
      if (!objEvent.ctrlKey || objEvent.altKey) return;
      const strKey = `${objEvent.shiftKey ? 'shift+' : ''}${objEvent.key.toLowerCase()}`;
      const fnAction = refShortcuts.current[strKey];
      if (!fnAction) return;
      objEvent.preventDefault();
      objEvent.stopPropagation();
      fnAction();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const registerEditor = useCallback((strTabId: string, objHandle: EditorHandle | null) => {
    if (objHandle) refEditors.current.set(strTabId, objHandle);
    else refEditors.current.delete(strTabId);
  }, []);

  const markDirty = useCallback((strTabId: string) => {
    setHsDirty(hsPrev => (hsPrev.has(strTabId) ? hsPrev : new Set(hsPrev).add(strTabId)));
  }, []);

  const startSidebarResize = (objEvent: React.PointerEvent) => {
    objEvent.preventDefault();
    const intStartX = objEvent.clientX;
    const intStartWidth = intSidebarWidth;
    const move = (objMoveEvent: PointerEvent) =>
      setIntSidebarWidth(Math.min(Math.max(intStartWidth + objMoveEvent.clientX - intStartX, SIDEBAR_MIN),
        Math.min(SIDEBAR_MAX, window.innerWidth - 320)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize'; // keeps the cursor while the pointer outruns the handle
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const reload = useCallback(async () => {
    try {
      setArrConnections(await api.listConnections());
      setStrLoadError(null);
    } catch (objEx) {
      setStrLoadError((objEx as Error).message);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const objActiveTab = arrTabs.find(objTab => objTab.id === strActiveTabId);
  const objActiveConnection = arrConnections.find(objItem => objItem.id === objActiveTab?.connectionId);

  const addTab = (objTab: AppTab) => {
    setArrTabs([...arrTabs, objTab]);
    setStrActiveTabId(objTab.id);
  };

  const newQueryTab = (strConnectionId: string, strInitialSql?: string, boolAutoRun = false) => {
    const arrNumbers = arrTabs.map(objTab => (objTab.kind === 'query' && objTab.connectionId === strConnectionId ? objTab.number : 0));
    addTab({
      id: crypto.randomUUID(), connectionId: strConnectionId, kind: 'query', number: Math.max(0, ...arrNumbers) + 1,
      initialSql: strInitialSql, autoRun: boolAutoRun,
    });
  };

  /** Focuses the connection's latest tab, or opens its first editor. */
  const open = (strConnectionId: string) => {
    if (objActiveTab?.connectionId === strConnectionId) return;
    const objExisting = arrTabs.filter(objTab => objTab.connectionId === strConnectionId).at(-1);
    if (objExisting) setStrActiveTabId(objExisting.id);
    else newQueryTab(strConnectionId);
  };

  /** Object viewer ('object') or Execute form ('routine'): one tab per object, focused if already open. */
  const openObject = (strConnectionId: string, objObject: DbObjectInfo, strTabKind: 'object' | 'routine' = 'object') => {
    const objExisting = arrTabs.find(objTab =>
      objTab.kind === strTabKind && objTab.connectionId === strConnectionId && sameObject(objTab.object, objObject));
    if (objExisting) setStrActiveTabId(objExisting.id);
    else addTab({ id: crypto.randomUUID(), connectionId: strConnectionId, kind: strTabKind, object: objObject });
  };

  const closeTabs = (arrClosing: AppTab[]) => {
    if (arrClosing.length === 0) return;
    const arrNext = arrTabs.filter(objTab => !arrClosing.includes(objTab));
    setArrTabs(arrNext);
    if (objActiveTab && arrClosing.includes(objActiveTab)) {
      // the tab that takes the closed one's place, else the new last tab
      const intIndex = arrTabs.indexOf(objActiveTab);
      setStrActiveTabId(arrNext[Math.min(intIndex, arrNext.length - 1)]?.id ?? null);
    }
  };

  const closeTab = (objTab: AppTab) => {
    if (refTxTabIds.current.has(objTab.id) &&
      !confirm('This tab has an uncommitted transaction. Closing it rolls the transaction back.\n\nClose anyway?')) return;
    if (objTab.kind === 'query' && objTab.filePath && hsDirty.has(objTab.id) &&
      !confirm(`${objTab.title} has changes that are not saved.\n\nClose without saving?`)) return;
    closeTabs([objTab]);
  };

  const closeAllTabs = () => {
    const boolUnsaved = arrTabs.some(objTab => objTab.kind === 'query' && objTab.filePath && hsDirty.has(objTab.id));
    const boolTransaction = arrTabs.some(objTab => refTxTabIds.current.has(objTab.id));
    if ((boolUnsaved || boolTransaction) &&
      !confirm(`Some tabs have ${boolUnsaved ? 'unsaved changes' : ''}${boolUnsaved && boolTransaction ? ' or ' : ''}${
        boolTransaction ? 'an uncommitted transaction' : ''}.\n\nClose them all anyway?`)) return;
    closeTabs(arrTabs);
  };

  const errorText = (objEx: unknown) => (objEx instanceof ApiError ? objEx.detail.message : (objEx as Error).message);

  // ---- File menu ----
  // A SQL tab always runs on one connection: the active tab's, or the only one there is.
  const strFileConnectionId = objActiveTab?.connectionId ?? (arrConnections.length === 1 ? arrConnections[0].id : undefined);

  const openSqlFiles = async () => {
    if (!strFileConnectionId) { alert('Open a connection first: a SQL file runs on the connection of its tab.'); return; }
    try {
      const arrFiles = await api.openSqlFiles();
      if (arrFiles.length === 0) return;
      const arrNew: AppTab[] = [];
      let strFocus: string | null = null;
      for (const objFile of arrFiles) {
        const objExisting = arrTabs.find(objTab => objTab.kind === 'query' && objTab.filePath?.toLowerCase() === objFile.path.toLowerCase());
        if (objExisting) { strFocus = objExisting.id; continue; }
        const objTab: AppTab = {
          id: crypto.randomUUID(), connectionId: strFileConnectionId, kind: 'query', number: 0,
          initialSql: objFile.text, title: objFile.name, filePath: objFile.path,
        };
        arrNew.push(objTab);
        strFocus = objTab.id;
      }
      if (arrNew.length > 0) setArrTabs(arrPrev => [...arrPrev, ...arrNew]);
      if (strFocus) setStrActiveTabId(strFocus);
    } catch (objEx) {
      alert(`The file could not be opened.\n\n${errorText(objEx)}`);
    }
  };

  const saveActiveTab = async (boolSaveAs: boolean) => {
    if (objActiveTab?.kind !== 'query') return;
    const objHandle = refEditors.current.get(objActiveTab.id);
    if (!objHandle) return;
    const strTabId = objActiveTab.id;
    try {
      const objSaved = await api.saveSqlFile(boolSaveAs ? null : objActiveTab.filePath ?? null,
        objActiveTab.title ?? `${objActiveConnection?.name ?? 'query'}.sql`, objHandle.getSql());
      if (!objSaved) return; // Save dialog cancelled
      setArrTabs(arrPrev => arrPrev.map(objTab => (objTab.id === strTabId && objTab.kind === 'query'
        ? { ...objTab, title: objSaved.name, filePath: objSaved.path }
        : objTab)));
      setHsDirty(hsPrev => { const hsNext = new Set(hsPrev); hsNext.delete(strTabId); return hsNext; });
    } catch (objEx) {
      alert(`The file could not be saved.\n\n${errorText(objEx)}`);
    }
  };

  const remove = async (objConnection: Connection) => {
    if (!confirm(`Delete connection "${objConnection.name}"?`)) return;
    await api.deleteConnection(objConnection.id);
    closeTabs(arrTabs.filter(objTab => objTab.connectionId === objConnection.id));
    await reload();
  };

  /** strSchema: also load that schema (databases read one schema at a time). */
  const loadMetadata = useCallback((strId: string, boolRefresh = false, strSchema?: string) => {
    const dicLoads = refMetadataLoads.current;
    const strLoadKey = `${strId}|${strSchema ?? ''}`;
    const objPending = dicLoads.get(strLoadKey);
    if (objPending && !boolRefresh) return objPending;

    const objLoad = api.metadata(strId, boolRefresh, strSchema)
      .then(objMeta => {
        setDicMetadata(dicPrev => ({ ...dicPrev, [strId]: objMeta }));
        return objMeta;
      })
      .finally(() => { if (dicLoads.get(strLoadKey) === objLoad) dicLoads.delete(strLoadKey); });
    dicLoads.set(strLoadKey, objLoad);
    return objLoad;
  }, []);

  const trackTransaction = useCallback((strTabId: string, boolOpen: boolean) => {
    if (boolOpen) refTxTabIds.current.add(strTabId);
    else refTxTabIds.current.delete(strTabId);
  }, []);

  const arrOpened = arrTabs.flatMap(objTab => {
    const objConnection = arrConnections.find(objItem => objItem.id === objTab.connectionId);
    return objConnection ? [{ objTab, objConnection }] : [];
  });

  const tabLabel = (objTab: AppTab, objConnection: Connection) =>
    objTab.kind === 'query'
      ? objTab.title ?? `${objConnection.name}${objTab.number > 1 ? ` (${objTab.number})` : ''}`
      : objTab.object.name;

  const tabTitle = (objTab: AppTab, objConnection: Connection) =>
    objTab.kind === 'query'
      ? (objTab.filePath ? `${objTab.filePath} (${objConnection.name})` : objConnection.name)
      : `${objTab.kind === 'routine' ? 'Execute ' : ''}${objTab.object.type} ${objTab.object.schema}.${objTab.object.name} (${objConnection.name})`;

  const tabIcon = (objTab: AppTab) =>
    objTab.kind === 'query' ? <IconSqlFile intSize={14} /> : objTab.kind === 'routine' ? <IconPlay intSize={12} /> : <IconTable intSize={14} />;

  // ---- application menu ----
  const objEditor = objActiveTab?.kind === 'query' ? refEditors.current.get(objActiveTab.id) : undefined;
  const boolQueryTab = objActiveTab?.kind === 'query';
  const newTabHere = () => { if (strFileConnectionId) newQueryTab(strFileConnectionId); };
  const editorAction = (strAction: string) => () => objEditor?.trigger(strAction);

  refShortcuts.current = {
    b: () => setBoolSidebarOpen(boolPrev => !boolPrev),
    n: newTabHere,
    o: () => { openSqlFiles(); },
    s: () => { saveActiveTab(false); },
    'shift+s': () => { saveActiveTab(true); },
    w: () => { if (objActiveTab) closeTab(objActiveTab); },
    'shift+h': () => { if (objActiveConnection) setBoolHistory(true); },
  };

  const arrMenus: MenuDef[] = [
    {
      label: 'File',
      items: [
        { label: 'New SQL tab', hint: 'Ctrl+N', icon: <IconPlus intSize={14} />, disabled: !strFileConnectionId, onSelect: newTabHere },
        { label: 'Open SQL file…', hint: 'Ctrl+O', icon: <IconSqlFile intSize={14} />, disabled: !strFileConnectionId, onSelect: () => { openSqlFiles(); } },
        { kind: 'separator' },
        { label: 'Save', hint: 'Ctrl+S', disabled: !boolQueryTab, onSelect: () => { saveActiveTab(false); } },
        { label: 'Save as…', hint: 'Ctrl+Shift+S', disabled: !boolQueryTab, onSelect: () => { saveActiveTab(true); } },
        { kind: 'separator' },
        { label: 'Close tab', hint: 'Ctrl+W', disabled: !objActiveTab, onSelect: () => { if (objActiveTab) closeTab(objActiveTab); } },
        { label: 'Close all tabs', disabled: arrTabs.length === 0, onSelect: closeAllTabs },
        { kind: 'separator' },
        { label: 'Exit', hint: 'Alt+F4', onSelect: () => window.close() },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', hint: 'Ctrl+Z', disabled: !boolQueryTab, onSelect: editorAction('undo') },
        { label: 'Redo', hint: 'Ctrl+Y', disabled: !boolQueryTab, onSelect: editorAction('redo') },
        { kind: 'separator' },
        { label: 'Find', hint: 'Ctrl+F', disabled: !boolQueryTab, onSelect: editorAction('actions.find') },
        { label: 'Replace', hint: 'Ctrl+H', disabled: !boolQueryTab, onSelect: editorAction('editor.action.startFindReplaceAction') },
        { kind: 'separator' },
        { label: 'Format SQL', hint: 'Ctrl+Shift+F', disabled: !boolQueryTab, onSelect: editorAction(FORMAT_ACTION) },
        { label: 'Toggle comment', hint: 'Ctrl+/', disabled: !boolQueryTab, onSelect: editorAction('editor.action.commentLine') },
        { label: 'Select all', hint: 'Ctrl+A', disabled: !boolQueryTab, onSelect: editorAction('editor.action.selectAll') },
        { kind: 'separator' },
        { label: 'Snippets…', onSelect: () => setBoolSnippets(true) },
      ],
    },
    {
      label: 'View',
      items: [
        { label: boolSidebarOpen ? 'Hide sidebar' : 'Show sidebar', hint: 'Ctrl+B', icon: <IconSidebar intSize={14} />,
          onSelect: () => setBoolSidebarOpen(boolPrev => !boolPrev) },
        { label: 'Reset sidebar width', onSelect: () => setIntSidebarWidth(SIDEBAR_DEFAULT) },
      ],
    },
    {
      label: 'Query',
      items: [
        { label: 'Run statement', hint: 'Ctrl+Enter', icon: <IconPlay intSize={12} />, disabled: !boolQueryTab, onSelect: () => objEditor?.run(false) },
        { label: 'Run all', hint: 'F5', disabled: !boolQueryTab, onSelect: () => objEditor?.run(true) },
        { label: 'Stop', disabled: !boolQueryTab, onSelect: () => objEditor?.stop() },
        { kind: 'separator' },
        { label: 'Commit', disabled: !boolQueryTab, onSelect: () => objEditor?.commit() },
        { label: 'Rollback', disabled: !boolQueryTab, onSelect: () => objEditor?.rollback() },
        { kind: 'separator' },
        { label: 'History…', hint: 'Ctrl+Shift+H', icon: <IconHistory intSize={14} />, disabled: !objActiveConnection,
          onSelect: () => setBoolHistory(true) },
      ],
    },
    {
      label: 'Connection',
      items: [
        { label: 'New connection…', icon: <IconPlus intSize={14} />, onSelect: () => setObjDialog({ mode: 'new' }) },
        { label: 'Edit this connection…', disabled: !objActiveConnection,
          onSelect: () => { if (objActiveConnection) setObjDialog({ mode: 'edit', connection: objActiveConnection }); } },
        { label: 'Refresh schema', disabled: !objActiveConnection,
          onSelect: () => { if (objActiveConnection) loadMetadata(objActiveConnection.id, true).catch(() => {}); } },
        { kind: 'separator' },
        { label: 'Delete this connection…', danger: true, disabled: !objActiveConnection,
          onSelect: () => { if (objActiveConnection) remove(objActiveConnection); } },
      ],
    },
  ];

  return (
    <div className="flex h-full flex-col">
      <MenuBar arrMenus={arrMenus} />
      {boolSnippets && (
        <SnippetsDialog arrInitial={getSnippets()}
          onInsert={objEditor ? strBody => objEditor.insertSnippet(strBody) : null}
          onSaved={setSnippets}
          onClose={() => setBoolSnippets(false)} />
      )}
      {boolHistory && objActiveConnection && (
        <HistoryDialog objConnection={objActiveConnection}
          onInsert={objEditor ? strSql => objEditor.insertText(strSql) : null}
          onOpenTab={strSql => newQueryTab(objActiveConnection.id, strSql)}
          onClose={() => setBoolHistory(false)} />
      )}
      <div className="flex min-h-0 flex-1">
      <ConnectionList
        arrConnections={arrConnections}
        strActiveId={objActiveTab?.connectionId ?? null}
        hsOpenIds={new Set(arrTabs.map(objTab => objTab.connectionId))}
        strError={strLoadError}
        onOpen={open}
        onNew={() => setObjDialog({ mode: 'new' })}
        onEdit={objConnection => setObjDialog({ mode: 'edit', connection: objConnection })}
        onDelete={remove}
        intWidth={intSidebarWidth}
        boolHidden={!boolSidebarOpen}
      >
        {objActiveConnection?.kind === 'Redis' && (
          <RedisTree
            key={objActiveConnection.id}
            objConnection={objActiveConnection}
            onOpenObject={objObject => openObject(objActiveConnection.id, objObject)}
            onOpenSql={(strSql, boolAutoRun) => newQueryTab(objActiveConnection.id, strSql, boolAutoRun)}
          />
        )}
        {objActiveConnection && objActiveConnection.kind !== 'Redis' && (
          <ObjectTree
            key={objActiveConnection.id}
            objConnection={objActiveConnection}
            objMetadata={dicMetadata[objActiveConnection.id]}
            loadMetadata={loadMetadata}
            onOpenObject={objObject => openObject(objActiveConnection.id, objObject)}
            onOpenSql={(strSql, boolAutoRun) => newQueryTab(objActiveConnection.id, strSql, boolAutoRun)}
            onExecuteRoutine={objRoutine => openObject(objActiveConnection.id, objRoutine, 'routine')}
            onOpenData={objObject => newQueryTab(
              objActiveConnection.id,
              selectAllQuery(objActiveConnection.kind, objObject.schema, objObject.name),
              true)}
          />
        )}
      </ConnectionList>

      {/* drag to resize the sidebar, double-click for the default width */}
      {boolSidebarOpen && (
        <div
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize, double-click to reset"
          onPointerDown={startSidebarResize}
          onDoubleClick={() => setIntSidebarWidth(SIDEBAR_DEFAULT)}
          className="w-1 shrink-0 cursor-col-resize border-l border-line hover:bg-accent/60 active:bg-accent"
        />
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-end gap-px overflow-x-auto border-b border-line px-1.5" role="tablist">
            <button
              className={`icon-btn icon-btn-sm mb-1 mr-1 ${boolSidebarOpen ? '' : 'text-accent'}`}
              aria-label={boolSidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
              aria-pressed={boolSidebarOpen}
              title={`${boolSidebarOpen ? 'Hide' : 'Show'} the sidebar (Ctrl+B)`}
              onClick={() => setBoolSidebarOpen(boolPrev => !boolPrev)}
            >
              <IconSidebar />
            </button>
            {arrOpened.map(({ objTab, objConnection }) => (
              <div
                key={objTab.id}
                role="tab"
                aria-selected={objTab.id === strActiveTabId}
                title={tabTitle(objTab, objConnection)}
                onClick={() => setStrActiveTabId(objTab.id)}
                className={`group flex h-8 max-w-56 shrink-0 items-center gap-2 rounded-t border border-b-0 px-3 ${
                  objTab.id === strActiveTabId ? 'border-line bg-panel' : 'border-transparent text-muted hover:bg-hover'
                }`}
                style={{ boxShadow: objTab.id === strActiveTabId ? `inset 0 2px 0 ${envVar(objConnection.color)}` : undefined }}
              >
                <span style={{ color: envVar(objConnection.color) }}>{tabIcon(objTab)}</span>
                <span className="truncate">{tabLabel(objTab, objConnection)}</span>
                {objTab.kind === 'query' && objTab.filePath && hsDirty.has(objTab.id) && (
                  <span className="-ml-1 text-accent" title="Not saved" aria-label="Not saved">●</span>
                )}
                <button
                  aria-label={`Close ${tabLabel(objTab, objConnection)}`}
                  onClick={objEvent => { objEvent.stopPropagation(); closeTab(objTab); }}
                  className={`icon-btn icon-btn-sm -mr-1.5 h-5 min-w-5 group-hover:opacity-100 ${objTab.id === strActiveTabId ? '' : 'opacity-0'}`}
                >
                  <IconClose intSize={12} />
                </button>
              </div>
            ))}
            {objActiveTab && (
              <button
                aria-label="New editor tab on this connection"
                title="New editor tab on this connection"
                onClick={() => newQueryTab(objActiveTab.connectionId)}
                className="icon-btn icon-btn-sm mb-1 ml-1"
              >
                <IconPlus intSize={14} />
              </button>
            )}
        </div>

        <div className="relative min-h-0 flex-1">
          {arrOpened.map(({ objTab, objConnection }) => (objTab.kind === 'routine'
            ? (
              <RoutineRunner
                key={objTab.id}
                objConnection={objConnection}
                objRoutine={objTab.object}
                boolActive={objTab.id === strActiveTabId}
              />
            )
            : objTab.kind === 'object'
            ? (
              <ObjectViewer
                key={objTab.id}
                objConnection={objConnection}
                objObject={objTab.object}
                boolActive={objTab.id === strActiveTabId}
                onOpenSql={(strSql, boolAutoRun) => newQueryTab(objConnection.id, strSql, boolAutoRun)}
                onExecute={() => openObject(objConnection.id, objTab.object, 'routine')}
                objMetadata={dicMetadata[objConnection.id]}
                onOpenObject={objObject => openObject(objConnection.id, objObject)}
                onRenamed={strNewName => setArrTabs(arrPrev => arrPrev.map(objItem => (objItem.id === objTab.id && objItem.kind === 'object'
                  ? { ...objItem, object: { ...objItem.object, name: strNewName } }
                  : objItem)))}
              />
            )
            : (
              <QueryWorkspace
                key={objTab.id}
                strTabId={objTab.id}
                objConnection={objConnection}
                boolActive={objTab.id === strActiveTabId}
                objMetadata={dicMetadata[objConnection.id]}
                loadMetadata={loadMetadata}
                onTransactionChange={trackTransaction}
                onHandle={registerEditor}
                onContentChange={markDirty}
                strInitialSql={objTab.initialSql}
                boolAutoRun={objTab.autoRun}
              />
            )))}

          {arrOpened.length === 0 && (
            <div className="grid h-full place-items-center text-muted">
              <div className="text-center">
                <p className="mb-3">Pick a connection on the left to start writing queries.</p>
                <button className="btn" onClick={() => setObjDialog({ mode: 'new' })}>New connection</button>
              </div>
            </div>
          )}
        </div>
      </main>
      </div>

      {objDialog && (
        <ConnectionDialog
          objState={objDialog}
          onClose={() => setObjDialog(null)}
          onSaved={async objSaved => {
            setObjDialog(null);
            setDicMetadata(dicPrev => ({ ...dicPrev, [objSaved.id]: undefined }));
            await reload();
            open(objSaved.id);
          }}
        />
      )}
    </div>
  );
}
