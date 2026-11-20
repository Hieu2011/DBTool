import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { QueryResult } from '../types';
import { downloadBlob } from '../diagramExport';
import { exportFileName, toCsv, toXlsx } from '../exportData';
import { IconDownload, IconFilter } from './icons';

const ROW_H = 24;
const INDEX_W = 56;
const CHAR_W = 7.4; // Cascadia Mono 12px

const NUMERIC = /^(int|integer|bigint|smallint|numeric|decimal|number|float|double|real|money|binary_(float|double))/i;

const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const display = (objValue: unknown): string => {
  if (objValue === null || objValue === undefined) return '';
  if (typeof objValue === 'object') return JSON.stringify(objValue);
  return String(objValue);
};

interface SortState { col: number; desc: boolean }

/** Sort and filter work on the rows already loaded, not on the database. */
interface Props {
  objResult: QueryResult;
  /** Called with the index in objResult.rows of the row the user clicked. */
  onSelectRow?: (intRow: number) => void;
  /** Start of the exported file's name; "result" when not given. */
  strExportName?: string;
}

export function ResultGrid({ objResult, onSelectRow, strExportName }: Props) {
  const refScroller = useRef<HTMLDivElement>(null);
  // r is the row's index in objResult.rows, so the selection survives sorting.
  const [objSelected, setObjSelected] = useState<{ r: number; c: number } | null>(null);
  const [objSort, setObjSort] = useState<SortState | null>(null);
  const [boolFilters, setBoolFilters] = useState(false);
  const [dicFilters, setDicFilters] = useState<Record<number, string>>({});
  const [boolExportMenu, setBoolExportMenu] = useState(false);

  // Width from the header and the first 100 rows, clamped.
  const arrWidths = useMemo(() => objResult.columns.map((objColumn, intCol) => {
    let intChars = Math.max(objColumn.name.length + 4, objColumn.dataType.length);
    for (let intRow = 0; intRow < Math.min(objResult.rows.length, 100); intRow++)
      intChars = Math.max(intChars, display(objResult.rows[intRow][intCol]).length);
    return Math.min(Math.max(intChars * CHAR_W + 20, 72), 380);
  }), [objResult]);

  const arrNumeric = useMemo(() => objResult.columns.map(objColumn => NUMERIC.test(objColumn.dataType)), [objResult]);

  // Indexes into objResult.rows after filtering and sorting.
  const arrView = useMemo(() => {
    const arrActive = boolFilters
      ? Object.entries(dicFilters)
        .map(([strCol, strText]) => [Number(strCol), strText.trim().toLowerCase()] as const)
        .filter(([intCol, strText]) => strText !== '' && intCol < objResult.columns.length)
      : [];

    let arrIndexes = objResult.rows.map((_, intRow) => intRow);
    if (arrActive.length > 0) {
      arrIndexes = arrIndexes.filter(intRow => arrActive.every(([intCol, strText]) => {
        const objValue = objResult.rows[intRow][intCol];
        return (objValue === null ? 'null' : display(objValue).toLowerCase()).includes(strText);
      }));
    }

    if (objSort && objSort.col < objResult.columns.length) {
      const { col: intCol, desc: boolDesc } = objSort;
      const boolNumber = arrNumeric[intCol];
      arrIndexes.sort((intA, intB) => {
        const objA = objResult.rows[intA][intCol];
        const objB = objResult.rows[intB][intCol];
        if (objA === null || objB === null) return objA === objB ? intA - intB : objA === null ? 1 : -1; // NULLs last
        const intOrder = boolNumber ? Number(objA) - Number(objB) : COLLATOR.compare(display(objA), display(objB));
        return (boolDesc ? -intOrder : intOrder) || intA - intB;
      });
    }
    return arrIndexes;
  }, [objResult, arrNumeric, objSort, boolFilters, dicFilters]);

  const intTotalWidth = INDEX_W + arrWidths.reduce((intSum, intWidth) => intSum + intWidth, 0);
  const boolFiltered = arrView.length !== objResult.rows.length;

  const objVirtual = useVirtualizer({
    count: arrView.length,
    getScrollElement: () => refScroller.current,
    estimateSize: () => ROW_H,
    overscan: 20,
  });

  const copy = (objEvent: React.KeyboardEvent) => {
    if (objEvent.target instanceof HTMLInputElement) return; // filter box copies its own text
    if (!objSelected || !(objEvent.ctrlKey && objEvent.key === 'c')) return;
    navigator.clipboard.writeText(display(objResult.rows[objSelected.r]?.[objSelected.c]));
    objEvent.preventDefault();
  };

  // Exports what the grid shows: the loaded rows, after the filter, in the sorted order.
  const exportRows = (strKind: 'csv' | 'xlsx') => {
    setBoolExportMenu(false);
    const arrRows = arrView.map(intRow => objResult.rows[intRow]);
    downloadBlob(strKind === 'csv' ? toCsv(objResult.columns, arrRows) : toXlsx(objResult.columns, arrRows),
      exportFileName(strExportName ?? 'result', strKind));
  };

  // asc → desc → original order
  const toggleSort = (intCol: number) =>
    setObjSort(objPrev => (objPrev?.col !== intCol ? { col: intCol, desc: false } : objPrev.desc ? null : { col: intCol, desc: true }));

  return (
    <div ref={refScroller} tabIndex={0} onKeyDown={copy}
      className="h-full overflow-auto font-mono text-xs outline-none">
      <div style={{ width: intTotalWidth, minWidth: '100%' }}>
        {/* header */}
        <div className="sticky top-0 z-10 border-b border-line bg-bg font-sans">
          <div className="flex">
            <div style={{ width: INDEX_W }} className="relative flex shrink-0 items-center justify-center gap-0.5 border-r border-line"
              onBlur={objEvent => { if (!objEvent.currentTarget.contains(objEvent.relatedTarget)) setBoolExportMenu(false); }}>
              <button type="button" className={`icon-btn icon-btn-sm ${boolFilters ? 'text-accent' : ''}`} aria-pressed={boolFilters}
                aria-label="Filter rows" title="Filter the loaded rows" onClick={() => setBoolFilters(boolPrev => !boolPrev)}>
                <IconFilter intSize={14} />
              </button>
              <button type="button" className="icon-btn icon-btn-sm" aria-haspopup="menu" aria-expanded={boolExportMenu}
                aria-label="Export rows" title="Export the rows shown here to Excel or CSV" disabled={objResult.columns.length === 0}
                onClick={() => setBoolExportMenu(boolPrev => !boolPrev)}>
                <IconDownload intSize={14} />
              </button>
              {boolExportMenu && (
                <div role="menu" className="absolute left-1 top-full z-20 min-w-44 rounded border border-line bg-panel py-1 text-xs shadow-lg">
                  <div className="px-3 pb-1 text-[11px] text-muted">{arrView.length.toLocaleString()} rows shown</div>
                  <button type="button" role="menuitem" className="block w-full whitespace-nowrap px-3 py-1 text-left hover:bg-hover"
                    onClick={() => exportRows('xlsx')}>Export to Excel (.xlsx)</button>
                  <button type="button" role="menuitem" className="block w-full whitespace-nowrap px-3 py-1 text-left hover:bg-hover"
                    onClick={() => exportRows('csv')}>Export to CSV</button>
                </div>
              )}
            </div>
            {objResult.columns.map((objColumn, intCol) => (
              <div key={intCol} style={{ width: arrWidths[intCol] }} role="button" onClick={() => toggleSort(intCol)}
                title={`${objColumn.name} (${objColumn.dataType}) · click to sort`}
                className={`shrink-0 cursor-pointer truncate border-r border-line px-2 py-1 hover:bg-hover ${arrNumeric[intCol] ? 'text-right' : ''}`}>
                <div className="truncate text-[12px] font-semibold">
                  {objColumn.name}
                  {objSort?.col === intCol && <span className="ml-1 text-accent">{objSort.desc ? '▼' : '▲'}</span>}
                </div>
                <div className="truncate text-[11px] text-muted">{objColumn.dataType}</div>
              </div>
            ))}
          </div>

          {boolFilters && (
            <div className="flex border-t border-line">
              <div style={{ width: INDEX_W }} title={`${arrView.length.toLocaleString()} of ${objResult.rows.length.toLocaleString()} loaded rows`}
                className={`shrink-0 truncate border-r border-line px-1 text-right text-[11px] leading-6 ${boolFiltered ? 'text-accent' : 'text-muted'}`}>
                {arrView.length.toLocaleString()}
              </div>
              {objResult.columns.map((objColumn, intCol) => (
                <div key={intCol} style={{ width: arrWidths[intCol] }} className="shrink-0 border-r border-line">
                  <input value={dicFilters[intCol] ?? ''} placeholder="contains…" aria-label={`Filter ${objColumn.name}`}
                    onChange={objEvent => setDicFilters(dicPrev => ({ ...dicPrev, [intCol]: objEvent.target.value }))}
                    className="h-6 w-full bg-transparent px-2 font-mono text-xs outline-none placeholder:text-muted/60 focus:bg-panel" />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* rows */}
        <div style={{ height: objVirtual.getTotalSize(), position: 'relative' }}>
          {objVirtual.getVirtualItems().map(objItem => {
            const intRow = arrView[objItem.index];
            const arrRow = objResult.rows[intRow];
            return (
              <div key={objItem.key} className="absolute left-0 flex w-full border-b border-line/60 hover:bg-hover/60"
                style={{ height: ROW_H, transform: `translateY(${objItem.start}px)` }}>
                <div style={{ width: INDEX_W }}
                  className="shrink-0 border-r border-line px-2 text-right leading-6 text-muted">
                  {objItem.index + 1}
                </div>
                {arrRow.map((objValue, intCol) => {
                  const boolSelected = objSelected?.r === intRow && objSelected.c === intCol;
                  return (
                    <div key={intCol} style={{ width: arrWidths[intCol] }}
                      onClick={() => { setObjSelected({ r: intRow, c: intCol }); onSelectRow?.(intRow); }}
                      title={objValue === null ? 'NULL' : display(objValue)}
                      className={`shrink-0 truncate border-r border-line/60 px-2 leading-6 ${arrNumeric[intCol] ? 'text-right' : ''} ${
                        boolSelected ? 'bg-accent/15 outline outline-1 -outline-offset-1 outline-accent' : ''}`}>
                      {objValue === null ? <span className="text-muted italic">NULL</span> : display(objValue)}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        {boolFiltered && arrView.length === 0 && <p className="p-3 font-sans text-muted">No loaded row matches the filter.</p>}
      </div>
    </div>
  );
}
