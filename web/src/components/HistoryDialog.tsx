import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import type { Connection, HistoryEntry } from '../types';
import { IconClose, IconSearch } from './icons';

interface Props {
  objConnection: Connection;
  /** Null: no editor tab is active, so the statement can only open in a new tab. */
  onInsert: ((strSql: string) => void) | null;
  onOpenTab: (strSql: string) => void;
  onClose: () => void;
}

const firstLine = (strSql: string) => strSql.replace(/\s+/g, ' ').slice(0, 200);

const when = (strAt: string) => {
  const dtAt = new Date(strAt);
  const boolToday = dtAt.toDateString() === new Date().toDateString();
  return boolToday
    ? dtAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : dtAt.toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

/** Statements run on one connection, newest first. */
export function HistoryDialog({ objConnection, onInsert, onOpenTab, onClose }: Props) {
  const [arrEntries, setArrEntries] = useState<HistoryEntry[] | null>(null);
  const [strError, setStrError] = useState<string | null>(null);
  const [strFilter, setStrFilter] = useState('');
  const [strSelectedId, setStrSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let boolAlive = true;
    api.history(objConnection.id).then(
      arrLoaded => { if (boolAlive) { setArrEntries(arrLoaded); setStrSelectedId(arrLoaded[0]?.id ?? null); } },
      objEx => { if (boolAlive) setStrError(objEx instanceof ApiError ? objEx.detail.message : (objEx as Error).message); },
    );
    return () => { boolAlive = false; };
  }, [objConnection.id]);

  useEffect(() => {
    const onKeyDown = (objEvent: KeyboardEvent) => { if (objEvent.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const arrShown = useMemo(() => {
    const strNeedle = strFilter.trim().toLowerCase();
    return (arrEntries ?? []).filter(objEntry => !strNeedle || objEntry.sql.toLowerCase().includes(strNeedle));
  }, [arrEntries, strFilter]);

  const objSelected = arrShown.find(objEntry => objEntry.id === strSelectedId) ?? arrShown[0];

  const clear = async () => {
    if (!confirm(`Delete the whole query history of "${objConnection.name}"?`)) return;
    try {
      await api.clearHistory(objConnection.id);
      setArrEntries([]);
    } catch (objEx) {
      setStrError(objEx instanceof ApiError ? objEx.detail.message : (objEx as Error).message);
    }
  };

  const use = (fnUse: (strSql: string) => void) => {
    if (!objSelected) return;
    fnUse(objSelected.sql);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/35" onMouseDown={onClose}>
      <div role="dialog" aria-label="Query history" onMouseDown={objEvent => objEvent.stopPropagation()}
        className="flex h-[min(40rem,85vh)] w-[min(64rem,92vw)] flex-col rounded-md border border-line bg-raised shadow-2xl">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
          <span className="font-medium">Query history</span>
          <span className="text-xs text-muted">{objConnection.name}</span>
          <label className="relative ml-auto w-64">
            <IconSearch intSize={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
            <input className="field h-7 py-0 pl-7 text-xs" placeholder="Search the SQL text" autoFocus
              value={strFilter} onChange={objEvent => setStrFilter(objEvent.target.value)} />
          </label>
          <button className="icon-btn icon-btn-sm" onClick={onClose} aria-label="Close"><IconClose intSize={14} /></button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* list */}
          <div className="w-[26rem] shrink-0 overflow-auto border-r border-line">
            {strError && <p className="p-3 text-xs text-danger">{strError}</p>}
            {!strError && arrEntries === null && <p className="p-3 text-xs text-muted">Loading…</p>}
            {arrEntries !== null && arrShown.length === 0 && (
              <p className="p-3 text-xs text-muted">
                {arrEntries.length === 0 ? 'Nothing yet. Statements you run in an editor are listed here.' : 'No statement matches the search.'}
              </p>
            )}
            {arrShown.map(objEntry => (
              <button key={objEntry.id} onClick={() => setStrSelectedId(objEntry.id)}
                onDoubleClick={() => use(onInsert ?? onOpenTab)}
                className={`block w-full border-b border-line px-3 py-1.5 text-left ${
                  objEntry.id === objSelected?.id ? 'bg-hover' : 'hover:bg-hover'}`}>
                <span className="block truncate font-mono text-xs">{firstLine(objEntry.sql)}</span>
                <span className="mt-0.5 flex gap-3 text-[11px] text-muted">
                  <span>{when(objEntry.at)}</span>
                  <span>{objEntry.elapsedMs.toLocaleString()} ms</span>
                  {objEntry.error
                    ? <span className="text-danger">failed</span>
                    : objEntry.rows != null && <span>{objEntry.rows.toLocaleString()} rows</span>}
                </span>
              </button>
            ))}
          </div>

          {/* selected statement */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-auto p-3" style={{ userSelect: 'text' }}>
              {objSelected && <pre className="whitespace-pre-wrap font-mono text-xs leading-5">{objSelected.sql}</pre>}
              {objSelected?.error && <p className="mt-3 whitespace-pre-wrap font-mono text-xs text-danger">{objSelected.error}</p>}
            </div>
            <div className="flex h-11 shrink-0 items-center gap-1.5 border-t border-line px-3">
              <button className="btn btn-danger h-7" onClick={clear} disabled={!arrEntries?.length}>Clear history</button>
              <div className="ml-auto flex gap-1.5">
                <button className="btn h-7" disabled={!objSelected}
                  onClick={() => { if (objSelected) navigator.clipboard.writeText(objSelected.sql).catch(() => {}); }}>
                  Copy
                </button>
                <button className="btn h-7" disabled={!objSelected} onClick={() => use(onOpenTab)}>Open in new tab</button>
                <button className="btn btn-primary h-7" disabled={!objSelected || !onInsert}
                  title={onInsert ? 'Insert at the cursor of the active editor' : 'No editor tab is active'}
                  onClick={() => { if (onInsert) use(onInsert); }}>
                  Insert into editor
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
