import type { Connection } from '../types';
import { KIND_LABEL } from '../types';
import { envVar } from '../envColor';
import { IconDatabase, IconPencil, IconPlus, IconTrash } from './icons';

interface Props {
  arrConnections: Connection[];
  strActiveId: string | null;
  /** Connections that have at least one tab open. */
  hsOpenIds: Set<string>;
  strError: string | null;
  onOpen: (strId: string) => void;
  onNew: () => void;
  onEdit: (objConnection: Connection) => void;
  onDelete: (objConnection: Connection) => void;
  intWidth: number;
  /** Hidden keeps the sidebar mounted, so the object tree keeps what is open and loaded. */
  boolHidden: boolean;
  /** Shown under the list (object tree); the list then keeps to the top part of the sidebar. */
  children?: React.ReactNode;
}

export function ConnectionList({
  arrConnections, strActiveId, hsOpenIds, strError, onOpen, onNew, onEdit, onDelete, intWidth, boolHidden, children,
}: Props) {
  return (
    <aside className={`shrink-0 flex-col bg-bg ${boolHidden ? 'hidden' : 'flex'}`} style={{ width: intWidth }}>
      <div className="flex h-9 shrink-0 items-center justify-between pl-3 pr-1.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Connections</h2>
        <button className="icon-btn icon-btn-sm" onClick={onNew} aria-label="New connection" title="New connection">
          <IconPlus />
        </button>
      </div>

      {strError && (
        <p className="m-3 rounded border border-danger/40 p-2 text-danger">
          Can't reach the local API: {strError}
        </p>
      )}

      <ul className={`overflow-y-auto pb-1 ${children ? 'max-h-[35%] shrink-0' : 'min-h-0 flex-1'}`}>
        {arrConnections.map(objConnection => {
          const boolActive = objConnection.id === strActiveId;
          return (
            <li key={objConnection.id}>
              <div
                tabIndex={0}
                onClick={() => onOpen(objConnection.id)}
                onKeyDown={objEvent => objEvent.key === 'Enter' && onOpen(objConnection.id)}
                onDoubleClick={() => onEdit(objConnection)}
                title={`${KIND_LABEL[objConnection.kind]} ${objConnection.username}@${objConnection.host}/${objConnection.database}`}
                className={`group mx-1.5 flex items-center gap-2.5 rounded-md px-2 py-1.5 ${boolActive ? 'bg-hover' : 'hover:bg-hover'}`}
                style={{ boxShadow: boolActive ? `inset 2px 0 0 ${envVar(objConnection.color)}` : undefined }}
              >
                <span style={{ color: envVar(objConnection.color) }}><IconDatabase intSize={18} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={`truncate ${hsOpenIds.has(objConnection.id) ? 'font-semibold' : 'font-medium'}`}>{objConnection.name}</span>
                    {hsOpenIds.has(objConnection.id) && <span className="status-dot" data-state="open" title="Has open tabs" />}
                  </div>
                  <div className="truncate text-[11px] text-muted">
                    {KIND_LABEL[objConnection.kind]} · {objConnection.username && `${objConnection.username}@`}{objConnection.host}
                  </div>
                </div>
                <div className="hidden gap-0.5 group-hover:flex group-focus-within:flex">
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
            </li>
          );
        })}
        {arrConnections.length === 0 && !strError && (
          <li className="px-3 py-4 text-muted">No connections yet. Add one to get started.</li>
        )}
      </ul>
      {children}
    </aside>
  );
}
