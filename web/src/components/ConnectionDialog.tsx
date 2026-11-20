import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { Connection, ConnectionInput, DbKind } from '../types';
import { DEFAULT_PORT, KIND_LABEL } from '../types';
import { ENV_COLORS, envVar } from '../envColor';

export type DialogState = null | { mode: 'new' } | { mode: 'edit'; connection: Connection };

interface Props {
  objState: Exclude<DialogState, null>;
  onClose: () => void;
  onSaved: (objConnection: Connection) => void;
}

const SUPPORTED: DbKind[] = ['PostgreSql', 'Oracle', 'MongoDb', 'Redis'];

const blank = (): ConnectionInput => ({
  id: crypto.randomUUID(),
  name: '',
  kind: 'PostgreSql',
  host: 'localhost',
  port: DEFAULT_PORT.PostgreSql,
  database: '',
  username: '',
  password: '',
  extra: '',
  color: 'slate',
});

export function ConnectionDialog({ objState, onClose, onSaved }: Props) {
  const boolEditing = objState.mode === 'edit';
  const [objForm, setObjForm] = useState<ConnectionInput>(() => {
    if (objState.mode !== 'edit') return blank();
    const { hasPassword: _, ...objRest } = objState.connection;
    return { ...objRest, password: '' };
  });
  const [strBusy, setStrBusy] = useState<'test' | 'save' | null>(null);
  const [objMessage, setObjMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const onKey = (objEvent: KeyboardEvent) => objEvent.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = <K extends keyof ConnectionInput>(strKey: K, objValue: ConnectionInput[K]) =>
    setObjForm(objPrev => ({ ...objPrev, [strKey]: objValue }));

  const changeKind = (strKind: DbKind) =>
    setObjForm(objPrev => ({
      ...objPrev,
      kind: strKind,
      // only move the port if the user hadn't changed it
      port: objPrev.port === DEFAULT_PORT[objPrev.kind] ? DEFAULT_PORT[strKind] : objPrev.port,
    }));

  const test = async () => {
    setStrBusy('test');
    setObjMessage(null);
    try {
      await api.testConnection(objForm);
      setObjMessage({ ok: true, text: 'Connected.' });
    } catch (objEx) {
      setObjMessage({ ok: false, text: objEx instanceof ApiError ? objEx.detail.message : (objEx as Error).message });
    } finally {
      setStrBusy(null);
    }
  };

  const save = async (objEvent: React.FormEvent) => {
    objEvent.preventDefault();
    setStrBusy('save');
    try {
      onSaved(await api.saveConnection({ ...objForm, name: objForm.name.trim() || objForm.host }));
    } catch (objEx) {
      setObjMessage({ ok: false, text: (objEx as Error).message });
      setStrBusy(null);
    }
  };

  const strDbLabel = objForm.kind === 'Oracle' ? 'Service name' : objForm.kind === 'MongoDb' ? 'Default database' : objForm.kind === 'Redis' ? 'Database number' : 'Database';

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/35" onMouseDown={onClose}>
      <form
        onSubmit={save}
        onMouseDown={objEvent => objEvent.stopPropagation()}
        className="w-[30rem] rounded-md border border-line bg-raised shadow-2xl"
        style={{ borderTop: `3px solid ${envVar(objForm.color)}` }}
      >
        <h2 className="border-b border-line px-4 py-3 text-sm font-semibold">
          {boolEditing ? `Edit ${objForm.name}` : 'New connection'}
        </h2>

        <div className="grid grid-cols-[7.5rem_1fr] items-center gap-x-3 gap-y-2.5 p-4">
          <label htmlFor="c-name" className="text-muted">Name</label>
          <input id="c-name" className="field" autoFocus value={objForm.name}
            placeholder="TMS dev" onChange={objEvent => set('name', objEvent.target.value)} />

          <label htmlFor="c-kind" className="text-muted">Type</label>
          <select id="c-kind" className="field" value={objForm.kind}
            onChange={objEvent => changeKind(objEvent.target.value as DbKind)}>
            {(Object.keys(KIND_LABEL) as DbKind[]).map(strKind => (
              <option key={strKind} value={strKind} disabled={!SUPPORTED.includes(strKind)}>
                {KIND_LABEL[strKind]}{SUPPORTED.includes(strKind) ? '' : ' (coming later)'}
              </option>
            ))}
          </select>

          <label htmlFor="c-host" className="text-muted">Host and port</label>
          <div className="flex gap-2">
            <input id="c-host" className="field" value={objForm.host} onChange={objEvent => set('host', objEvent.target.value)} />
            <input aria-label="Port" className="field w-24" inputMode="numeric" value={objForm.port || ''}
              onChange={objEvent => set('port', Number(objEvent.target.value.replace(/\D/g, '')) || 0)} />
          </div>

          <label htmlFor="c-db" className="text-muted">{strDbLabel}</label>
          <input id="c-db" className="field" value={objForm.database}
            placeholder={objForm.kind === 'Oracle' ? 'ORCLPDB1' : objForm.kind === 'MongoDb' ? 'optional' : objForm.kind === 'Redis' ? '0' : 'postgres'}
            onChange={objEvent => set('database', objEvent.target.value)} />

          <label htmlFor="c-user" className="text-muted">User</label>
          <input id="c-user" className="field" autoComplete="off" value={objForm.username}
            onChange={objEvent => set('username', objEvent.target.value)} />

          <label htmlFor="c-pass" className="text-muted">Password</label>
          <input id="c-pass" className="field" type="password" autoComplete="new-password"
            value={objForm.password ?? ''}
            placeholder={objState.mode === 'edit' && objState.connection.hasPassword ? 'Leave empty to keep the saved one' : ''}
            onChange={objEvent => set('password', objEvent.target.value)} />

          <label htmlFor="c-extra" className="text-muted">Driver options</label>
          <input id="c-extra" className="field font-mono text-xs" value={objForm.extra ?? ''}
            placeholder={objForm.kind === 'Oracle' ? 'Connection Timeout=15' : objForm.kind === 'MongoDb' ? 'authSource=admin&tls=true' : objForm.kind === 'Redis' ? 'ssl=true,connectTimeout=5000' : 'Timeout=15;SSL Mode=Prefer'}
            onChange={objEvent => set('extra', objEvent.target.value)} />

          <span className="text-muted">Environment</span>
          <div className="flex gap-1.5" role="radiogroup" aria-label="Environment">
            {ENV_COLORS.map(objColor => (
              <button key={objColor.value} type="button" role="radio" aria-checked={objForm.color === objColor.value}
                onClick={() => set('color', objColor.value)}
                className={`flex items-center gap-1.5 whitespace-nowrap rounded border px-2 py-1 text-xs ${
                  objForm.color === objColor.value ? 'border-fg' : 'border-line text-muted hover:bg-hover'
                }`}>
                <span className="h-2 w-2 rounded-full" style={{ background: envVar(objColor.value) }} />
                {objColor.label}
              </button>
            ))}
          </div>
        </div>

        {objMessage && (
          <p className={`mx-4 mb-3 whitespace-pre-wrap rounded border px-3 py-2 text-xs ${
            objMessage.ok ? 'border-line text-fg' : 'border-danger/40 text-danger'}`}>
            {objMessage.text}
          </p>
        )}

        <div className="flex items-center justify-between border-t border-line px-4 py-3">
          <button type="button" className="btn" onClick={test} disabled={strBusy !== null}>
            {strBusy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          <div className="flex gap-2">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={strBusy !== null}>
              {strBusy === 'save' ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
