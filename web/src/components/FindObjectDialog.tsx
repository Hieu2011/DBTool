import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { findObjectsQuery } from '../sql/dialect';
import type { Connection, DbObjectInfo } from '../types';
import { IconClose, IconSearch } from './icons';

interface Props {
  objConnection: Connection;
  onOpen: (objObject: DbObjectInfo) => void;
  onClose: () => void;
}

const SEARCH_DELAY_MS = 350;

/** Finds tables, views, routines... by a part of their name, in every schema (the tree only filters what it has loaded). */
export function FindObjectDialog({ objConnection, onOpen, onClose }: Props) {
  const [strText, setStrText] = useState('');
  const [arrFound, setArrFound] = useState<DbObjectInfo[] | null>(null);
  const [strError, setStrError] = useState<string | null>(null);
  const [boolBusy, setBoolBusy] = useState(false);
  const [intPicked, setIntPicked] = useState(0);
  const refSearch = useRef(0); // only the latest search may answer
  const boolSupported = findObjectsQuery(objConnection.kind, 'x') !== null;

  useEffect(() => {
    const onKeyDown = (objEvent: KeyboardEvent) => { if (objEvent.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Searches a moment after the typing stops: every search is a catalog query.
  useEffect(() => {
    const strNeedle = strText.trim();
    const intSearch = ++refSearch.current;
    if (strNeedle.length < 2) { setArrFound(null); setStrError(null); setBoolBusy(false); return; }
    const strSql = findObjectsQuery(objConnection.kind, strNeedle);
    if (!strSql) return;
    setBoolBusy(true);
    const intTimer = window.setTimeout(() => {
      api.query(crypto.randomUUID(), objConnection.id, strSql, 300).then(
        objResult => {
          if (intSearch !== refSearch.current) return;
          setArrFound(objResult.rows.map(arrRow => ({
            schema: String(arrRow[0]), name: String(arrRow[1]), type: String(arrRow[2]), signature: arrRow[3] == null ? undefined : String(arrRow[3]),
          })));
          setIntPicked(0);
          setStrError(null);
          setBoolBusy(false);
        },
        objEx => {
          if (intSearch !== refSearch.current) return;
          setStrError(objEx instanceof ApiError ? objEx.detail.message : (objEx as Error).message);
          setBoolBusy(false);
        },
      );
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(intTimer);
  }, [strText, objConnection.id, objConnection.kind]);

  const open = (objObject: DbObjectInfo | undefined) => {
    if (!objObject) return;
    onOpen(objObject);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-start justify-items-center bg-black/35 pt-[12vh]" onMouseDown={onClose}>
      <div role="dialog" aria-label="Find object" onMouseDown={objEvent => objEvent.stopPropagation()}
        className="flex max-h-[70vh] w-[min(44rem,92vw)] flex-col rounded-md border border-line bg-raised shadow-2xl">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
          <label className="relative min-w-0 flex-1">
            <IconSearch intSize={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
            <input className="field h-8 py-0 pl-8" autoFocus placeholder={`Part of a table, view or routine name on ${objConnection.name}`}
              disabled={!boolSupported} value={strText} onChange={objEvent => setStrText(objEvent.target.value)}
              onKeyDown={objEvent => {
                if (objEvent.key === 'ArrowDown') { objEvent.preventDefault(); setIntPicked(intPrev => Math.min(intPrev + 1, (arrFound?.length ?? 1) - 1)); }
                else if (objEvent.key === 'ArrowUp') { objEvent.preventDefault(); setIntPicked(intPrev => Math.max(intPrev - 1, 0)); }
                else if (objEvent.key === 'Enter') open(arrFound?.[intPicked]);
              }} />
          </label>
          <button className="icon-btn icon-btn-sm" onClick={onClose} aria-label="Close"><IconClose intSize={14} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {!boolSupported && <p className="p-3 text-xs text-muted">Finding objects by name works on PostgreSQL and Oracle.</p>}
          {strError && <p className="whitespace-pre-wrap p-3 font-mono text-xs text-danger" style={{ userSelect: 'text' }}>{strError}</p>}
          {boolSupported && !strError && arrFound === null && (
            <p className="p-3 text-xs text-muted">{boolBusy ? 'Searching…' : 'Type at least 2 characters. Every schema you can see is searched.'}</p>
          )}
          {arrFound?.length === 0 && <p className="p-3 text-xs text-muted">No object has that in its name.</p>}
          {arrFound?.map((objItem, intIndex) => (
            <button key={`${objItem.schema}.${objItem.name}.${objItem.type}.${objItem.signature ?? ''}`} onClick={() => open(objItem)}
              onMouseEnter={() => setIntPicked(intIndex)}
              ref={intIndex === intPicked ? objElement => objElement?.scrollIntoView({ block: 'nearest' }) : undefined}
              className={`flex w-full items-center gap-3 border-b border-line/60 px-3 py-1.5 text-left ${intIndex === intPicked ? 'bg-hover' : ''}`}>
              <span className="w-28 shrink-0 truncate text-[10.5px] font-semibold uppercase tracking-wider text-muted">{objItem.type}</span>
              <span className="min-w-0 truncate font-mono text-[13px]">
                <span className="text-muted">{objItem.schema}.</span>{objItem.name}
                {objItem.signature != null && <span className="text-muted">({objItem.signature})</span>}
              </span>
            </button>
          ))}
          {arrFound && arrFound.length >= 300 && <p className="p-2 text-center text-[11px] text-muted">The first 300 are shown: type more of the name.</p>}
        </div>
      </div>
    </div>
  );
}
