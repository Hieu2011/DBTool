import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { api, ApiError } from '../api';
import { showToast } from '../toast';
import { TREE_STICKY_TOP, useOuterScroll, type TreeStatus } from './useOuterScroll';
import { redisQuote } from '../sql/dialect';
import type { Connection, DbObjectInfo, RedisDatabaseInfo, RedisKeyInfo } from '../types';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { IconChevronDown, IconChevronRight, IconFolder, IconPlus, IconRefresh } from './icons';
import { RedisNewKey } from './RedisNewKey';

interface Props {
  objConnection: Connection;
  onOpenObject: (objObject: DbObjectInfo) => void;
  /** Opens a console tab holding the commands. */
  onOpenSql: (strCommands: string, boolAutoRun?: boolean) => void;
  /** The key of the active tab (schema `dbN`): the tree switches to its database, opens its folders and shows it. */
  objReveal?: DbObjectInfo | null;
  /** Goes up when the connection's Refresh button is pressed. */
  intRefresh: number;
  onStatus: (strStatus: TreeStatus) => void;
  /** A scan failed: the sidebar shows the message in a dialog. */
  onError: (strMessage: string, boolRefresh: boolean) => void;
}

const ROW_H = 22;
const SEPARATOR = ':';
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const TYPE_TAG: Record<string, string> = { STRING: 'str', HASH: 'hash', LIST: 'list', SET: 'set', ZSET: 'zset', STREAM: 'strm' };

interface Folder { folders: Map<string, Folder>; keys: RedisKeyInfo[]; count: number }

type Row =
  | { kind: 'folder'; path: string; depth: number; label: string; count: number; expanded: boolean }
  | { kind: 'key'; path: string; depth: number; label: string; item: RedisKeyInfo };

const errorMessage = (objEx: unknown) => (objEx instanceof ApiError ? objEx.detail.message : (objEx as Error).message);

const DELETE_SCAN_MAX = 100_000; // keys a prefix delete will collect; more than that belongs in a script
const DELETE_BATCH = 100;

/** A key prefix as a SCAN pattern that matches it literally. */
const prefixPattern = (strPrefix: string) => `${strPrefix.replace(/[\\*?[\]]/g, '\\$&')}*`;

/** user -> *user*; a text that already holds a wildcard is used as typed. */
const toPattern = (strFilter: string) => {
  const strText = strFilter.trim();
  if (!strText) return '*';
  return /[*?[\]]/.test(strText) ? strText : `*${strText}*`;
};

/** Keys of one Redis database, grouped into folders at each `:`. Loaded page by page with SCAN. */
export function RedisTree({ objConnection, onOpenObject, onOpenSql, objReveal, intRefresh, onStatus, onError }: Props) {
  // Row of the active tab's key; strScrollTo: still to be scrolled into view.
  const [strCurrent, setStrCurrent] = useState<string | null>(null);
  const [strScrollTo, setStrScrollTo] = useState<string | null>(null);
  const refRevealed = useRef<string | null>(null); // one reveal per tab switch: the user may then browse away
  const refSwitched = useRef<string | null>(null);
  // The sidebar scrolls all trees as one list: rows are virtualized against its scroller.
  const refList = useRef<HTMLDivElement>(null);
  const objOuter = useOuterScroll(refList);
  const intMargin = objOuter?.margin ?? 0;
  const [arrDatabases, setArrDatabases] = useState<RedisDatabaseInfo[]>([]);
  const [intDatabase, setIntDatabase] = useState(() => Number.parseInt(objConnection.database, 10) || 0);
  const [strFilter, setStrFilter] = useState('');
  const [strPattern, setStrPattern] = useState('*');
  const [arrKeys, setArrKeys] = useState<RedisKeyInfo[]>([]);
  const [strCursor, setStrCursor] = useState('0');
  const [strState, setStrState] = useState<'idle' | 'loading' | string>('idle');
  const [hsExpanded, setHsExpanded] = useState<Set<string>>(new Set());
  const [objMenu, setObjMenu] = useState<{ x: number; y: number; row: Row } | null>(null);
  // A newer load (other database, other pattern) makes the answers of older ones stale.
  const refLoad = useRef(0);
  const refChecked = useRef<string | null>(null); // reveal whose key was asked for (EXISTS)
  const refConnected = useRef(false);

  const loadDatabases = useCallback(() => {
    api.redisDatabases(objConnection.id).then(setArrDatabases, () => {});
  }, [objConnection.id]);

  /** boolMore: the next page of the same scan; otherwise the scan starts over. */
  const loadKeys = useCallback(async (intDb: number, strMatch: string, strFrom: string, boolMore: boolean) => {
    const intLoad = ++refLoad.current;
    setStrState('loading');
    try {
      const objPage = await api.redisKeys(objConnection.id, intDb, strMatch, strFrom);
      if (intLoad !== refLoad.current) return;
      setArrKeys(arrPrev => {
        if (!boolMore) return objPage.keys;
        const hsKnown = new Set(arrPrev.map(objKey => objKey.key)); // SCAN may repeat a key across pages
        return [...arrPrev, ...objPage.keys.filter(objKey => !hsKnown.has(objKey.key))];
      });
      setStrCursor(objPage.cursor);
      setStrState('idle');
      if (!refConnected.current) showToast('success', `Connected to ${objConnection.name}`);
      refConnected.current = true;
    } catch (objEx) {
      if (intLoad !== refLoad.current) return;
      setStrState(errorMessage(objEx));
      onError(errorMessage(objEx), refConnected.current);
    }
  }, [objConnection.id, objConnection.name]);

  useEffect(() => { loadDatabases(); }, [loadDatabases]);
  useEffect(() => { loadKeys(intDatabase, strPattern, '0', false); }, [intDatabase, strPattern, loadKeys]);

  // ---- new key / delete ----
  const [strNewPrefix, setStrNewPrefix] = useState<string | null>(null);
  // Keys picked with Ctrl / Shift + click, for Delete selected.
  const [hsPicked, setHsPicked] = useState<Set<string>>(new Set());
  const refAnchor = useRef<string | null>(null);
  const [strWork, setStrWork] = useState<string | null>(null);

  /** Runs the commands in the tree's database on a session of their own; returns each first cell. */
  const runCommands = useCallback(async (arrCommands: string[]) => {
    const strSessionId = crypto.randomUUID();
    const send = (strCommand: string) => api.query(crypto.randomUUID(), objConnection.id, strCommand, 1, strSessionId);
    try {
      await send(`SELECT ${intDatabase}`);
      const arrAnswers: unknown[] = [];
      for (const strCommand of arrCommands) arrAnswers.push((await send(strCommand)).rows[0]?.[0]);
      return arrAnswers;
    } catch (objEx) {
      throw new Error(errorMessage(objEx));
    } finally {
      api.closeSession(strSessionId).catch(() => {});
    }
  }, [objConnection.id, intDatabase]);

  /** DEL in batches; a cluster refuses keys of different slots in one command, so those go one by one. */
  const deleteKeys = async (arrDelete: string[], strWhat: string) => {
    if (arrDelete.length === 0) return;
    if (!confirm(`Delete ${strWhat} from db${intDatabase} of "${objConnection.name}"?\n\nThis cannot be undone.`)) return;
    let intDone = 0;
    try {
      for (let intAt = 0; intAt < arrDelete.length; intAt += DELETE_BATCH) {
        const arrBatch = arrDelete.slice(intAt, intAt + DELETE_BATCH);
        setStrWork(`Deleting… ${intDone.toLocaleString()} of ${arrDelete.length.toLocaleString()}`);
        try {
          await runCommands([`DEL ${arrBatch.map(redisQuote).join(' ')}`]);
        } catch (objEx) {
          if (!/CROSSSLOT/i.test((objEx as Error).message)) throw objEx;
          await runCommands(arrBatch.map(strKey => `DEL ${redisQuote(strKey)}`));
        }
        intDone += arrBatch.length;
      }
      showToast('success', `Deleted ${intDone.toLocaleString()} ${intDone === 1 ? 'key' : 'keys'}`, objConnection.name);
    } catch (objEx) {
      showToast('error', `Delete stopped after ${intDone.toLocaleString()} of ${arrDelete.length.toLocaleString()} keys`, (objEx as Error).message);
    } finally {
      setStrWork(null);
      setHsPicked(new Set());
      loadDatabases();
      loadKeys(intDatabase, strPattern, '0', false);
    }
  };

  /** Every key under a folder, loaded or not: scanned again by its prefix. */
  const deletePrefix = async (strPrefix: string) => {
    const arrFound: string[] = [];
    let strFrom = '0';
    try {
      do {
        setStrWork(`Looking for ${strPrefix}* … ${arrFound.length.toLocaleString()} keys`);
        const objPage = await api.redisKeys(objConnection.id, intDatabase, prefixPattern(strPrefix), strFrom);
        arrFound.push(...objPage.keys.map(objKey => objKey.key));
        strFrom = objPage.cursor;
        if (arrFound.length > DELETE_SCAN_MAX) {
          setStrWork(null);
          return alert(`More than ${DELETE_SCAN_MAX.toLocaleString()} keys start with ${strPrefix}. Delete them with a script in the console instead.`);
        }
      } while (strFrom !== '0');
    } catch (objEx) {
      setStrWork(null);
      return showToast('error', 'The keys could not be listed', errorMessage(objEx));
    }
    setStrWork(null);
    const arrUnique = [...new Set(arrFound)]; // SCAN may repeat a key
    if (arrUnique.length === 0) return showToast('info', `No key starts with ${strPrefix}`);
    await deleteKeys(arrUnique, `all ${arrUnique.length.toLocaleString()} keys that start with ${strPrefix}`);
  };

  const refresh = () => {
    loadDatabases();
    loadKeys(intDatabase, strPattern, '0', false);
  };

  // Follows the active tab's key.
  const strRevealId = objReveal ? `${objReveal.schema}|${objReveal.name}` : null;
  useEffect(() => {
    const intRevealDb = objReveal ? Number(/^db(\d+)$/.exec(objReveal.schema)?.[1] ?? NaN) : NaN;
    if (!objReveal || !strRevealId || Number.isNaN(intRevealDb)) { refRevealed.current = null; refChecked.current = null; return setStrCurrent(null); }
    if (refRevealed.current === strRevealId) return;
    if (intRevealDb !== intDatabase) {
      if (refSwitched.current === strRevealId) return; // already sent there once; the user chose another database since
      refSwitched.current = strRevealId;
      setHsExpanded(new Set());
      return setIntDatabase(intRevealDb);
    }
    if (strState !== 'idle') return; // a scan is running: its keys come first
    const strKey = objReveal.name;
    const boolListed = arrKeys.some(objKey => objKey.key === strKey);
    // A tab can outlive its key (expired, deleted): ask once per tab switch, so a dead key is not listed.
    if (refChecked.current !== strRevealId) {
      refChecked.current = strRevealId;
      runCommands([`EXISTS ${redisQuote(strKey)}`]).then(([objExists]) => {
        if (refChecked.current !== strRevealId) return;
        if (Number(objExists) > 0) {
          // Not in the pages scanned so far: list it, unless a filter says otherwise.
          if (strPattern === '*') setArrKeys(arrPrev => (arrPrev.some(objKey => objKey.key === strKey) ? arrPrev : [...arrPrev, { key: strKey, type: objReveal.type }]));
          return;
        }
        refRevealed.current = strRevealId;
        setArrKeys(arrPrev => arrPrev.filter(objKey => objKey.key !== strKey));
        setStrCurrent(null);
      }, () => {});
    }
    if (!boolListed) {
      if (strPattern !== '*') { refRevealed.current = strRevealId; setStrCurrent(null); }
      return; // listed by the check above when the key exists
    }
    refRevealed.current = strRevealId;
    const arrParts = strKey.split(SEPARATOR).slice(0, -1);
    setHsExpanded(hsPrev => {
      const hsNext = new Set(hsPrev);
      arrParts.forEach((_, intPart) => hsNext.add(`${arrParts.slice(0, intPart + 1).join(SEPARATOR)}${SEPARATOR}`));
      return hsNext;
    });
    setStrCurrent(`k:${strKey}`);
    setStrScrollTo(`k:${strKey}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strRevealId, intDatabase, arrKeys, strState, strPattern]);

  // ---- folders ----
  const objRoot = useMemo(() => {
    const objTop: Folder = { folders: new Map(), keys: [], count: 0 };
    for (const objKey of arrKeys) {
      const arrParts = objKey.key.split(SEPARATOR);
      let objFolder = objTop;
      objFolder.count++;
      for (const strPart of arrParts.slice(0, -1)) {
        let objChild = objFolder.folders.get(strPart);
        if (!objChild) objFolder.folders.set(strPart, objChild = { folders: new Map(), keys: [], count: 0 });
        objChild.count++;
        objFolder = objChild;
      }
      objFolder.keys.push(objKey);
    }
    return objTop;
  }, [arrKeys]);

  const arrRows = useMemo(() => {
    const arrResult: Row[] = [];
    const walk = (objFolder: Folder, strPrefix: string, intDepth: number) => {
      const arrFolders = [...objFolder.folders.entries()].sort(([strLeft], [strRight]) => COLLATOR.compare(strLeft, strRight));
      for (const [strName, objChild] of arrFolders) {
        const strPath = `${strPrefix}${strName}${SEPARATOR}`;
        const boolOpen = hsExpanded.has(strPath);
        arrResult.push({ kind: 'folder', path: strPath, depth: intDepth, label: strName, count: objChild.count, expanded: boolOpen });
        if (boolOpen) walk(objChild, strPath, intDepth + 1);
      }
      for (const objKey of [...objFolder.keys].sort((objLeft, objRight) => COLLATOR.compare(objLeft.key, objRight.key))) {
        arrResult.push({
          kind: 'key', path: `k:${objKey.key}`, depth: intDepth, item: objKey,
          label: objKey.key.slice(strPrefix.length) || objKey.key,
        });
      }
    };
    walk(objRoot, '', 0);
    return arrResult;
  }, [objRoot, hsExpanded]);

  const objVirtual = useVirtualizer({
    count: arrRows.length,
    getScrollElement: () => objOuter?.element ?? null,
    estimateSize: () => ROW_H,
    overscan: 20,
    scrollMargin: intMargin,
    scrollPaddingStart: TREE_STICKY_TOP,
  });

  useEffect(() => {
    if (!strScrollTo) return;
    const intIndex = arrRows.findIndex(objRow => objRow.path === strScrollTo);
    if (intIndex < 0) return;
    objVirtual.scrollToIndex(intIndex, { align: 'center' });
    setStrScrollTo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strScrollTo, arrRows]);

  const toggle = (strPath: string) => setHsExpanded(hsPrev => {
    const hsNext = new Set(hsPrev);
    if (!hsNext.delete(strPath)) hsNext.add(strPath);
    return hsNext;
  });

  const open = (objKey: RedisKeyInfo) => onOpenObject({ schema: `db${intDatabase}`, name: objKey.key, type: objKey.type });

  /** Plain click opens the key. Ctrl: add / remove it from the picked ones. Shift: the range from the last pick. */
  const clickKey = (objKey: RedisKeyInfo, objEvent: React.MouseEvent) => {
    if (objEvent.shiftKey && refAnchor.current !== null) {
      const arrShown = arrRows.flatMap(objRow => (objRow.kind === 'key' ? [objRow.item.key] : []));
      const [intFrom, intTo] = [arrShown.indexOf(refAnchor.current), arrShown.indexOf(objKey.key)];
      if (intFrom >= 0 && intTo >= 0) return setHsPicked(new Set(arrShown.slice(Math.min(intFrom, intTo), Math.max(intFrom, intTo) + 1)));
    }
    refAnchor.current = objKey.key;
    if (!objEvent.ctrlKey) { setHsPicked(new Set()); return open(objKey); }
    setHsPicked(hsPrev => {
      const hsNext = new Set(hsPrev);
      if (!hsNext.delete(objKey.key)) hsNext.add(objKey.key);
      return hsNext;
    });
  };

  const menuItems = (objRow: Row): MenuItem[] => {
    const copy = (strText: string) => { navigator.clipboard.writeText(strText); };
    if (objRow.kind === 'folder') {
      return [
        { label: objRow.expanded ? 'Collapse' : 'Expand', onSelect: () => toggle(objRow.path) },
        { label: 'Filter to this prefix', onSelect: () => { setStrFilter(`${objRow.path}*`); setStrPattern(`${objRow.path}*`); } },
        { label: 'Copy prefix', onSelect: () => copy(objRow.path) },
        { kind: 'separator' },
        { label: 'New key here…', onSelect: () => setStrNewPrefix(objRow.path) },
        { label: `Delete all keys in ${objRow.path}*…`, danger: true, onSelect: () => { deletePrefix(objRow.path); } },
      ];
    }
    const strKey = redisQuote(objRow.item.key);
    return [
      { label: 'View key', onSelect: () => open(objRow.item) },
      { label: 'Copy key', onSelect: () => copy(objRow.item.key) },
      { label: 'New key…', onSelect: () => setStrNewPrefix(objRow.item.key.slice(0, objRow.item.key.lastIndexOf(SEPARATOR) + 1)) },
      hsPicked.size > 1 && hsPicked.has(objRow.item.key)
        ? { label: `Delete ${hsPicked.size.toLocaleString()} selected keys…`, danger: true, onSelect: () => { deleteKeys([...hsPicked], `the ${hsPicked.size.toLocaleString()} selected keys`); } }
        : { label: 'Delete key…', danger: true, onSelect: () => { deleteKeys([objRow.item.key], `the key ${objRow.item.key}`); } },
      { kind: 'separator' },
      { kind: 'header', label: 'Commands (opened in a console, not run)' },
      { label: 'TTL / EXPIRE', onSelect: () => onOpenSql(`SELECT ${intDatabase}\nTTL ${strKey}\nEXPIRE ${strKey} 3600`) },
      { label: 'RENAME', onSelect: () => onOpenSql(`SELECT ${intDatabase}\nRENAME ${strKey} ${strKey}`) },
      { label: 'DEL', danger: true, onSelect: () => onOpenSql(`SELECT ${intDatabase}\nDEL ${strKey}`) },
    ];
  };

  const strStatus: TreeStatus = strState === 'loading' ? 'loading' : strState !== 'idle' ? 'failed' : refConnected.current ? 'ok' : 'idle';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { onStatus(strStatus); }, [strStatus]);

  const refRefresh = useRef(intRefresh);
  useEffect(() => {
    if (refRefresh.current === intRefresh) return;
    refRefresh.current = intRefresh;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intRefresh]);

  const objCurrent = arrDatabases.find(objItem => objItem.index === intDatabase);
  const boolMore = strCursor !== '0';

  return (
    <div className="pb-1">
      <div className="flex h-8 items-center gap-1.5 pl-3 pr-1.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Keys</h2>
        <select className="field h-6 w-auto min-w-0 flex-1 py-0 text-xs" aria-label="Database" value={intDatabase}
          onChange={objEvent => { setHsExpanded(new Set()); setIntDatabase(Number(objEvent.target.value)); }}>
          {(arrDatabases.length > 0 ? arrDatabases : [{ index: intDatabase, keys: 0 }]).map(objItem => (
            <option key={objItem.index} value={objItem.index}>
              db{objItem.index}{objItem.keys > 0 ? ` (${objItem.keys.toLocaleString()})` : ''}
            </option>
          ))}
        </select>
        <button className="icon-btn icon-btn-sm" onClick={() => setStrNewPrefix('')} aria-label="New key" title="New key…">
          <IconPlus intSize={14} />
        </button>
        <button className="icon-btn icon-btn-sm" onClick={refresh} disabled={strState === 'loading'}
          aria-label="Refresh keys" title="Scan the keys again">
          <IconRefresh intSize={14} />
        </button>
      </div>
      <form className="shrink-0 px-2 pb-1.5" onSubmit={objEvent => { objEvent.preventDefault(); setStrPattern(toPattern(strFilter)); }}>
        <input className="field h-7" placeholder="Filter: text or pattern (user:*), then Enter" spellCheck={false}
          value={strFilter} onChange={objEvent => setStrFilter(objEvent.target.value)} />
      </form>

      {strStatus === 'failed' && (
        <p className="flex items-center gap-2 px-3 py-1 text-xs text-danger" title={strState}>
          <span className="min-w-0 flex-1 truncate">{refConnected.current ? 'Scan failed' : 'Not connected'}: {strState}</span>
          <button className="btn h-5 px-2 text-[11px] text-fg" onClick={refresh}>Retry</button>
        </p>
      )}

      <div ref={refList} className="text-xs">
        <div style={{ height: objVirtual.getTotalSize(), position: 'relative' }}>
          {objVirtual.getVirtualItems().map(objItem => {
            const objRow = arrRows[objItem.index];
            return (
              <div key={objRow.path}
                className={`absolute left-0 flex w-full items-center gap-1.5 pr-1.5 hover:bg-hover ${
                  objRow.kind === 'key' && hsPicked.has(objRow.item.key) ? 'bg-accent/30' : objRow.path === strCurrent ? 'bg-accent/15 shadow-[inset_2px_0_0_var(--accent)]' : ''}`}
                style={{ height: ROW_H, transform: `translateY(${objItem.start - intMargin}px)`, paddingLeft: 8 + objRow.depth * 12 }}
                title={objRow.kind === 'key' ? objRow.item.key : objRow.path}
                onClick={objRow.kind === 'folder' ? () => toggle(objRow.path) : objEvent => clickKey(objRow.item, objEvent)}
                onContextMenu={objEvent => {
                  objEvent.preventDefault();
                  setObjMenu({ x: objEvent.clientX, y: objEvent.clientY, row: objRow });
                }}>
                {objRow.kind === 'folder'
                  ? (
                    <>
                      {objRow.expanded ? <IconChevronDown intSize={12} className="text-muted" /> : <IconChevronRight intSize={12} className="text-muted" />}
                      <IconFolder intSize={14} className="text-muted" />
                      <span className="min-w-0 flex-1 truncate">{objRow.label}</span>
                      <span className="shrink-0 tabular-nums text-muted">{objRow.count.toLocaleString()}</span>
                    </>
                  )
                  : (
                    <>
                      <span className="w-8 shrink-0 text-center font-mono text-[10px] uppercase text-muted">
                        {TYPE_TAG[objRow.item.type] ?? objRow.item.type.slice(0, 4).toLowerCase()}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{objRow.label}</span>
                    </>
                  )}
              </div>
            );
          })}
        </div>
      </div>

      {/* A scan is never loaded whole: say how far it got. */}
      <div className="flex h-7 items-center gap-2 px-3 text-[11px] text-muted">
        <span className="min-w-0 flex-1 truncate">
          {strWork ?? (hsPicked.size > 0 ? `${hsPicked.size.toLocaleString()} selected · right-click to delete`
            : strState === 'loading' ? 'Scanning…' : `${arrKeys.length.toLocaleString()} keys loaded`)}
          {strState !== 'loading' && !boolMore && strPattern === '*' && objCurrent && objCurrent.keys > arrKeys.length
            && ` of ${objCurrent.keys.toLocaleString()}`}
        </span>
        {boolMore && (
          <button className="btn h-5 px-2 text-[11px]" disabled={strState === 'loading'}
            onClick={() => loadKeys(intDatabase, strPattern, strCursor, true)}>
            Load more
          </button>
        )}
      </div>

      {strNewPrefix !== null && (
        <RedisNewKey strDatabase={`db${intDatabase}`} strPrefix={strNewPrefix} run={runCommands} onClose={() => setStrNewPrefix(null)}
          onCreated={(strKey, strType) => {
            setStrNewPrefix(null);
            showToast('success', `Created ${strKey}`, objConnection.name);
            refresh();
            onOpenObject({ schema: `db${intDatabase}`, name: strKey, type: strType });
          }} />
      )}
      {objMenu && <ContextMenu intX={objMenu.x} intY={objMenu.y} arrItems={menuItems(objMenu.row)} onClose={() => setObjMenu(null)} />}
    </div>
  );
}
