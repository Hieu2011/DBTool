import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { api, ApiError } from '../api';
import { redisQuote } from '../sql/dialect';
import type { Connection, DbObjectInfo, RedisDatabaseInfo, RedisKeyInfo } from '../types';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { IconChevronDown, IconChevronRight, IconFolder, IconRefresh } from './icons';

interface Props {
  objConnection: Connection;
  onOpenObject: (objObject: DbObjectInfo) => void;
  /** Opens a console tab holding the commands. */
  onOpenSql: (strCommands: string, boolAutoRun?: boolean) => void;
  /** The key of the active tab (schema `dbN`): the tree switches to its database, opens its folders and shows it. */
  objReveal?: DbObjectInfo | null;
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

/** user -> *user*; a text that already holds a wildcard is used as typed. */
const toPattern = (strFilter: string) => {
  const strText = strFilter.trim();
  if (!strText) return '*';
  return /[*?[\]]/.test(strText) ? strText : `*${strText}*`;
};

/** Keys of one Redis database, grouped into folders at each `:`. Loaded page by page with SCAN. */
export function RedisTree({ objConnection, onOpenObject, onOpenSql, objReveal }: Props) {
  // Row of the active tab's key; strScrollTo: still to be scrolled into view.
  const [strCurrent, setStrCurrent] = useState<string | null>(null);
  const [strScrollTo, setStrScrollTo] = useState<string | null>(null);
  const refRevealed = useRef<string | null>(null); // one reveal per tab switch: the user may then browse away
  const refSwitched = useRef<string | null>(null);
  const refScroller = useRef<HTMLDivElement>(null);
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
    } catch (objEx) {
      if (intLoad === refLoad.current) setStrState(errorMessage(objEx));
    }
  }, [objConnection.id]);

  useEffect(() => { loadDatabases(); }, [loadDatabases]);
  useEffect(() => { loadKeys(intDatabase, strPattern, '0', false); }, [intDatabase, strPattern, loadKeys]);

  const refresh = () => {
    loadDatabases();
    loadKeys(intDatabase, strPattern, '0', false);
  };

  // Follows the active tab's key.
  const strRevealId = objReveal ? `${objReveal.schema}|${objReveal.name}` : null;
  useEffect(() => {
    const intRevealDb = objReveal ? Number(/^db(\d+)$/.exec(objReveal.schema)?.[1] ?? NaN) : NaN;
    if (!objReveal || !strRevealId || Number.isNaN(intRevealDb)) { refRevealed.current = null; return setStrCurrent(null); }
    if (refRevealed.current === strRevealId) return;
    if (intRevealDb !== intDatabase) {
      if (refSwitched.current === strRevealId) return; // already sent there once; the user chose another database since
      refSwitched.current = strRevealId;
      setHsExpanded(new Set());
      return setIntDatabase(intRevealDb);
    }
    if (strState !== 'idle') return; // a scan is running: its keys come first
    const strKey = objReveal.name;
    if (!arrKeys.some(objKey => objKey.key === strKey)) {
      // Not in the pages scanned so far. It is open in a tab, so it exists: list it, unless a filter says otherwise.
      if (strPattern !== '*') { refRevealed.current = strRevealId; return setStrCurrent(null); }
      return setArrKeys(arrPrev => [...arrPrev, { key: strKey, type: objReveal.type }]);
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
    getScrollElement: () => refScroller.current,
    estimateSize: () => ROW_H,
    overscan: 20,
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

  const menuItems = (objRow: Row): MenuItem[] => {
    const copy = (strText: string) => { navigator.clipboard.writeText(strText); };
    if (objRow.kind === 'folder') {
      return [
        { label: objRow.expanded ? 'Collapse' : 'Expand', onSelect: () => toggle(objRow.path) },
        { label: 'Filter to this prefix', onSelect: () => { setStrFilter(`${objRow.path}*`); setStrPattern(`${objRow.path}*`); } },
        { label: 'Copy prefix', onSelect: () => copy(objRow.path) },
      ];
    }
    const strKey = redisQuote(objRow.item.key);
    return [
      { label: 'View key', onSelect: () => open(objRow.item) },
      { label: 'Copy key', onSelect: () => copy(objRow.item.key) },
      { kind: 'separator' },
      { kind: 'header', label: 'Commands (opened in a console, not run)' },
      { label: 'TTL / EXPIRE', onSelect: () => onOpenSql(`SELECT ${intDatabase}\nTTL ${strKey}\nEXPIRE ${strKey} 3600`) },
      { label: 'RENAME', onSelect: () => onOpenSql(`SELECT ${intDatabase}\nRENAME ${strKey} ${strKey}`) },
      { label: 'DEL', danger: true, onSelect: () => onOpenSql(`SELECT ${intDatabase}\nDEL ${strKey}`) },
    ];
  };

  const objCurrent = arrDatabases.find(objItem => objItem.index === intDatabase);
  const boolMore = strCursor !== '0';

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-line">
      <div className="flex h-9 shrink-0 items-center gap-1.5 pl-3 pr-1.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Keys</h2>
        <select className="field h-6 w-auto min-w-0 flex-1 py-0 text-xs" aria-label="Database" value={intDatabase}
          onChange={objEvent => { setHsExpanded(new Set()); setIntDatabase(Number(objEvent.target.value)); }}>
          {(arrDatabases.length > 0 ? arrDatabases : [{ index: intDatabase, keys: 0 }]).map(objItem => (
            <option key={objItem.index} value={objItem.index}>
              db{objItem.index}{objItem.keys > 0 ? ` (${objItem.keys.toLocaleString()})` : ''}
            </option>
          ))}
        </select>
        <button className="icon-btn icon-btn-sm" onClick={refresh} disabled={strState === 'loading'}
          aria-label="Refresh keys" title="Scan the keys again">
          <IconRefresh intSize={14} />
        </button>
      </div>
      <form className="shrink-0 px-2 pb-1.5" onSubmit={objEvent => { objEvent.preventDefault(); setStrPattern(toPattern(strFilter)); }}>
        <input className="field h-7" placeholder="Filter: text or pattern (user:*), then Enter" spellCheck={false}
          value={strFilter} onChange={objEvent => setStrFilter(objEvent.target.value)} />
      </form>

      {strState !== 'idle' && strState !== 'loading' && (
        <p className="mx-2 mb-1.5 rounded border border-danger/40 p-2 text-xs text-danger">{strState}</p>
      )}

      <div ref={refScroller} className="min-h-0 flex-1 overflow-auto text-xs">
        <div style={{ height: objVirtual.getTotalSize(), position: 'relative' }}>
          {objVirtual.getVirtualItems().map(objItem => {
            const objRow = arrRows[objItem.index];
            return (
              <div key={objRow.path}
                className={`absolute left-0 flex w-full items-center gap-1.5 pr-1.5 hover:bg-hover ${
                  objRow.path === strCurrent ? 'bg-accent/15 shadow-[inset_2px_0_0_var(--accent)]' : ''}`}
                style={{ height: ROW_H, transform: `translateY(${objItem.start}px)`, paddingLeft: 8 + objRow.depth * 12 }}
                title={objRow.kind === 'key' ? objRow.item.key : objRow.path}
                onClick={objRow.kind === 'folder' ? () => toggle(objRow.path) : () => open(objRow.item)}
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
      <div className="flex h-7 shrink-0 items-center gap-2 border-t border-line px-3 text-[11px] text-muted">
        <span className="min-w-0 flex-1 truncate">
          {strState === 'loading' ? 'Scanning…' : `${arrKeys.length.toLocaleString()} keys loaded`}
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

      {objMenu && <ContextMenu intX={objMenu.x} intY={objMenu.y} arrItems={menuItems(objMenu.row)} onClose={() => setObjMenu(null)} />}
    </div>
  );
}
