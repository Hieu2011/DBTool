import { useEffect, useRef, useState } from 'react';
import type { Connection } from '../types';
import { KIND_LABEL } from '../types';
import { envVar } from '../envColor';
import { IconChevronDown, IconChevronRight, IconClose, IconPencil, IconPlus, IconRefresh, IconTrash, KindIcon } from './icons';
import type { TreeStatus } from './useOuterScroll';
import { ContextMenu, type MenuItem } from './ContextMenu';

/** What the sidebar hands each tree: the one filter box and the Refresh button of its connection's row. */
export interface TreeControl {
  filter: string; onFilter: (strFilter: string) => void; refresh: number;
  onStatus: (strStatus: TreeStatus) => void;
  onError: (strMessage: string, boolRefresh: boolean) => void;
}

const STATUS_COLOR: Record<TreeStatus, string> = { idle: 'var(--muted)', loading: 'var(--env-amber)', ok: 'var(--success)', failed: 'var(--danger)' };
const STATUS_LABEL: Record<TreeStatus, string> = { idle: 'Not connected', loading: 'Connecting…', ok: 'Connected', failed: 'Connection failed' };

interface Props {
  arrConnections: Connection[];
  strActiveId: string | null;
  /** Connections that have at least one tab open. */
  hsOpenIds: Set<string>;
  strError: string | null;
  onOpen: (strId: string) => void;
  /** The user opened this group without opening a tab: menu commands then target it. */
  onSelect: (strId: string) => void;
  onNew: () => void;
  onEdit: (objConnection: Connection) => void;
  onDelete: (objConnection: Connection) => void;
  /** Right-click menu: a new editor tab on the connection, and closing everything it has open. */
  onNewTab: (strId: string) => void;
  onDisconnect: (strId: string) => void;
  /** The tree of a connection just loaded: tabs whose session had failed connect again. */
  onTreeConnected: (strId: string) => void;
  intWidth: number;
  /** Hidden keeps the sidebar mounted, so the object trees keep what is open and loaded. */
  boolHidden: boolean;
  /** Latest connect / disconnect of a connection from its tabs: connected unfolds it, disconnected folds it and drops its tree. */
  objLink: { id: string; connected: boolean; serial: number } | null;
  /** State of each connection as its editor tabs see it; it wins over what the tree knows. */
  dicTabStatus: Record<string, TreeStatus>;
  /** The object / key tree of one connection, shown under its row. */
  renderTree: (objConnection: Connection, boolActive: boolean, objControl: TreeControl) => React.ReactNode;
}

const without = (hsSet: Set<string>, strId: string) => { const hsNext = new Set(hsSet); hsNext.delete(strId); return hsNext; };

/**
 * Sidebar: one tree for everything. Each connection is a top-level node with its objects under it, and the whole
 * list scrolls as one (the trees virtualize their rows against this scroller, see useOuterScroll).
 */
export function ConnectionList({
  arrConnections, strActiveId, hsOpenIds, strError, onOpen, onSelect, onNew, onEdit, onDelete, onNewTab, onDisconnect, onTreeConnected, intWidth, boolHidden, objLink, dicTabStatus, renderTree,
}: Props) {
  const [hsExpanded, setHsExpanded] = useState<Set<string>>(new Set());
  // A tree stays mounted once shown: collapsing a connection must not drop what it loaded.
  const [hsMounted, setHsMounted] = useState<Set<string>>(new Set());
  const [strFilter, setStrFilter] = useState('');
  const [dicRefresh, setDicRefresh] = useState<Record<string, number>>({});
  const [dicStatus, setDicStatus] = useState<Record<string, TreeStatus>>({});
  const [objFailure, setObjFailure] = useState<{ id: string; message: string; refresh: boolean } | null>(null);
  // A tree got through (Retry) where a tab had failed: without this the tab's failure keeps the icon red.
  const refTreeStatus = useRef<Record<string, TreeStatus>>({});
  const refOnTreeConnected = useRef(onTreeConnected);
  refOnTreeConnected.current = onTreeConnected;
  useEffect(() => {
    for (const [strId, strStatus] of Object.entries(dicStatus))
      if (strStatus === 'ok' && refTreeStatus.current[strId] !== 'ok') refOnTreeConnected.current(strId);
    refTreeStatus.current = dicStatus;
  }, [dicStatus]);
  const retry = (strId: string) => setDicRefresh(dicPrev => ({ ...dicPrev, [strId]: (dicPrev[strId] ?? 0) + 1 }));
  const [objMenu, setObjMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const objFailed = objFailure ? arrConnections.find(objItem => objItem.id === objFailure.id) : undefined;

  useEffect(() => {
    if (!objFailure) return;
    const onKey = (objEvent: KeyboardEvent) => objEvent.key === 'Escape' && setObjFailure(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [objFailure]);

  const expand = (strId: string) => {
    setHsExpanded(hsPrev => (hsPrev.has(strId) ? hsPrev : new Set(hsPrev).add(strId)));
    setHsMounted(hsPrev => (hsPrev.has(strId) ? hsPrev : new Set(hsPrev).add(strId)));
  };

  const toggle = (strId: string) => {
    if (hsExpanded.has(strId)) setHsExpanded(hsPrev => without(hsPrev, strId));
    else { expand(strId); onSelect(strId); }
  };

  useEffect(() => {
    if (!objLink) return;
    const strId = objLink.id;
    if (objLink.connected) {
      expand(strId);
      // A tab got through where the tree had failed: the tree tries again.
      if (dicStatus[strId] === 'failed') retry(strId);
      return;
    }
    // Unmounted: the tree's own connection state goes with it, and unfolding it later connects afresh.
    setHsExpanded(hsPrev => without(hsPrev, strId));
    setHsMounted(hsPrev => without(hsPrev, strId));
    setDicStatus(dicPrev => ({ ...dicPrev, [strId]: 'idle' }));
  }, [objLink]);

  /** Right-click on a connection row. */
  const menuItems = (strId: string): MenuItem[] => {
    const objConnection = arrConnections.find(objItem => objItem.id === strId);
    if (!objConnection) return [];
    const strStatus = dicTabStatus[strId] ?? dicStatus[strId] ?? 'idle';
    return [
      { kind: 'header', label: objConnection.name },
      // Unfolding mounts the tree, which connects; a tree that already failed tries again.
      { label: 'Connect', disabled: strStatus === 'ok' || strStatus === 'loading',
        onSelect: () => { if (hsMounted.has(strId)) retry(strId); expand(strId); onSelect(strId); } },
      { label: 'Disconnect', disabled: strStatus === 'idle', onSelect: () => onDisconnect(strId) },
      { kind: 'separator' },
      { label: 'New SQL tab', icon: <IconPlus intSize={14} />, onSelect: () => { expand(strId); onNewTab(strId); } },
      { label: 'Refresh', icon: <IconRefresh intSize={14} />, disabled: !hsMounted.has(strId), onSelect: () => retry(strId) },
      { kind: 'separator' },
      { label: 'Edit connection…', icon: <IconPencil intSize={14} />, onSelect: () => onEdit(objConnection) },
      { label: 'Delete connection', icon: <IconTrash intSize={14} />, danger: true, onSelect: () => onDelete(objConnection) },
    ];
  };

  // The connection of the active tab opens by itself.
  useEffect(() => { if (strActiveId) expand(strActiveId); }, [strActiveId]);

  // A deleted connection leaves no tree behind.
  useEffect(() => {
    const hsIds = new Set(arrConnections.map(objItem => objItem.id));
    setHsMounted(hsPrev => ([...hsPrev].every(strId => hsIds.has(strId)) ? hsPrev : new Set([...hsPrev].filter(strId => hsIds.has(strId)))));
  }, [arrConnections]);

  return (
    <aside className={`shrink-0 flex-col bg-bg ${boolHidden ? 'hidden' : 'flex'}`} style={{ width: intWidth }}>
      <div className="flex h-9 shrink-0 items-center justify-between pl-3 pr-1.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Connections
          {arrConnections.length > 0 && <span className="ml-1.5 font-normal tabular-nums">{arrConnections.length}</span>}
        </h2>
        <button className="icon-btn icon-btn-sm" onClick={onNew} aria-label="New connection" title="New connection">
          <IconPlus />
        </button>
      </div>

      <div className="relative shrink-0 px-2 pb-1.5">
        <input className="field h-7 pr-7" placeholder="Filter objects (tables, procedures, schemas…)" spellCheck={false}
          value={strFilter} onChange={objEvent => setStrFilter(objEvent.target.value)}
          onKeyDown={objEvent => { if (objEvent.key === 'Escape') setStrFilter(''); }} />
        {strFilter && (
          <button className="icon-btn icon-btn-sm absolute right-3 top-0.5" aria-label="Clear the filter" onClick={() => setStrFilter('')}>
            <IconClose intSize={12} />
          </button>
        )}
      </div>

      {objMenu && <ContextMenu intX={objMenu.x} intY={objMenu.y} arrItems={menuItems(objMenu.id)} onClose={() => setObjMenu(null)} />}

      {strError && (
        <p className="m-3 rounded border border-danger/40 p-2 text-danger">
          Can't reach the local API: {strError}
        </p>
      )}

      <div data-tree-scroll className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {/* one child: the trees watch its height to know where they start */}
        <div className="pb-2">
          {arrConnections.map(objConnection => {
            const strId = objConnection.id;
            const boolActive = strId === strActiveId;
            const boolExpanded = hsExpanded.has(strId);
            const boolOpen = hsOpenIds.has(strId);
            const Chevron = boolExpanded ? IconChevronDown : IconChevronRight;
            const strStatus = dicTabStatus[strId] ?? dicStatus[strId] ?? 'idle';
            return (
              <section key={strId} aria-label={objConnection.name}>
                {/* h-9 = TREE_STICKY_TOP: stays on top while its own tree scrolls under it */}
                <div
                  tabIndex={0}
                  aria-expanded={boolExpanded}
                  onClick={() => { expand(strId); onOpen(strId); }}
                  onKeyDown={objEvent => {
                    if (objEvent.target !== objEvent.currentTarget) return;
                    if (objEvent.key === 'Enter') { expand(strId); onOpen(strId); }
                    if (objEvent.key === 'ArrowRight') { expand(strId); onSelect(strId); }
                    if (objEvent.key === 'ArrowLeft') setHsExpanded(hsPrev => without(hsPrev, strId));
                  }}
                  onDoubleClick={() => onEdit(objConnection)}
                  onContextMenu={objEvent => { objEvent.preventDefault(); setObjMenu({ x: objEvent.clientX, y: objEvent.clientY, id: strId }); }}
                  title={`Name: ${objConnection.name}\n${KIND_LABEL[objConnection.kind]}: ${objConnection.host}:${objConnection.port}${objConnection.database ? `/${objConnection.database}` : ''}${objConnection.username ? `\nUser: ${objConnection.username}` : ''}`}
                  className={`group sticky top-0 z-20 flex h-9 items-center gap-1.5 pl-1.5 pr-1.5 ${boolActive ? 'bg-panel' : 'bg-bg'} hover:bg-hover`}
                  style={{ boxShadow: `inset 3px 0 0 ${boolActive || objConnection.color !== 'slate' ? envVar(objConnection.color) : 'transparent'}` }}
                >
                  <button className="icon-btn icon-btn-sm h-5 min-w-5 px-0" aria-label={boolExpanded ? 'Collapse' : 'Expand'}
                    onClick={objEvent => { objEvent.stopPropagation(); toggle(strId); }}
                    onDoubleClick={objEvent => objEvent.stopPropagation()}>
                    <Chevron intSize={14} />
                  </button>
                  <KindIcon strKind={objConnection.kind} intSize={17} boolMuted={strStatus !== 'ok'} />
                  <span className={`shrink-0 truncate ${boolOpen ? 'font-semibold' : 'font-medium'}`} style={{ maxWidth: '60%' }}>{objConnection.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] italic text-muted">{objConnection.host}:{objConnection.port}</span>
                  {/* Reload and Edit show on hover; Delete / Disconnect live in the right-click menu */}
                  {boolExpanded && (
                    <button className="icon-btn icon-btn-sm hidden group-hover:inline-flex group-focus-within:inline-flex" aria-label={`Refresh ${objConnection.name}`}
                      title="Connect again and reload the list" onClick={objEvent => { objEvent.stopPropagation(); retry(strId); }}>
                      <IconRefresh intSize={14} />
                    </button>
                  )}
                  <button className="icon-btn icon-btn-sm hidden group-hover:inline-flex group-focus-within:inline-flex" aria-label={`Edit ${objConnection.name}`}
                    title="Edit connection" onClick={objEvent => { objEvent.stopPropagation(); onEdit(objConnection); }}>
                    <IconPencil intSize={14} />
                  </button>
                  <span className="mx-1 h-2 w-2 shrink-0 rounded-full" title={STATUS_LABEL[strStatus]}
                    style={{ background: STATUS_COLOR[strStatus], opacity: strStatus === 'idle' ? 0.45 : 1 }} />
                </div>

                {hsMounted.has(strId) && (
                  <div className={`pl-3 ${boolExpanded ? '' : 'hidden'}`}>
                    {renderTree(objConnection, boolActive, {
                      filter: strFilter, onFilter: setStrFilter, refresh: dicRefresh[strId] ?? 0,
                      onStatus: strNext => setDicStatus(dicPrev => (dicPrev[strId] === strNext ? dicPrev : { ...dicPrev, [strId]: strNext })),
                      onError: (strMessage, boolRefresh) => setObjFailure({ id: strId, message: strMessage, refresh: boolRefresh }),
                    })}
                  </div>
                )}
              </section>
            );
          })}
          {arrConnections.length === 0 && !strError && (
            <p className="px-3 py-4 text-muted">No connections yet. Add one to get started.</p>
          )}
        </div>
      </div>
      {objFailure && objFailed && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/35" onMouseDown={() => setObjFailure(null)}>
          <div role="alertdialog" aria-label="Connection error" onMouseDown={objEvent => objEvent.stopPropagation()}
            className="w-[34rem] max-w-[90vw] rounded-md border border-line bg-raised text-[13px] shadow-2xl" style={{ borderTop: '3px solid var(--danger)' }}>
            <div className="flex items-center gap-2.5 border-b border-line py-2 pl-4 pr-2">
              <KindIcon strKind={objFailed.kind} intSize={20} />
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{objFailure.refresh ? 'Refresh error' : 'Connection error'}</h2>
              <button type="button" className="icon-btn" onClick={() => setObjFailure(null)} aria-label="Close" title="Close (Esc)"><IconClose /></button>
            </div>
            <div className="p-4">
              <p className="mb-2.5">
                {objFailure.refresh ? 'Could not reload' : 'Could not connect to'} <b>{objFailed.name}</b>
                <span className="text-muted"> ({KIND_LABEL[objFailed.kind]} · {objFailed.host}:{objFailed.port})</span>
              </p>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger"
                style={{ userSelect: 'text' }}>{objFailure.message}</pre>
            </div>
            <div className="flex items-center gap-2 border-t border-line px-4 py-3">
              <button className="btn" onClick={() => navigator.clipboard.writeText(objFailure.message)}>Copy details</button>
              <span className="flex-1" />
              <button className="btn" onClick={() => { setObjFailure(null); onEdit(objFailed); }}>Edit connection…</button>
              <button className="btn" onClick={() => { setObjFailure(null); retry(objFailed.id); }}>Retry</button>
              <button className="btn btn-primary" autoFocus onClick={() => setObjFailure(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
