import { useState } from 'react';
import { api, ApiError } from '../api';
import { redisQuote } from '../sql/dialect';
import type { Connection, QueryResult } from '../types';
import { ResultGrid } from './ResultGrid';

interface Props {
  objConnection: Connection;
  /** Logical database the key lives in. */
  intDatabase: number;
  strKey: string;
  /** STRING, HASH, LIST, SET, ZSET, STREAM (anything else is shown read-only). */
  strType: string;
  /** The Value grid of the key viewer. */
  objValue: QueryResult;
  /** Seconds left, null when the key does not expire. */
  intTtl: number | null;
  /** A change was written: the caller reloads the key. */
  onChanged: () => void;
}

type FormMode = 'add' | 'edit' | 'ttl';
interface FormState { mode: FormMode; first: string; second: string; atStart: boolean }

const EDITABLE = ['STRING', 'HASH', 'LIST', 'SET', 'ZSET', 'STREAM'];
/** [label of the first input, label of the second] per type; '' = no such input. */
const FIELDS: Record<string, [string, string]> = {
  STRING: ['', 'Value'], HASH: ['Field', 'Value'], LIST: ['', 'Value'], SET: ['', 'Member'], ZSET: ['Score', 'Member'],
  STREAM: ['', 'Fields'],
};

const errorMessage = (objEx: unknown) => (objEx instanceof ApiError ? objEx.detail.message : (objEx as Error).message);

/** False for text the viewer cut short or could not decode: writing it back would damage the value. */
const isWhole = (objCell: unknown) => {
  if (objCell === null || objCell === undefined) return true;
  const strText = String(objCell);
  return !strText.includes('�') && !(strText.length > 200_000 && strText.endsWith('…'));
};

/** Value grid of a Redis key with add / edit / delete of its elements and its TTL. Every change shows its commands first. */
export function RedisValueEditor({ objConnection, intDatabase, strKey, strType, objValue, intTtl, onChanged }: Props) {
  const [intRow, setIntRow] = useState<number | null>(strType === 'STRING' ? 0 : null);
  const [objForm, setObjForm] = useState<FormState | null>(null);
  const [boolBusy, setBoolBusy] = useState(false);
  const [strError, setStrError] = useState<string | null>(null);

  const strQuotedKey = redisQuote(strKey);
  const arrRow = intRow === null ? undefined : objValue.rows[intRow];
  const boolEditable = EDITABLE.includes(strType);
  const boolRowWhole = !!arrRow && arrRow.every(isWhole);
  const text = (objCell: unknown) => (objCell === null || objCell === undefined ? '' : String(objCell));

  /** The commands a form (or a delete) runs, in order. Empty: nothing to do yet. */
  const commandsFor = (strMode: FormMode | 'delete', objInput: FormState | null): string[] => {
    const strFirst = objInput?.first ?? '';
    const strSecond = objInput?.second ?? '';
    if (strMode === 'ttl') {
      if (strFirst.trim() === '') return [`PERSIST ${strQuotedKey}`];
      return /^\d+$/.test(strFirst.trim()) && Number(strFirst) > 0 ? [`EXPIRE ${strQuotedKey} ${strFirst.trim()}`] : [];
    }
    const strOld = text(arrRow?.[0]);
    switch (strType) {
      case 'STRING':
        return [`SET ${strQuotedKey} ${redisQuote(strSecond)} KEEPTTL`];
      case 'HASH':
        if (strMode === 'delete') return [`HDEL ${strQuotedKey} ${redisQuote(strOld)}`];
        return strFirst === '' ? [] : [`HSET ${strQuotedKey} ${redisQuote(strFirst)} ${redisQuote(strSecond)}`];
      case 'LIST': {
        // Redis cannot delete by index: mark the element, then remove the mark.
        const strMark = `__dbstudio_deleted_${crypto.randomUUID()}__`;
        if (strMode === 'delete') return [`LSET ${strQuotedKey} ${strOld} ${strMark}`, `LREM ${strQuotedKey} 1 ${strMark}`];
        if (strMode === 'edit') return [`LSET ${strQuotedKey} ${strOld} ${redisQuote(strSecond)}`];
        return [`${objInput?.atStart ? 'LPUSH' : 'RPUSH'} ${strQuotedKey} ${redisQuote(strSecond)}`];
      }
      case 'SET':
        if (strMode === 'delete') return [`SREM ${strQuotedKey} ${redisQuote(strOld)}`];
        if (strMode === 'edit') return strSecond === strOld ? [] : [`SREM ${strQuotedKey} ${redisQuote(strOld)}`, `SADD ${strQuotedKey} ${redisQuote(strSecond)}`];
        return [`SADD ${strQuotedKey} ${redisQuote(strSecond)}`];
      case 'ZSET': {
        if (strMode === 'delete') return [`ZREM ${strQuotedKey} ${redisQuote(strOld)}`];
        if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$|^[-+]?inf$/i.test(strFirst.trim())) return [];
        const strAdd = `ZADD ${strQuotedKey} ${strFirst.trim()} ${redisQuote(strSecond)}`;
        return strMode === 'edit' && strSecond !== strOld ? [`ZREM ${strQuotedKey} ${redisQuote(strOld)}`, strAdd] : [strAdd];
      }
      case 'STREAM':
        if (strMode === 'delete') return [`XDEL ${strQuotedKey} ${strOld}`];
        // Typed as in the console: field value field value...
        return strSecond.trim() === '' ? [] : [`XADD ${strQuotedKey} * ${strSecond.trim().replace(/\s*\n\s*/g, ' ')}`];
      default:
        return [];
    }
  };

  /** Runs the commands in the key's database, on a session of their own. */
  const run = async (arrCommands: string[]) => {
    const strSessionId = crypto.randomUUID();
    const send = (strCommand: string) => api.query(crypto.randomUUID(), objConnection.id, strCommand, 1, strSessionId);
    setBoolBusy(true);
    setStrError(null);
    try {
      await send(`SELECT ${intDatabase}`);
      for (const strCommand of arrCommands) {
        try {
          await send(strCommand);
        } catch (objEx) {
          // Before Redis 6 SET has no KEEPTTL: write, then put the expiry back.
          if (!strCommand.endsWith(' KEEPTTL') || !/syntax/i.test(errorMessage(objEx))) throw objEx;
          await send(strCommand.slice(0, -' KEEPTTL'.length));
          if (intTtl !== null && intTtl > 0) await send(`EXPIRE ${strQuotedKey} ${intTtl}`);
        }
      }
      setObjForm(null);
      onChanged();
    } catch (objEx) {
      setStrError(errorMessage(objEx));
    } finally {
      setBoolBusy(false);
      api.closeSession(strSessionId).catch(() => {});
    }
  };

  const open = (strMode: FormMode) => {
    setStrError(null);
    if (strMode === 'ttl') return setObjForm({ mode: 'ttl', first: intTtl === null ? '' : String(intTtl), second: '', atStart: false });
    if (strMode === 'add') return setObjForm({ mode: 'add', first: '', second: '', atStart: false });
    // Columns per type: string [value], hash [field, value], list [index, value], set [member], zset [member, score].
    const dicEdit: Record<string, [string, string]> = {
      STRING: ['', text(arrRow?.[0])], HASH: [text(arrRow?.[0]), text(arrRow?.[1])], LIST: ['', text(arrRow?.[1])],
      SET: ['', text(arrRow?.[0])], ZSET: [text(arrRow?.[1]), text(arrRow?.[0])],
    };
    const [strFirst, strSecond] = dicEdit[strType] ?? ['', ''];
    setObjForm({ mode: 'edit', first: strFirst, second: strSecond, atStart: false });
  };

  const remove = () => {
    const arrCommands = commandsFor('delete', null);
    if (arrCommands.length > 0 && confirm(`This runs:\n\n${arrCommands.join('\n')}\n\nDelete the selected element?`)) run(arrCommands);
  };

  const arrPreview = objForm ? commandsFor(objForm.mode, objForm) : [];
  const [strFirstLabel, strSecondLabel] = objForm?.mode === 'ttl' ? ['Seconds', ''] : FIELDS[strType] ?? ['', ''];
  const boolCollection = boolEditable && strType !== 'STRING';
  const strRowHint = !arrRow ? 'Click a row first' : !boolRowWhole ? 'This element is too long or not text: change it from the console' : undefined;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-3 text-xs">
        {strType === 'STRING' && (
          <button className="btn h-6 px-2" onClick={() => open('edit')} disabled={boolBusy || !boolRowWhole} title={strRowHint}>Edit value…</button>
        )}
        {boolCollection && (
          <>
            <button className="btn h-6 px-2" onClick={() => open('add')} disabled={boolBusy}>Add…</button>
            {strType !== 'STREAM' && (
              <button className="btn h-6 px-2" onClick={() => open('edit')} disabled={boolBusy || !arrRow || !boolRowWhole} title={strRowHint}>Edit…</button>
            )}
            <button className="btn btn-danger h-6 px-2" onClick={remove} disabled={boolBusy || !arrRow || !boolRowWhole} title={strRowHint}>Delete</button>
          </>
        )}
        <span className="toolbar-sep" />
        <button className="btn h-6 px-2" onClick={() => open('ttl')} disabled={boolBusy} title="Set or remove the expiry of the key">
          TTL: {intTtl === null ? 'none' : `${intTtl.toLocaleString()} s`}…
        </button>
        {objValue.truncated && <span className="ml-auto truncate text-muted">Only the first {objValue.rows.length.toLocaleString()} elements are shown</span>}
      </div>

      {objForm && (
        <div className="flex shrink-0 flex-col gap-1.5 border-b border-line bg-bg px-3 py-2 text-xs">
          {strFirstLabel && (
            <label className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-muted">{strFirstLabel}</span>
              <input className="field h-6 w-80 font-mono text-xs" value={objForm.first} autoFocus
                readOnly={objForm.mode === 'edit' && strType === 'HASH'}
                placeholder={objForm.mode === 'ttl' ? 'empty = never expires' : ''}
                onChange={objEvent => setObjForm({ ...objForm, first: objEvent.target.value })} />
            </label>
          )}
          {strSecondLabel && (
            <label className="flex items-start gap-2">
              <span className="w-14 shrink-0 pt-1 text-muted">{strSecondLabel}</span>
              <textarea className="field h-20 min-w-0 flex-1 resize-y py-1 font-mono text-xs" value={objForm.second} autoFocus={!strFirstLabel}
                spellCheck={false} placeholder={strType === 'STREAM' ? 'field value field value … (quote texts with spaces)' : ''}
                onChange={objEvent => setObjForm({ ...objForm, second: objEvent.target.value })} />
            </label>
          )}
          {objForm.mode === 'add' && strType === 'LIST' && (
            <label className="flex items-center gap-1.5 pl-16 text-muted">
              <input type="checkbox" checked={objForm.atStart} onChange={objEvent => setObjForm({ ...objForm, atStart: objEvent.target.checked })} />
              Add at the start of the list
            </label>
          )}
          <div className="flex items-start gap-2">
            <span className="w-14 shrink-0 text-muted">Runs</span>
            <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-muted" style={{ userSelect: 'text' }}>
              {arrPreview.length > 0
                ? arrPreview.map(strCommand => (strCommand.length > 300 ? `${strCommand.slice(0, 300)}…` : strCommand)).join('\n')
                : 'Nothing yet: fill in the fields.'}
            </code>
            <button className="btn btn-primary h-6 shrink-0 px-3" disabled={boolBusy || arrPreview.length === 0} onClick={() => run(arrPreview)}>Save</button>
            <button className="btn h-6 shrink-0 px-2" disabled={boolBusy} onClick={() => setObjForm(null)}>Cancel</button>
          </div>
        </div>
      )}
      {strError && (
        <p className="shrink-0 whitespace-pre-wrap border-b border-line px-3 py-1.5 font-mono text-xs text-danger" style={{ userSelect: 'text' }}>{strError}</p>
      )}

      <div className="min-h-0 flex-1">
        <ResultGrid objResult={objValue} onSelectRow={setIntRow} strExportName={`${strKey}-value`} />
      </div>
    </div>
  );
}
