import { useEffect, useState } from 'react';
import type { Connection } from '../types';
import { KIND_LABEL } from '../types';
import { envVar } from '../envColor';
import { IconChevronDown, IconChevronRight, IconClose, IconPencil, IconPlus, IconRefresh, IconTrash, KindIcon } from './icons';

/** What the sidebar hands each tree: the one filter box and the Refresh button of its connection's row. */
export interface TreeControl { filter: string; onFilter: (strFilter: string) => void; refresh: number }

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
  intWidth: number;
  /** Hidden keeps the sidebar mounted, so the object trees keep what is open and loaded. */
  boolHidden: boolean;
  /** The object / key tree of one connection, shown under its row. */
  renderTree: (objConnection: Connection, boolActive: boolean, objControl: TreeControl) => React.ReactNode;
}

const without = (hsSet: Set<string>, strId: string) => { const hsNext = new Set(hsSet); hsNext.delete(strId); return hsNext; };

/**
 * Sidebar: one tree for everything. Each connection is a top-level node with its objects under it, and the whole
 * list scrolls as one (the trees virtualize their rows against this scroller, see useOuterScroll).
 */
export function ConnectionList({
  arrConnections, strActiveId, hsOpenIds, strError, onOpen, onSelect, onNew, onEdit, onDelete, intWidth, boolHidden, renderTree,
}: Props) {
  const [hsExpanded, setHsExpanded] = useState<Set<string>>(new Set());
  // A tree stays mounted once shown: collapsing a connection must not drop what it loaded.
  const [hsMounted, setHsMounted] = useState<Set<string>>(new Set());
  const [strFilter, setStrFilter] = useState('');
  const [dicRefresh, setDicRefresh] = useState<Record<string, number>>({});

  const expand = (strId: string) => {
    setHsExpanded(hsPrev => (hsPrev.has(strId) ? hsPrev : new Set(hsPrev).add(strId)));
    setHsMounted(hsPrev => (hsPrev.has(strId) ? hsPrev : new Set(hsPrev).add(strId)));
  };

  const toggle = (strId: string) => {
    if (hsExpanded.has(strId)) setHsExpanded(hsPrev => without(hsPrev, strId));
    else { expand(strId); onSelect(strId); }
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
                  title={`Name: ${objConnection.name}\n${KIND_LABEL[objConnection.kind]}: ${objConnection.host}:${objConnection.port}${objConnection.database ? `/${objConnection.database}` : ''}${objConnection.username ? `\nUser: ${objConnection.username}` : ''}`}
                  className={`group sticky top-0 z-20 flex h-9 items-center gap-1.5 pl-1.5 pr-1.5 ${boolActive ? 'bg-panel' : 'bg-bg'} hover:bg-hover`}
                  style={{ boxShadow: `inset 3px 0 0 ${boolActive ? envVar(objConnection.color) : 'transparent'}` }}
                >
                  <button className="icon-btn icon-btn-sm h-5 min-w-5 px-0" aria-label={boolExpanded ? 'Collapse' : 'Expand'}
                    onClick={objEvent => { objEvent.stopPropagation(); toggle(strId); }}
                    onDoubleClick={objEvent => objEvent.stopPropagation()}>
                    <Chevron intSize={14} />
                  </button>
                  <KindIcon strKind={objConnection.kind} intSize={17} boolMuted={!boolOpen && !boolExpanded} />
                  <span className={`shrink-0 truncate ${boolOpen ? 'font-semibold' : 'font-medium'}`} style={{ maxWidth: '60%' }}>{objConnection.name}</span>
                  {boolOpen && <span className="status-dot" data-state="open" title="Has open tabs" />}
                  <span className="min-w-0 flex-1 truncate text-[11px] italic text-muted">{objConnection.host}:{objConnection.port}</span>
                  <span className="h-2 w-2 shrink-0 rounded-full group-hover:hidden" style={{ background: envVar(objConnection.color) }} />
                  <div className="hidden gap-0.5 group-hover:flex group-focus-within:flex">
                    {boolExpanded && objConnection.kind !== 'Redis' && (
                      <button className="icon-btn icon-btn-sm" aria-label={`Refresh ${objConnection.name}`} title="Reload the object list"
                        onClick={objEvent => { objEvent.stopPropagation(); setDicRefresh(dicPrev => ({ ...dicPrev, [strId]: (dicPrev[strId] ?? 0) + 1 })); }}>
                        <IconRefresh intSize={14} />
                      </button>
                    )}
                    <button className="icon-btn icon-btn-sm" aria-label={`Edit ${objConnection.name}`} title="Edit"
                      onClick={objEvent => { objEvent.stopPropagation(); onEdit(objConnection); }}>
                      <IconPencil intSize={14} />
                    </button>
                    <button className="icon-btn icon-btn-sm hover:text-danger" aria-label={`Delete ${objConnection.name}`} title="Delete"
                      onClick={objEvent => { objEvent.stopPropagation(); onDelete(objConnection); }}>
                      <IconTrash intSize={14} />
                    </button>
                  </div>
                </div>

                {hsMounted.has(strId) && (
                  <div className={`pl-3 ${boolExpanded ? '' : 'hidden'}`}>
                    {renderTree(objConnection, boolActive, { filter: strFilter, onFilter: setStrFilter, refresh: dicRefresh[strId] ?? 0 })}
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
    </aside>
  );
}
