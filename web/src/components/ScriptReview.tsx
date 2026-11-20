import { useState } from 'react';
import { api, ApiError } from '../api';
import type { Connection } from '../types';

interface Props {
  objConnection: Connection;
  /** Statements without a trailing ';', run one by one in this order. */
  arrScript: string[];
  /** Shown in red above the script, e.g. for drops. */
  strWarning?: string;
  onBack: () => void;
  /** Statements ran: all of them (true), or only those before a failure (false). The caller reloads the object. */
  onApplied: (boolAll: boolean) => void;
}

type RunState =
  | { status: 'review' }
  | { status: 'running'; done: number }
  | { status: 'failed'; done: number; statement: string; message: string };

const errorMessage = (objEx: unknown) => (objEx instanceof ApiError ? objEx.detail.message : (objEx as Error).message);

/** Last stop before DDL runs: shows the script, runs it on request, stops at the first error. */
export function ScriptReview({ objConnection, arrScript, strWarning, onBack, onApplied }: Props) {
  const [objRun, setObjRun] = useState<RunState>({ status: 'review' });
  const boolBusy = objRun.status === 'running';
  const strCount = `${arrScript.length} ${arrScript.length === 1 ? 'statement' : 'statements'}`;

  const run = async () => {
    for (const [intIndex, strStatement] of arrScript.entries()) {
      setObjRun({ status: 'running', done: intIndex });
      try {
        await api.query(crypto.randomUUID(), objConnection.id, strStatement, 1);
      } catch (objEx) {
        setObjRun({ status: 'failed', done: intIndex, statement: strStatement, message: errorMessage(objEx) });
        return;
      }
    }
    onApplied(true);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 text-xs">
        <span className="font-medium">Review changes</span>
        <span className="text-muted">{strCount} on {objConnection.name}</span>
        <div className="ml-auto flex gap-1.5">
          {objRun.status === 'failed'
            ? <button className="btn h-6 px-2" onClick={() => onApplied(false)}>Close and reload</button>
            : (
              <>
                <button className="btn h-6 px-2" onClick={onBack} disabled={boolBusy}>Back</button>
                <button className="btn btn-primary h-6 px-2" onClick={run} disabled={boolBusy}>
                  {boolBusy ? `Running ${objRun.done + 1} of ${arrScript.length}…` : `Run ${strCount}`}
                </button>
              </>
            )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3" style={{ userSelect: 'text' }}>
        {strWarning && objRun.status === 'review' && <p className="mb-2 text-xs text-danger">{strWarning}</p>}
        {objRun.status === 'failed' && (
          <div className="mb-3 text-xs text-danger">
            <p>{objRun.done} of {arrScript.length} statements ran. They are not rolled back. This one failed:</p>
            <pre className="mt-1 whitespace-pre-wrap font-mono">{objRun.statement}</pre>
            <p className="mt-1 whitespace-pre-wrap font-mono">{objRun.message}</p>
          </div>
        )}
        <pre className="whitespace-pre-wrap font-mono text-xs leading-5">{arrScript.map(strStatement => `${strStatement};`).join('\n')}</pre>
      </div>
    </div>
  );
}
