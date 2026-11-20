import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import type { Connection, DbObjectInfo, QueryError, QueryResult, RoutineInfo, RoutineParameter, RoutineResult } from '../types';
import { envVar } from '../envColor';
import { ResultGrid } from './ResultGrid';
import { DatePickerButton, isDateType } from './DatePicker';
import { IconPlay, IconStop } from './icons';

interface Props {
  objConnection: Connection;
  objRoutine: DbObjectInfo;
  boolActive: boolean;
}

type InfoState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; info: RoutineInfo };

type RunState =
  | { status: 'idle' }
  | { status: 'running'; queryId: string; startedAt: number }
  | { status: 'done'; result: RoutineResult }
  | { status: 'error'; error: QueryError };

/** What the user typed for one parameter. isNull wins over value. */
interface ArgumentInput { value: string; isNull: boolean }

const MAX_ROWS = [100, 1000, 10000];
const OUTPUTS_TAB = 'Outputs';

const toQueryError = (objEx: unknown): QueryError =>
  objEx instanceof ApiError ? objEx.detail : { message: (objEx as Error).message };

const isInput = (objParameter: RoutineParameter) => objParameter.mode === 'IN' || objParameter.mode === 'INOUT';

/** Form to fill in a procedure's / function's parameters, run it, and see the cursors and OUT values it returns. */
export function RoutineRunner({ objConnection, objRoutine, boolActive }: Props) {
  const [objInfo, setObjInfo] = useState<InfoState>({ status: 'loading' });
  const [dicInputs, setDicInputs] = useState<Record<number, ArgumentInput>>({});
  const [objRun, setObjRun] = useState<RunState>({ status: 'idle' });
  const [strActive, setStrActive] = useState<string | null>(null);
  const [intMaxRows, setIntMaxRows] = useState(1000);
  const [lngNow, setLngNow] = useState(Date.now());

  const { schema: strSchema, name: strName, type: strType, signature: strSignature } = objRoutine;

  useEffect(() => {
    let boolStale = false;
    setObjInfo({ status: 'loading' });
    api.routineInfo(objConnection.id, { schema: strSchema, name: strName, type: strType, signature: strSignature }).then(
      objLoaded => { if (!boolStale) setObjInfo({ status: 'done', info: objLoaded }); },
      objEx => { if (!boolStale) setObjInfo({ status: 'error', message: toQueryError(objEx).message }); },
    );
    return () => { boolStale = true; };
  }, [objConnection.id, strSchema, strName, strType, strSignature]);

  useEffect(() => {
    if (objRun.status !== 'running') return;
    const intTimer = setInterval(() => setLngNow(Date.now()), 100);
    return () => clearInterval(intTimer);
  }, [objRun.status]);

  const arrParameters = objInfo.status === 'done' ? objInfo.info.parameters : [];
  const boolRunning = objRun.status === 'running';

  // A parameter nobody touched is sent as NULL.
  const inputOf = (objParameter: RoutineParameter): ArgumentInput => dicInputs[objParameter.position] ?? { value: '', isNull: true };
  const setInput = (objParameter: RoutineParameter, objInput: ArgumentInput) =>
    setDicInputs(dicPrev => ({ ...dicPrev, [objParameter.position]: objInput }));

  const execute = async () => {
    if (objInfo.status !== 'done' || boolRunning) return;
    const strQueryId = crypto.randomUUID();
    setObjRun({ status: 'running', queryId: strQueryId, startedAt: Date.now() });
    setLngNow(Date.now());
    try {
      const arrArguments = arrParameters.filter(isInput).map(objParameter => {
        const objInput = inputOf(objParameter);
        return { name: objParameter.name, position: objParameter.position, value: objInput.isNull ? null : objInput.value };
      });
      const objResult = await api.executeRoutine(strQueryId, objConnection.id, objRoutine, arrArguments, intMaxRows);
      setObjRun({ status: 'done', result: objResult });
      setStrActive(null);
    } catch (objEx) {
      setObjRun({ status: 'error', error: toQueryError(objEx) });
    }
  };

  const stop = () => {
    if (objRun.status === 'running') api.cancel(objRun.queryId).catch(() => {});
  };

  const objResult = objRun.status === 'done' ? objRun.result : undefined;

  // OUT values shown through the same grid as the cursors.
  const objOutputs = useMemo<QueryResult | undefined>(() => (objResult && objResult.outputs.length > 0
    ? {
      columns: [{ name: 'name', dataType: '' }, { name: 'value', dataType: '' }],
      rows: objResult.outputs.map(objOutput => [objOutput.name, objOutput.value ?? null]),
      recordsAffected: -1, truncated: false, elapsedMs: 0,
    }
    : undefined), [objResult]);

  const arrTabs = objResult ? [...objResult.results.map(objSection => objSection.title), ...(objOutputs ? [OUTPUTS_TAB] : [])] : [];
  const strShown = strActive && arrTabs.includes(strActive) ? strActive : arrTabs[0];
  const objShown = strShown === OUTPUTS_TAB ? objOutputs : objResult?.results.find(objSection => objSection.title === strShown)?.result;

  return (
    <section className={`absolute inset-0 flex-col bg-panel ${boolActive ? 'flex' : 'hidden'}`}>
      <form className="contents" onSubmit={objEvent => { objEvent.preventDefault(); execute(); }}>
        <div className="flex h-10 shrink-0 items-center gap-1 overflow-hidden border-b border-line px-2"
          style={{ boxShadow: `inset 3px 0 0 ${envVar(objConnection.color)}` }}>
          <button type="submit" className="btn btn-primary" disabled={boolRunning || objInfo.status !== 'done'}
            title="Run with the values below (Enter)">
            <IconPlay intSize={13} /> Execute
          </button>
          <button type="button" className={`icon-btn ${boolRunning ? 'text-danger' : ''}`} onClick={stop} disabled={!boolRunning}
            aria-label="Stop" title="Stop">
            <IconStop intSize={14} />
          </button>
          <span className="toolbar-sep" />
          <span className="text-xs text-muted">{strType}</span>
          <span className="truncate px-1 font-medium" title={`${strSchema}.${strName}`}>
            {strSchema}.{strName}
          </span>
          <label className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted" title="Rows fetched per cursor">
            Limit
            <select className="field h-[26px] w-auto py-0 text-xs" value={intMaxRows} onChange={objEvent => setIntMaxRows(Number(objEvent.target.value))}>
              {MAX_ROWS.map(intCount => <option key={intCount} value={intCount}>{intCount.toLocaleString()}</option>)}
            </select>
          </label>
        </div>

        {/* parameters */}
        <div className="max-h-[45%] shrink-0 overflow-auto border-b border-line px-3 py-2.5">
          {objInfo.status === 'loading' && <p className="text-muted">Loading parameters…</p>}
          {objInfo.status === 'error' && (
            <p className="whitespace-pre-wrap font-mono text-xs text-danger" style={{ userSelect: 'text' }}>{objInfo.message}</p>
          )}
          {objInfo.status === 'done' && arrParameters.length === 0 && <p className="text-muted">No parameters. Press Execute to run it.</p>}
          {arrParameters.length > 0 && (
            <div className="grid grid-cols-[minmax(7rem,16rem)_minmax(5rem,12rem)_minmax(8rem,28rem)_auto] items-center gap-x-3 gap-y-1.5">
              {arrParameters.map(objParameter => {
                const objInput = inputOf(objParameter);
                const strInputId = `routine-arg-${objParameter.position}`;
                return (
                  <div key={objParameter.position} className="contents">
                    <label htmlFor={strInputId} className="flex min-w-0 items-center gap-2">
                      <span className="w-12 shrink-0 text-[10px] font-semibold tracking-wide text-muted">{objParameter.mode}</span>
                      <span className="truncate" title={objParameter.name}>{objParameter.name}</span>
                    </label>
                    <span className="truncate font-mono text-[11px] text-muted" title={objParameter.dataType}>{objParameter.dataType.toLowerCase()}</span>
                    {isInput(objParameter)
                      ? (
                        <>
                          <div className="flex min-w-0 items-center gap-1">
                            <input id={strInputId} className="field h-7 min-w-0 flex-1 font-mono text-xs" value={objInput.isNull ? '' : objInput.value}
                              placeholder={objInput.isNull ? 'NULL' : isDateType(objParameter.dataType) ? 'yyyy-MM-dd HH:mm:ss' : ''}
                              onChange={objEvent => setInput(objParameter, { value: objEvent.target.value, isNull: false })} />
                            {isDateType(objParameter.dataType) && (
                              <DatePickerButton strValue={objInput.isNull ? '' : objInput.value}
                                boolDateOnly={objConnection.kind === 'PostgreSql' && objParameter.dataType.toLowerCase() === 'date'}
                                onPick={strPicked => setInput(objParameter, { value: strPicked, isNull: false })} />
                            )}
                          </div>
                          <label className="flex items-center gap-1 whitespace-nowrap text-xs text-muted" title="Send SQL NULL">
                            <input type="checkbox" checked={objInput.isNull}
                              onChange={objEvent => setInput(objParameter, { value: objInput.value, isNull: objEvent.target.checked })} />
                            NULL
                          </label>
                        </>
                      )
                      : <span className="col-span-2 text-xs text-muted">returned after execution</span>}
                  </div>
                );
              })}
            </div>
          )}
          {objInfo.status === 'done' && (
            <p className="mt-2 text-[11px] text-muted">
              Values are converted to the parameter's type; dates as yyyy-MM-dd HH:mm:ss. Runs on its own connection and commits.
            </p>
          )}
        </div>
      </form>

      {/* results */}
      <div className="flex min-h-0 flex-1 flex-col">
        {arrTabs.length > 1 && (
          <div className="flex h-7 shrink-0 items-end gap-px overflow-x-auto border-b border-line px-2" role="tablist">
            {arrTabs.map(strTab => (
              <button key={strTab} role="tab" aria-selected={strTab === strShown} onClick={() => setStrActive(strTab)}
                className={`h-6 whitespace-nowrap rounded-t border border-b-0 px-2 text-xs ${
                  strTab === strShown ? 'border-line bg-panel' : 'border-transparent text-muted hover:bg-hover'}`}>
                {strTab}
              </button>
            ))}
          </div>
        )}
        <div className="min-h-0 flex-1">
          {objShown && <ResultGrid key={strShown} objResult={objShown} />}
          {objResult && arrTabs.length === 0 && <p className="p-4 text-muted">Executed. It returned no rows and no values.</p>}
          {objRun.status === 'error' && (
            <p className="whitespace-pre-wrap p-4 font-mono text-xs text-danger" style={{ userSelect: 'text' }}>
              {objRun.error.code && <strong>{objRun.error.code}: </strong>}{objRun.error.message}
            </p>
          )}
          {objRun.status === 'idle' && <p className="p-4 text-muted">Fill in the parameters and press Execute. Returned cursors open here.</p>}
          {boolRunning && <p className="p-4 text-muted">Running…</p>}
        </div>
      </div>

      <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-bg px-3 text-xs text-muted">
        {objRun.status === 'running' && <span>Running for {((lngNow - objRun.startedAt) / 1000).toFixed(1)} s</span>}
        {objShown && (
          <span>
            {objShown.rows.length.toLocaleString()} rows
            {objShown.truncated && ` (stopped at ${intMaxRows.toLocaleString()}, more rows exist)`}
          </span>
        )}
        {objResult && <span>{objResult.elapsedMs.toLocaleString()} ms</span>}
        {objRun.status === 'error' && <span className="text-danger">Execution failed</span>}
        <span className="ml-auto truncate">{objConnection.name}</span>
      </footer>
    </section>
  );
}
