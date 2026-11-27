import { useEffect, useState } from 'react';
import { IconClose, IconPlay } from './icons';

interface Props {
  /** Names in the order they appear; raw = Oracle &name, pasted into the text as typed. */
  arrVariables: { name: string; raw: boolean }[];
  /** What was typed last time, by upper-case name. */
  dicLast: Map<string, string>;
  /** Null: cancelled. */
  onDone: (dicValues: Map<string, string> | null) => void;
}

/** Asks a value for every :name / &name of the statements about to run. */
export function BindDialog({ arrVariables, dicLast, onDone }: Props) {
  const [dicValues, setDicValues] = useState(() => new Map(arrVariables.map(objItem => [objItem.name.toUpperCase(), dicLast.get(objItem.name.toUpperCase()) ?? ''])));

  useEffect(() => {
    const onKeyDown = (objEvent: KeyboardEvent) => { if (objEvent.key === 'Escape') onDone(null); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onDone]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" onMouseDown={objEvent => { if (objEvent.target === objEvent.currentTarget) onDone(null); }}>
      <form className="w-[30rem] max-w-[92vw] rounded-lg border border-line bg-panel shadow-xl" aria-label="Variables"
        onSubmit={objEvent => { objEvent.preventDefault(); onDone(dicValues); }}>
        <div className="flex h-10 items-center border-b border-line px-4">
          <span className="font-medium">Variables</span>
          <span className="ml-2 text-xs text-muted">{arrVariables.length} in the statement{arrVariables.length === 1 ? '' : 's'} to run</span>
          <button type="button" className="icon-btn icon-btn-sm ml-auto" aria-label="Close" onClick={() => onDone(null)}><IconClose intSize={13} /></button>
        </div>
        <div className="grid max-h-[55vh] grid-cols-[minmax(6rem,12rem)_1fr] items-center gap-x-3 gap-y-2 overflow-auto px-4 py-3">
          {arrVariables.map((objItem, intIndex) => {
            const strKey = objItem.name.toUpperCase();
            return (
              <label key={strKey} className="contents">
                <span className="truncate font-mono text-xs" title={objItem.name}>{objItem.raw ? '&' : ':'}{objItem.name}</span>
                <input className="field h-7 font-mono text-xs" autoFocus={intIndex === 0} value={dicValues.get(strKey) ?? ''}
                  placeholder={objItem.raw ? 'text put in as typed' : 'NULL'}
                  onChange={objEvent => setDicValues(dicPrev => new Map(dicPrev).set(strKey, objEvent.target.value))} />
              </label>
            );
          })}
        </div>
        <p className="px-4 pb-2 text-[11px] text-muted">
          A number stays a number, a date is yyyy-MM-dd [HH:mm:ss], empty is NULL, anything else is quoted as text. Start with = to put an expression in as typed (=SYSDATE).
        </p>
        <div className="flex justify-end gap-2 border-t border-line bg-bg px-4 py-2.5">
          <button type="button" className="btn" onClick={() => onDone(null)}>Cancel</button>
          <button type="submit" className="btn btn-primary"><IconPlay intSize={12} /> Run</button>
        </div>
      </form>
    </div>
  );
}
