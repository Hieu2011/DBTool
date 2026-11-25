import { useEffect, useState } from 'react';
import { redisQuote } from '../sql/dialect';
import { IconClose } from './icons';

type KeyType = 'STRING' | 'HASH' | 'LIST' | 'SET' | 'ZSET' | 'STREAM';
const TYPES: KeyType[] = ['STRING', 'HASH', 'LIST', 'SET', 'ZSET', 'STREAM'];

interface Props {
  strDatabase: string;
  /** Folder the menu was opened on, e.g. `auth:known_devices:`. */
  strPrefix: string;
  /** Runs the commands in the tree's database; throws with the server's message. */
  run: (arrCommands: string[]) => Promise<unknown[]>;
  onCreated: (strKey: string, strType: KeyType) => void;
  onClose: () => void;
}

/** New key with its first value. An existing key is never overwritten. */
export function RedisNewKey({ strDatabase, strPrefix, run, onCreated, onClose }: Props) {
  const [strKey, setStrKey] = useState(strPrefix);
  const [strType, setStrType] = useState<KeyType>('STRING');
  const [strFirst, setStrFirst] = useState(''); // value / field / member
  const [strSecond, setStrSecond] = useState(''); // hash value / zset score / stream value
  const [strTtl, setStrTtl] = useState('');
  const [boolBusy, setBoolBusy] = useState(false);
  const [strError, setStrError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (objEvent: KeyboardEvent) => objEvent.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const boolPair = strType === 'HASH' || strType === 'ZSET' || strType === 'STREAM';
  const strFirstLabel = strType === 'STRING' ? 'Value' : strType === 'HASH' || strType === 'STREAM' ? 'Field' : strType === 'LIST' ? 'Element' : 'Member';
  const strSecondLabel = strType === 'ZSET' ? 'Score' : 'Value';

  const command = () => {
    const strName = redisQuote(strKey);
    const [strA, strB] = [redisQuote(strFirst), redisQuote(strSecond)];
    switch (strType) {
      case 'STRING': return `SET ${strName} ${strA}`;
      case 'HASH': return `HSET ${strName} ${strA} ${strB}`;
      case 'LIST': return `RPUSH ${strName} ${strA}`;
      case 'SET': return `SADD ${strName} ${strA}`;
      case 'ZSET': return `ZADD ${strName} ${strSecond.trim()} ${strA}`;
      case 'STREAM': return `XADD ${strName} * ${strA} ${strB}`;
    }
  };

  const strProblem = strKey.trim() === '' ? 'Type the key name.'
    : strType !== 'STRING' && strFirst === '' ? `Type the first ${strFirstLabel.toLowerCase()}: Redis has no empty ${strType.toLowerCase()}.`
      : strType === 'ZSET' && !/^[-+]?(\d+(\.\d+)?|inf)$/i.test(strSecond.trim()) ? 'The score must be a number.'
        : strTtl.trim() !== '' && !/^[1-9]\d*$/.test(strTtl.trim()) ? 'TTL is a whole number of seconds (empty = no expiry).'
          : null;
  const arrCommands = strProblem ? [] : [command(), ...(strTtl.trim() ? [`EXPIRE ${redisQuote(strKey)} ${strTtl.trim()}`] : [])];

  const create = async (objEvent: React.FormEvent) => {
    objEvent.preventDefault();
    if (strProblem) return setStrError(strProblem);
    setBoolBusy(true);
    setStrError(null);
    try {
      const [objExists] = await run([`EXISTS ${redisQuote(strKey)}`]);
      if (Number(objExists) > 0) { setStrError(`${strKey} already exists in ${strDatabase}. Open it to change its value.`); return; }
      await run(arrCommands);
      onCreated(strKey, strType);
    } catch (objEx) {
      setStrError((objEx as Error).message);
    } finally {
      setBoolBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/35" onMouseDown={onClose}>
      <form onSubmit={create} onMouseDown={objEvent => objEvent.stopPropagation()} className="w-[30rem] rounded-md border border-line bg-raised text-[13px] shadow-2xl">
        <div className="flex items-center gap-2.5 border-b border-line py-2 pl-4 pr-2">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">New key in {strDatabase}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)"><IconClose /></button>
        </div>

        <div className="grid grid-cols-[5.5rem_1fr] items-center gap-x-3 gap-y-2.5 p-4">
          <label htmlFor="rk-key" className="text-muted">Key</label>
          <input id="rk-key" className="field font-mono text-xs" autoFocus spellCheck={false} value={strKey} placeholder="user:1001"
            onChange={objEvent => setStrKey(objEvent.target.value)} />

          <span className="text-muted">Type</span>
          <div className="segmented h-7" role="radiogroup" aria-label="Type">
            {TYPES.map(strItem => (
              <button key={strItem} type="button" aria-pressed={strType === strItem} onClick={() => setStrType(strItem)}>{strItem.toLowerCase()}</button>
            ))}
          </div>

          <label htmlFor="rk-first" className="self-start pt-1.5 text-muted">{strFirstLabel}</label>
          {strType === 'STRING'
            ? <textarea id="rk-first" className="field h-24 resize-y font-mono text-xs" spellCheck={false} value={strFirst} onChange={objEvent => setStrFirst(objEvent.target.value)} />
            : <input id="rk-first" className="field font-mono text-xs" spellCheck={false} value={strFirst} onChange={objEvent => setStrFirst(objEvent.target.value)} />}

          {boolPair && (
            <>
              <label htmlFor="rk-second" className="text-muted">{strSecondLabel}</label>
              <input id="rk-second" className="field font-mono text-xs" spellCheck={false} value={strSecond} placeholder={strType === 'ZSET' ? '0' : ''}
                onChange={objEvent => setStrSecond(objEvent.target.value)} />
            </>
          )}

          <label htmlFor="rk-ttl" className="text-muted">TTL (seconds)</label>
          <input id="rk-ttl" className="field w-32" inputMode="numeric" value={strTtl} placeholder="no expiry" onChange={objEvent => setStrTtl(objEvent.target.value)} />
        </div>

        {arrCommands.length > 0 && (
          <pre className="mx-4 mb-3 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-bg px-3 py-2 font-mono text-[11px] text-muted" style={{ userSelect: 'text' }}>
            {arrCommands.join('\n')}
          </pre>
        )}
        {strError && <p className="mx-4 mb-3 whitespace-pre-wrap rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{strError}</p>}

        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={boolBusy}>{boolBusy ? 'Creating…' : 'Create key'}</button>
        </div>
      </form>
    </div>
  );
}
