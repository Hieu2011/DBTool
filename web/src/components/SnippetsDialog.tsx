import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { Snippet } from '../types';
import { IconClose, IconPlus, IconTrash } from './icons';

interface Props {
  arrInitial: Snippet[];
  /** Null: no editor tab is active. */
  onInsert: ((strBody: string) => void) | null;
  /** The list as the server stored it. */
  onSaved: (arrSnippets: Snippet[]) => void;
  onClose: () => void;
}

const errorMessage = (objEx: unknown) => (objEx instanceof ApiError ? objEx.detail.message : (objEx as Error).message);

/** Edit > Snippets: pieces of SQL typed by prefix in the editor. Nothing is stored until Save. */
export function SnippetsDialog({ arrInitial, onInsert, onSaved, onClose }: Props) {
  const [arrSnippets, setArrSnippets] = useState<Snippet[]>(arrInitial);
  const [strSelectedId, setStrSelectedId] = useState<string | null>(arrInitial[0]?.id ?? null);
  const [boolDirty, setBoolDirty] = useState(false);
  const [boolSaving, setBoolSaving] = useState(false);
  const [strError, setStrError] = useState<string | null>(null);

  const objSelected = arrSnippets.find(objSnippet => objSnippet.id === strSelectedId);

  const close = () => {
    if (boolDirty && !confirm('Close without saving the changes to your snippets?')) return;
    onClose();
  };

  useEffect(() => {
    const onKeyDown = (objEvent: KeyboardEvent) => { if (objEvent.key === 'Escape') close(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const change = (objPatch: Partial<Snippet>) => {
    setArrSnippets(arrSnippets.map(objSnippet => (objSnippet.id === strSelectedId ? { ...objSnippet, ...objPatch } : objSnippet)));
    setBoolDirty(true);
  };

  const add = () => {
    const objNew: Snippet = { id: crypto.randomUUID(), name: 'New snippet', prefix: '', body: '' };
    setArrSnippets([...arrSnippets, objNew]);
    setStrSelectedId(objNew.id);
    setBoolDirty(true);
  };

  const remove = () => {
    if (!objSelected) return;
    const intIndex = arrSnippets.indexOf(objSelected);
    const arrNext = arrSnippets.filter(objSnippet => objSnippet !== objSelected);
    setArrSnippets(arrNext);
    setStrSelectedId(arrNext[Math.min(intIndex, arrNext.length - 1)]?.id ?? null);
    setBoolDirty(true);
  };

  const save = async () => {
    const objBad = arrSnippets.find(objSnippet => !objSnippet.name.trim() || !objSnippet.body.trim());
    if (objBad) {
      setStrSelectedId(objBad.id);
      setStrError('This snippet needs a name and a body.');
      return;
    }
    setBoolSaving(true);
    setStrError(null);
    try {
      const arrStored = await api.saveSnippets(arrSnippets);
      setArrSnippets(arrStored);
      setBoolDirty(false);
      onSaved(arrStored);
    } catch (objEx) {
      setStrError(errorMessage(objEx));
    } finally {
      setBoolSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/35" onMouseDown={close}>
      <div role="dialog" aria-label="Snippets" onMouseDown={objEvent => objEvent.stopPropagation()}
        className="flex h-[min(36rem,85vh)] w-[min(56rem,92vw)] flex-col rounded-md border border-line bg-raised shadow-2xl">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
          <span className="font-medium">Snippets</span>
          <span className="text-xs text-muted">Type a prefix in the editor and pick the snippet from the suggestions</span>
          <button className="icon-btn icon-btn-sm ml-auto" onClick={close} aria-label="Close"><IconClose intSize={14} /></button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* list */}
          <div className="flex w-60 shrink-0 flex-col border-r border-line">
            <div className="min-h-0 flex-1 overflow-auto">
              {arrSnippets.length === 0 && <p className="p-3 text-xs text-muted">No snippets. Add one below.</p>}
              {arrSnippets.map(objSnippet => (
                <button key={objSnippet.id} onClick={() => setStrSelectedId(objSnippet.id)}
                  className={`flex w-full items-baseline gap-2 border-b border-line px-3 py-1.5 text-left ${
                    objSnippet.id === strSelectedId ? 'bg-hover' : 'hover:bg-hover'}`}>
                  <span className="min-w-0 flex-1 truncate">{objSnippet.name || '(no name)'}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted">{objSnippet.prefix}</span>
                </button>
              ))}
            </div>
            <div className="flex h-11 shrink-0 items-center gap-1.5 border-t border-line px-2">
              <button className="btn h-7" onClick={add}><IconPlus intSize={13} /> New</button>
              <button className="btn btn-danger h-7" onClick={remove} disabled={!objSelected}><IconTrash intSize={13} /> Delete</button>
            </div>
          </div>

          {/* editor */}
          <div className="flex min-w-0 flex-1 flex-col">
            {objSelected
              ? (
                <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
                  <div className="flex gap-2">
                    <label className="flex-1 text-xs text-muted">Name
                      <input className="field mt-1 text-[13px] text-fg" value={objSelected.name} maxLength={100}
                        onChange={objEvent => change({ name: objEvent.target.value })} />
                    </label>
                    <label className="w-40 text-xs text-muted">Prefix (what you type)
                      <input className="field mt-1 font-mono text-[13px] text-fg" value={objSelected.prefix} maxLength={100} spellCheck={false}
                        onChange={objEvent => change({ prefix: objEvent.target.value.replace(/\s/g, '') })} />
                    </label>
                  </div>
                  <label className="flex min-h-0 flex-1 flex-col text-xs text-muted">SQL
                    <textarea className="field mt-1 min-h-0 flex-1 resize-none font-mono text-xs leading-5 text-fg" spellCheck={false}
                      value={objSelected.body} onChange={objEvent => change({ body: objEvent.target.value })} />
                  </label>
                  <p className="text-[11px] leading-4 text-muted">
                    Tab stops: <code className="font-mono">{'${1:table}'}</code>, <code className="font-mono">$2</code>…; <code className="font-mono">$0</code> is
                    where the cursor ends. The same number twice is typed once. Write <code className="font-mono">\$</code> for a real dollar sign.
                  </p>
                </div>
              )
              : <p className="flex-1 p-3 text-xs text-muted">Pick a snippet on the left, or add a new one.</p>}

            <div className="flex h-11 shrink-0 items-center gap-1.5 border-t border-line px-3">
              {strError && <span className="min-w-0 truncate text-xs text-danger" title={strError}>{strError}</span>}
              <div className="ml-auto flex shrink-0 gap-1.5">
                <button className="btn h-7" disabled={!objSelected?.body.trim() || !onInsert || boolDirty}
                  title={!onInsert ? 'No editor tab is active' : boolDirty ? 'Save your changes first' : 'Insert at the cursor of the active editor'}
                  onClick={() => { if (onInsert && objSelected) { onInsert(objSelected.body); onClose(); } }}>
                  Insert into editor
                </button>
                <button className="btn btn-primary h-7" onClick={save} disabled={!boolDirty || boolSaving}>
                  {boolSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
