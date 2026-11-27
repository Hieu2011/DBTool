import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { killSessionQuery, sessionsQuery } from '../sql/dialect';
import type { Connection, QueryResult } from '../types';
import { showToast } from '../toast';
import { IconClose, IconRefresh } from './icons';
import { ResultGrid } from './ResultGrid';

interface Props {
  objConnection: Connection;
  onClose: () => void;
}

const errorMessage = (objEx: unknown) => (objEx instanceof ApiError ? objEx.detail.message : (objEx as Error).message);

/** Sessions of the server, the blocked ones first, with a way to end one. What it shows and may do depends on the login's privileges. */
export function SessionsDialog({ objConnection, onClose }: Props) {
  const [objResult, setObjResult] = useState<QueryResult | null>(null);
  const [strError, setStrError] = useState<string | null>(null);
  const [boolBusy, setBoolBusy] = useState(false);
  const [intRow, setIntRow] = useState<number | null>(null);
  const strSql = sessionsQuery(objConnection.kind);
  const boolPostgres = objConnection.kind === 'PostgreSql';

  const load = useCallback(async () => {
    if (!strSql) return;
    setBoolBusy(true);
    try {
      setObjResult(await api.query(crypto.randomUUID(), objConnection.id, strSql, 2000));
      setStrError(null);
      setIntRow(null);
    } catch (objEx) {
      setStrError(errorMessage(objEx));
    } finally {
      setBoolBusy(false);
    }
  }, [objConnection.id, strSql]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onKeyDown = (objEvent: KeyboardEvent) => { if (objEvent.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const arrSelected = intRow !== null ? objResult?.rows[intRow] : undefined;
  // sid / pid, and who it is, for the question asked before ending it
  const strSelected = arrSelected ? `${boolPostgres ? 'pid' : 'sid'} ${arrSelected[0]}${arrSelected[2] ? ` (${arrSelected[boolPostgres ? 1 : 2]})` : ''}` : '';

  const end = async (boolCancel: boolean) => {
    const strKill = arrSelected ? killSessionQuery(objConnection.kind, arrSelected, boolCancel) : null;
    if (!strKill) return;
    if (!confirm(boolCancel
      ? `Cancel the statement session ${strSelected} is running on "${objConnection.name}"?`
      : `Kill session ${strSelected} on "${objConnection.name}"?\n\nIts transaction is rolled back and its connection is closed.`)) return;
    setBoolBusy(true);
    try {
      await api.query(crypto.randomUUID(), objConnection.id, strKill, 1);
      showToast('success', boolCancel ? 'Statement cancelled' : 'Session killed', strSelected);
    } catch (objEx) {
      showToast('error', boolCancel ? 'The statement could not be cancelled' : 'The session could not be killed', errorMessage(objEx));
    }
    await load();
  };

  const intBlocked = objResult ? objResult.rows.filter(arrRow => arrRow[4] !== null && arrRow[4] !== '').length : 0;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/35" onMouseDown={onClose}>
      <div role="dialog" aria-label="Sessions" onMouseDown={objEvent => objEvent.stopPropagation()}
        className="flex h-[min(44rem,88vh)] w-[min(86rem,95vw)] flex-col rounded-md border border-line bg-raised shadow-2xl">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
          <span className="font-medium">Sessions</span>
          <span className="text-xs text-muted">{objConnection.name}</span>
          {objResult && (
            <span className={`text-xs ${intBlocked > 0 ? 'font-semibold text-danger' : 'text-muted'}`}>
              {objResult.rows.length.toLocaleString()} sessions · {intBlocked} blocked
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {boolPostgres && (
              <button className="btn h-7" onClick={() => end(true)} disabled={!arrSelected || boolBusy}
                title="Stops the statement the selected session is running; the session stays connected">Cancel statement</button>
            )}
            <button className="btn h-7 text-danger" onClick={() => end(false)} disabled={!arrSelected || boolBusy}
              title="Ends the selected session: its transaction is rolled back">Kill session</button>
            <button className="btn h-7" onClick={load} disabled={boolBusy || !strSql}><IconRefresh intSize={13} /> Refresh</button>
            <button className="icon-btn icon-btn-sm" onClick={onClose} aria-label="Close"><IconClose intSize={14} /></button>
          </div>
        </div>
        <div className="min-h-0 flex-1 bg-panel">
          {!strSql && <p className="p-4 text-muted">Sessions are listed for PostgreSQL and Oracle.</p>}
          {strError && (
            <p className="whitespace-pre-wrap p-4 font-mono text-xs text-danger" style={{ userSelect: 'text' }}>
              {strError}{'\n\n'}{boolPostgres ? '' : 'Reading V$SESSION needs a privilege this login may not have (SELECT_CATALOG_ROLE or a grant on V_$SESSION).'}
            </p>
          )}
          {!strError && !objResult && strSql && <p className="p-4 text-muted">Loading…</p>}
          {!strError && objResult && <ResultGrid objResult={objResult} onSelectRow={setIntRow} strExportName="sessions" />}
        </div>
        <p className="shrink-0 border-t border-line px-3 py-1.5 text-[11px] text-muted">
          Click a row to select the session. blocked_by is the session holding the lock it waits for: that is the one to look at (or end) first.
        </p>
      </div>
    </div>
  );
}
