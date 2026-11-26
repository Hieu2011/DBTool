import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { QueryResult } from '../types';
import { downloadBlob } from '../diagramExport';
import { exportFileName, toCsv, toXlsx } from '../exportData';
import { DatePickerButton, isDateType } from './DatePicker';
import { IconDownload, IconFilter, IconPencil } from './icons';

const ROW_H = 28;
const INDEX_W = 56;
const CHAR_W = 8; // Cascadia Mono 13px

const NUMERIC = /^(int|integer|bigint|smallint|numeric|decimal|number|float|double|real|money|binary_(float|double))/i;

const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const display = (objValue: unknown): string => {
  if (objValue === null || objValue === undefined) return '';
  if (typeof objValue === 'object') return JSON.stringify(objValue);
  return String(objValue);
};

interface SortState { col: number; desc: boolean }

/** Asked from a toolbar outside the grid; it works on the rows as shown (filter, sort). */
export type GridCommand = 'first' | 'prev' | 'next' | 'last' | 'edit' | 'xlsx' | 'csv';

/** A rectangle of cells picked by dragging or Shift: rows in the order shown, columns left to right. */
export interface GridBlock { rows: number[]; cols: number[] }

/** Cell editing, driven by the owner of the result (EditableResult). Changes are keyed `row:col`. */
export interface GridEdit {
  /** Per column: can its cells be edited. */
  arrEditable: boolean[];
  dicChanges: Map<string, string | null>;
  canEdit: (intRow: number) => boolean;
  /** strValue undefined: the cell is back to what was loaded. */
  onEdit: (intRow: number, intCol: number, strValue: string | null | undefined) => void;
  /** Rows from this index on are new (not in the database yet): kept last, never filtered or sorted. */
  intBase: number;
  /** Rows marked for deletion. */
  hsDeleted: Set<number>;
  /** Asked before a cell opens; false keeps it closed. */
  start?: (intRow: number) => Promise<boolean>;
}

/** Sort and filter work on the rows already loaded, not on the database. */
interface Props {
  objResult: QueryResult;
  /** Called with the index in objResult.rows of the row the user clicked. */
  onSelectRow?: (intRow: number) => void;
  /** Start of the exported file's name; "result" when not given. */
  strExportName?: string;
  /** Set while the result is being edited. */
  objEdit?: GridEdit;
  /** Selected rows (indexes in objResult.rows), when the owner keeps them. */
  hsRows?: Set<number>;
  onRows?: (hsRows: Set<number>) => void;
  /** A new object each time: scrolls that row into view. */
  objReveal?: { row: number } | null;
  /** A new object each time it is asked. */
  objCommand?: { name: GridCommand } | null;
  /** The owner has its own export button. */
  boolNoExport?: boolean;
  /** The block of cells changed (null: none, a single cell is not a block). */
  onBlock?: (objBlock: GridBlock | null) => void;
}

export function ResultGrid({ objResult, onSelectRow, strExportName, objEdit, hsRows, onRows, objReveal, objCommand, boolNoExport, onBlock }: Props) {
  // A block of cells: from the cell where the drag / Shift started (a) to where it is now (b). Rows by their index in objResult.rows.
  const [objBlock, setObjBlock] = useState<{ a: { r: number; c: number }; b: { r: number; c: number } } | null>(null);
  // Blocks added with Ctrl (DBeaver's way): they stay while another one is dragged.
  const [arrExtra, setArrExtra] = useState<{ a: { r: number; c: number }; b: { r: number; c: number } }[]>([]);
  const clearBlocks = () => { setObjBlock(null); setArrExtra(arrPrev => (arrPrev.length === 0 ? arrPrev : [])); };
  const refDrag = useRef<{ r: number; c: number } | null>(null);
  const refRowDrag = useRef<number | null>(null); // the row number where a drag down the number column started
  const refOnBlock = useRef(onBlock);
  refOnBlock.current = onBlock;
  useEffect(() => {
    const endDrag = () => { refDrag.current = null; refRowDrag.current = null; };
    window.addEventListener('mouseup', endDrag);
    return () => window.removeEventListener('mouseup', endDrag);
  }, []);
  const refEditBox = useRef<HTMLInputElement>(null);
  const refPickerOpen = useRef(false);
  const [hsInner, setHsInner] = useState<Set<number>>(new Set());
  const hsPicked = hsRows ?? hsInner;
  const refAnchor = useRef<number | null>(null); // where a Shift+click range starts
  // The cell being typed in.
  const [objEditing, setObjEditing] = useState<{ r: number; c: number; text: string; readOnly?: boolean } | null>(null);
  const refEditClosed = useRef(false); // Enter / Escape already ended the edit: the blur that follows must not commit again
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
    return Math.min(Math.max(intChars * CHAR_W + 20, 80), 460);
  }), [objResult]);

  const arrNumeric = useMemo(() => objResult.columns.map(objColumn => NUMERIC.test(objColumn.dataType)), [objResult]);

  const intBase = Math.min(objEdit?.intBase ?? objResult.rows.length, objResult.rows.length);

  // Indexes into objResult.rows after filtering and sorting.
  const arrView = useMemo(() => {
    const arrActive = boolFilters
      ? Object.entries(dicFilters)
        .map(([strCol, strText]) => [Number(strCol), strText.trim().toLowerCase()] as const)
        .filter(([intCol, strText]) => strText !== '' && intCol < objResult.columns.length)
      : [];

    let arrIndexes = objResult.rows.slice(0, intBase).map((_, intRow) => intRow);
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
    for (let intRow = intBase; intRow < objResult.rows.length; intRow++) arrIndexes.push(intRow);
    return arrIndexes;
  }, [objResult, arrNumeric, objSort, boolFilters, dicFilters, intBase]);

  // The blocks as shown: for each, the rows between its two ends in the current order. With Ctrl blocks around, the current cell is one too.
  const arrAreas = useMemo(() => {
    const arrBlocks = [...arrExtra, ...(objBlock ? [objBlock] : arrExtra.length > 0 && objSelected ? [{ a: objSelected, b: objSelected }] : [])];
    return arrBlocks.flatMap(objItem => {
      const intA = arrView.indexOf(objItem.a.r);
      const intB = arrView.indexOf(objItem.b.r);
      if (intA < 0 || intB < 0) return [];
      return [{ hsRows: new Set(arrView.slice(Math.min(intA, intB), Math.max(intA, intB) + 1)), first: Math.min(objItem.a.c, objItem.b.c), last: Math.max(objItem.a.c, objItem.b.c) }];
    });
  }, [arrExtra, objBlock, objSelected, arrView]);
  const inBlock = (intRow: number, intCol: number) => arrAreas.some(objItem => objItem.hsRows.has(intRow) && intCol >= objItem.first && intCol <= objItem.last);
  // Everything selected, as rows (in the order shown) and columns (left to right).
  const objArea = useMemo(() => {
    if (arrAreas.length === 0) return null;
    const hsCols = new Set<number>();
    for (const objItem of arrAreas) for (let intCol = objItem.first; intCol <= objItem.last; intCol++) hsCols.add(intCol);
    return { rows: arrView.filter(intRow => arrAreas.some(objItem => objItem.hsRows.has(intRow))), cols: [...hsCols].sort((intA, intB) => intA - intB) };
  }, [arrAreas, arrView]);
  useEffect(() => { refOnBlock.current?.(objArea); }, [objArea]);

  const intTotalWidth = INDEX_W + arrWidths.reduce((intSum, intWidth) => intSum + intWidth, 0);
  const boolFiltered = arrView.length !== objResult.rows.length;

  const objVirtual = useVirtualizer({
    count: arrView.length,
    getScrollElement: () => refScroller.current,
    estimateSize: () => ROW_H,
    overscan: 20,
  });

  useEffect(() => {
    const intAt = objReveal ? arrView.indexOf(objReveal.row) : -1;
    if (intAt >= 0) objVirtual.scrollToIndex(intAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objReveal]);

  useEffect(() => {
    if (!objCommand) return;
    const strName = objCommand.name;
    if (strName === 'xlsx' || strName === 'csv') return exportRows(strName);
    if (strName === 'edit') { if (objSelected) beginEdit(objSelected.r, objSelected.c); return; }
    if (arrView.length === 0) return;
    const intAt = objSelected ? arrView.indexOf(objSelected.r) : -1;
    const intView = strName === 'first' ? 0 : strName === 'last' ? arrView.length - 1
      : Math.min(Math.max(intAt + (strName === 'next' ? 1 : -1), 0), arrView.length - 1);
    const intRow = arrView[intView];
    setObjSelected({ r: intRow, c: objSelected?.c ?? 0 });
    pickCell(intRow, { ctrlKey: false, shiftKey: false });
    onSelectRow?.(intRow);
    objVirtual.scrollToIndex(intView);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objCommand]);

  /** Empty text is NULL. Typing the loaded value back removes the change. */
  const commitEdit = () => {
    if (!objEditing || refEditClosed.current) return;
    if (objEditing.readOnly || !objEdit) return closeEdit();
    refEditClosed.current = true;
    const objOriginal = objResult.rows[objEditing.r]?.[objEditing.c];
    const strValue = objEditing.text === '' ? null : objEditing.text;
    const boolSame = strValue === null ? objOriginal === null || objOriginal === undefined : objOriginal !== null && display(objOriginal) === strValue;
    objEdit.onEdit(objEditing.r, objEditing.c, boolSame ? undefined : strValue);
    closeEdit();
  };
  const closeEdit = () => {
    refEditClosed.current = true;
    setObjEditing(null);
    refScroller.current?.focus({ preventScroll: true }); // keys keep working
  };

  /** The value on screen: the pending edit when there is one. */
  const valueAt = (intRow: number, intCol: number) => {
    const strCell = `${intRow}:${intCol}`;
    return objEdit?.dicChanges.has(strCell) ? objEdit.dicChanges.get(strCell) ?? null : objResult.rows[intRow]?.[intCol];
  };

  /** A cell that cannot be edited opens the same box read-only, so its text can be selected and copied. */
  const beginEdit = async (intRow: number, intCol: number) => {
    const objValue = valueAt(intRow, intCol);
    if (!objEdit || !objEdit.arrEditable[intCol] || !objEdit.canEdit(intRow)) {
      if (objValue === null || objValue === undefined) return;
      refEditClosed.current = false;
      return setObjEditing({ r: intRow, c: intCol, text: display(objValue), readOnly: true });
    }
    if (objEdit.start && !(await objEdit.start(intRow))) return;
    refEditClosed.current = false;
    setObjEditing({ r: intRow, c: intCol, text: objValue === null || objValue === undefined ? '' : display(objValue) });
  };

  const selectRows = (hsNext: Set<number>) => { setHsInner(hsNext); onRows?.(hsNext); };

  /** Stretches the block to this cell, from where it started (or from the current cell). Whole-row selection ends. */
  const blockTo = (intRow: number, intCol: number, objFrom?: { r: number; c: number }) => {
    const objStart = objFrom ?? objBlock?.a ?? objSelected ?? { r: intRow, c: intCol };
    setObjBlock(objStart.r === intRow && objStart.c === intCol ? null : { a: objStart, b: { r: intRow, c: intCol } });
    if (hsPicked.size > 0) selectRows(new Set());
  };

  /** Click: that row. Ctrl: add / remove it. Shift: the range from the last plain click, in the order shown. */
  const pickRow = (intRow: number, objKeys: { ctrlKey: boolean; shiftKey: boolean }) => {
    if (objKeys.shiftKey && refAnchor.current !== null) {
      const intFrom = arrView.indexOf(refAnchor.current);
      const intTo = arrView.indexOf(intRow);
      if (intFrom >= 0 && intTo >= 0) return selectRows(new Set(arrView.slice(Math.min(intFrom, intTo), Math.max(intFrom, intTo) + 1)));
    }
    refAnchor.current = intRow;
    if (!objKeys.ctrlKey) return selectRows(new Set([intRow]));
    const hsNext = new Set(hsPicked);
    if (!hsNext.delete(intRow)) hsNext.add(intRow);
    selectRows(hsNext);
  };

  /** A cell became the current one: that is not a row selection, unless Ctrl / Shift is held. */
  const pickCell = (intRow: number, objKeys: { ctrlKey: boolean; shiftKey: boolean }) => {
    if (objKeys.ctrlKey || objKeys.shiftKey) return pickRow(intRow, objKeys);
    refAnchor.current = intRow;
    if (hsPicked.size > 0) selectRows(new Set());
  };

  /**
   * Ctrl+V: tab-separated lines (what Ctrl+C gives, or cells from Excel) written into the cells that can be edited.
   * Starts at the first selected row's first column, else at the current cell; one copied line fills every selected row.
   * Nothing reaches the database before Save.
   */
  const onPaste = async (objEvent: React.ClipboardEvent) => {
    if (objEvent.target instanceof HTMLInputElement || !objEdit) return; // a cell or filter box pastes its own text
    const strText = objEvent.clipboardData.getData('text/plain');
    if (!strText) return;
    objEvent.preventDefault();
    const arrLines = strText.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map(strLine => strLine.split('\t'));
    const arrPickedRows = arrView.filter(intRow => hsPicked.has(intRow));
    const intFirstRow = arrPickedRows[0] ?? objSelected?.r;
    const intFirstCol = arrPickedRows.length > 0 ? 0 : objSelected?.c ?? 0;
    const intAt = intFirstRow === undefined ? -1 : arrView.indexOf(intFirstRow);
    if (intAt < 0) return;
    const arrTargets = arrLines.length === 1 && arrPickedRows.length > 1
      ? arrPickedRows.map(intRow => ({ intRow, arrLine: arrLines[0] }))
      : arrLines.flatMap((arrLine, intLine) => (arrView[intAt + intLine] === undefined ? [] : [{ intRow: arrView[intAt + intLine], arrLine }]));
    for (const { intRow, arrLine } of arrTargets) {
      if (!objEdit.canEdit(intRow) || (objEdit.start && !(await objEdit.start(intRow)))) continue;
      arrLine.forEach((strCell, intOffset) => {
        const intCol = intFirstCol + intOffset;
        if (intCol >= objResult.columns.length || !objEdit.arrEditable[intCol]) return;
        const strValue = strCell === '' ? null : strCell;
        // A loaded row: pasting what it already holds is not a change.
        const objOriginal = objResult.rows[intRow]?.[intCol];
        const boolSame = intRow < intBase && (strValue === null ? objOriginal === null || objOriginal === undefined : objOriginal !== null && objOriginal !== undefined && display(objOriginal) === strValue);
        objEdit.onEdit(intRow, intCol, boolSame ? undefined : strValue);
      });
    }
  };

  const onKey = (objEvent: React.KeyboardEvent) => {
    if (objEvent.target instanceof HTMLInputElement) return; // filter and cell boxes handle their own keys
    if (objEvent.ctrlKey && objEvent.key.toLowerCase() === 'a') {
      clearBlocks();
      selectRows(new Set(arrView));
      return objEvent.preventDefault();
    }
    if (objEvent.ctrlKey && objEvent.key.toLowerCase() === 'c') {
      // A block: its cells. Several rows: tab-separated lines. Else the cell.
      const strText = objArea
        // only the cells that are selected: blocks picked with Ctrl need not line up
        ? objArea.rows.map(intRow => objArea.cols.filter(intCol => inBlock(intRow, intCol)).map(intCol => display(valueAt(intRow, intCol))).join('\t')).join('\n')
        : hsPicked.size > 0
        ? arrView.filter(intRow => hsPicked.has(intRow)).map(intRow => objResult.columns.map((_, intCol) => display(valueAt(intRow, intCol))).join('\t')).join('\n')
        : objSelected ? display(valueAt(objSelected.r, objSelected.c)) : null;
      if (strText === null) return;
      navigator.clipboard.writeText(strText);
      return objEvent.preventDefault();
    }
    if (!objSelected || objEvent.ctrlKey || objEvent.altKey) return;
    if (objEvent.key === 'Enter' || objEvent.key === 'F2') {
      beginEdit(objSelected.r, objSelected.c);
      return objEvent.preventDefault();
    }
    const intAt = arrView.indexOf(objSelected.r);
    if (intAt < 0) return;
    const arrStep = ({ ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] } as Record<string, number[]>)[objEvent.key];
    if (!arrStep) return;
    objEvent.preventDefault();
    if (objEvent.shiftKey) {
      // Shift + arrows grow the block from the current cell; the current cell stays where it is.
      const objEnd = objBlock?.b ?? objSelected;
      const intEndAt = arrView.indexOf(objEnd.r);
      if (intEndAt < 0) return;
      const intEndView = Math.min(Math.max(intEndAt + arrStep[0], 0), arrView.length - 1);
      const intEndCol = Math.min(Math.max(objEnd.c + arrStep[1], 0), objResult.columns.length - 1);
      blockTo(arrView[intEndView], intEndCol, objBlock?.a ?? objSelected);
      if (arrStep[0] !== 0) objVirtual.scrollToIndex(intEndView);
      return;
    }
    clearBlocks();
    const intView = Math.min(Math.max(intAt + arrStep[0], 0), arrView.length - 1);
    const intCol = Math.min(Math.max(objSelected.c + arrStep[1], 0), objResult.columns.length - 1);
    const intRow = arrView[intView];
    setObjSelected({ r: intRow, c: intCol });
    onSelectRow?.(intRow);
    if (arrStep[0] !== 0) {
      pickCell(intRow, { ctrlKey: false, shiftKey: objEvent.shiftKey });
      objVirtual.scrollToIndex(intView);
    } else {
      requestAnimationFrame(() => refScroller.current?.querySelector(`[data-cell="${intRow}:${intCol}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    }
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
    <div ref={refScroller} tabIndex={0} onKeyDown={onKey} onPaste={onPaste}
      className="h-full overflow-auto font-mono text-[13px] outline-none">
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
              {!boolNoExport && (
                <button type="button" className="icon-btn icon-btn-sm" aria-haspopup="menu" aria-expanded={boolExportMenu}
                  aria-label="Export rows" title="Export the rows shown here to Excel or CSV" disabled={objResult.columns.length === 0}
                  onClick={() => setBoolExportMenu(boolPrev => !boolPrev)}>
                  <IconDownload intSize={14} />
                </button>
              )}
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
                className={`shrink-0 cursor-pointer truncate border-r border-line px-2 py-1 hover:bg-hover ${arrNumeric[intCol] ? 'text-right' : ''} ${
                  objEdit?.arrEditable[intCol] ? 'bg-accent/10 shadow-[inset_0_-2px_0_var(--accent)]' : ''}`}>
                <div className={`truncate text-[12px] font-semibold ${objEdit && !objEdit.arrEditable[intCol] ? 'opacity-60' : ''}`}>
                  {objEdit?.arrEditable[intCol] && <span className="mr-1 inline-block align-[-1px] text-accent"><IconPencil intSize={11} /></span>}
                  {objColumn.name}
                  {objSort?.col === intCol && <span className="ml-1 text-accent">{objSort.desc ? '▼' : '▲'}</span>}
                </div>
                <div className={`truncate text-[11px] text-muted ${objEdit && !objEdit.arrEditable[intCol] ? 'opacity-60' : ''}`}>{objColumn.dataType}</div>
              </div>
            ))}
          </div>

          {boolFilters && (
            <div className="flex border-t border-line border-b-2 border-b-accent/50 bg-accent/10">
              <div style={{ width: INDEX_W }} title={`Filter: ${arrView.length.toLocaleString()} of ${objResult.rows.length.toLocaleString()} loaded rows shown`}
                className={`flex shrink-0 items-center justify-end gap-1 border-r border-line px-1 text-[11px] ${boolFiltered ? 'font-semibold text-accent' : 'text-muted'}`}>
                <IconFilter intSize={11} />
                <span className="truncate">{arrView.length.toLocaleString()}</span>
              </div>
              {objResult.columns.map((objColumn, intCol) => {
                const boolSet = (dicFilters[intCol] ?? '').trim() !== '';
                return (
                  <div key={intCol} style={{ width: arrWidths[intCol] }} className="shrink-0 border-r border-line p-0.5">
                    <input value={dicFilters[intCol] ?? ''} placeholder="filter…" aria-label={`Filter ${objColumn.name}`}
                      onChange={objEvent => setDicFilters(dicPrev => ({ ...dicPrev, [intCol]: objEvent.target.value }))}
                      className={`h-6 w-full rounded-sm border bg-panel px-1.5 font-mono text-xs outline-none placeholder:italic placeholder:text-muted/60 focus:border-accent ${
                        boolSet ? 'border-accent' : 'border-line'}`} />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* rows */}
        <div style={{ height: objVirtual.getTotalSize(), position: 'relative' }}>
          {objVirtual.getVirtualItems().map(objItem => {
            const intRow = arrView[objItem.index];
            const arrRow = objResult.rows[intRow];
            const boolNew = intRow >= intBase;
            const boolDeleted = !!objEdit?.hsDeleted.has(intRow);
            const boolPicked = hsPicked.has(intRow);
            return (
              <div key={objItem.key}
                className={`absolute left-0 flex w-full border-b border-line/60 ${
                  boolDeleted ? 'bg-danger/15 line-through' : boolNew ? 'bg-success/15' : boolPicked ? 'bg-accent/25 shadow-[inset_0_1px_0_var(--accent),inset_0_-1px_0_var(--accent)]' : 'hover:bg-hover/60'}`}
                style={{ height: ROW_H, transform: `translateY(${objItem.start}px)` }}>
                <div style={{ width: INDEX_W }}
                  // Dragging down the numbers selects the rows from where the button went down.
                  onMouseDown={objEvent => { if (objEvent.button === 0 && !objEvent.ctrlKey && !objEvent.shiftKey) refRowDrag.current = intRow; }}
                  onMouseEnter={objEvent => {
                    const intFrom = refRowDrag.current === null ? -1 : arrView.indexOf(refRowDrag.current);
                    if (intFrom < 0 || !(objEvent.buttons & 1) || refRowDrag.current === intRow && hsPicked.size <= 1) return;
                    clearBlocks();
                    refAnchor.current = refRowDrag.current;
                    selectRows(new Set(arrView.slice(Math.min(intFrom, objItem.index), Math.max(intFrom, objItem.index) + 1)));
                  }}
                  onClick={objEvent => { clearBlocks(); setObjSelected(objPrev => ({ r: intRow, c: objPrev?.c ?? 0 })); pickRow(intRow, objEvent); onSelectRow?.(intRow); }}
                  title={boolDeleted ? 'Will be deleted on Save' : boolNew ? 'New row, inserted on Save' : 'Click to select the row (drag, Ctrl or Shift for several); Ctrl+C copies, Ctrl+V pastes'}
                  className={`shrink-0 cursor-pointer border-r border-line px-2 text-right leading-7 ${
                    boolDeleted ? 'font-semibold text-danger' : boolNew ? 'font-semibold text-success' : boolPicked ? 'bg-accent font-semibold text-accent-fg' : 'text-muted'}`}>
                  {boolDeleted ? '−' : boolNew ? '+' : objItem.index + 1}
                </div>
                {arrRow.map((objLoaded, intCol) => {
                  const boolSelected = objSelected?.r === intRow && objSelected.c === intCol;
                  const strCell = `${intRow}:${intCol}`;
                  const boolChanged = !!objEdit && objEdit.dicChanges.has(strCell);
                  const objValue = boolChanged ? objEdit.dicChanges.get(strCell) ?? null : objLoaded;
                  const boolCanEdit = !!objEdit && objEdit.arrEditable[intCol] && objEdit.canEdit(intRow);
                  if (objEditing?.r === intRow && objEditing.c === intCol) {
                    const strType = objResult.columns[intCol].dataType;
                    return (
                      // Leaving the cell (not for its own calendar button) ends the edit.
                      <div key={intCol} style={{ width: arrWidths[intCol] }} className="flex shrink-0 items-center border-r border-line/60 bg-panel"
                        onBlur={objEvent => { if (!refPickerOpen.current && !objEvent.currentTarget.contains(objEvent.relatedTarget)) commitEdit(); }}>
                        <input ref={refEditBox} autoFocus value={objEditing.text} placeholder="NULL" readOnly={objEditing.readOnly}
                          aria-label={`${objEditing.readOnly ? 'Value of' : 'Edit'} ${objResult.columns[intCol].name}`}
                          title={objEditing.readOnly ? 'Read-only: select and copy (Esc to close)' : undefined}
                          onFocus={objEditing.readOnly ? objEvent => objEvent.currentTarget.select() : undefined}
                          onChange={objEvent => setObjEditing({ ...objEditing, text: objEvent.target.value })}
                          onKeyDown={objEvent => {
                            if (objEvent.key === 'Enter') commitEdit();
                            else if (objEvent.key === 'Escape') closeEdit();
                          }}
                          className="h-7 min-w-0 flex-1 border border-accent bg-panel px-2 font-mono text-[13px] outline-none placeholder:italic placeholder:text-muted/60" />
                        {isDateType(strType) && !objEditing.readOnly && (
                          // The picker lives outside the cell (a popover): while it is open, focus leaving the cell is not the end of the edit.
                          <DatePickerButton boolSmall strValue={objEditing.text}
                            boolDateOnly={/^date$/i.test(strType) && objEditing.text !== '' && !/\d{2}:\d{2}/.test(objEditing.text)}
                            onOpenChange={boolOpen => {
                              refPickerOpen.current = boolOpen;
                              if (!boolOpen) requestAnimationFrame(() => refEditBox.current?.focus());
                            }}
                            onPick={strPicked => setObjEditing({ ...objEditing, text: strPicked })} />
                        )}
                      </div>
                    );
                  }
                  return (
                    <div key={intCol} style={{ width: arrWidths[intCol] }} data-cell={strCell}
                      onMouseDown={objEvent => {
                        if (objEvent.button !== 0 || objEvent.shiftKey) return;
                        if (objEvent.ctrlKey) {
                          // Ctrl: what is selected stays, and a new block starts at this cell.
                          const objKeep = objBlock ?? (objSelected ? { a: objSelected, b: objSelected } : null);
                          if (objKeep) setArrExtra(arrPrev => [...arrPrev, objKeep]);
                          setObjBlock(null);
                          setObjSelected({ r: intRow, c: intCol });
                          if (hsPicked.size > 0) selectRows(new Set());
                          onSelectRow?.(intRow);
                          refDrag.current = { r: intRow, c: intCol };
                          return;
                        }
                        refDrag.current = { r: intRow, c: intCol };
                        clearBlocks();
                      }}
                      // Dragging over other cells stretches a block from the cell where the button went down.
                      onMouseEnter={objEvent => {
                        const objFrom = refDrag.current;
                        if (!objFrom || !(objEvent.buttons & 1) || (objFrom.r === intRow && objFrom.c === intCol && !objBlock)) return;
                        setObjSelected(objFrom);
                        blockTo(intRow, intCol, objFrom);
                      }}
                      onClick={objEvent => {
                        // Shift + click: the block from the current cell to this one.
                        if (objEvent.ctrlKey) return; // the press already added this cell to the selection
                        if (objEvent.shiftKey && objSelected) return blockTo(intRow, intCol);
                        setObjSelected({ r: intRow, c: intCol }); pickCell(intRow, objEvent); onSelectRow?.(intRow);
                      }}
                      // Right-click outside what is selected moves the selection there first.
                      onContextMenu={() => {
                        if (inBlock(intRow, intCol) || hsPicked.has(intRow)) return;
                        clearBlocks();
                        setObjSelected({ r: intRow, c: intCol });
                        if (hsPicked.size > 0) selectRows(new Set());
                        onSelectRow?.(intRow);
                      }}
                      onDoubleClick={() => { beginEdit(intRow, intCol); }}
                      className={`shrink-0 truncate border-r border-line/60 px-2.5 leading-7 ${arrNumeric[intCol] ? 'text-right' : ''} ${
                        boolSelected ? 'bg-accent/15 outline outline-1 -outline-offset-1 outline-accent' : inBlock(intRow, intCol) ? 'bg-accent/25' : ''} ${
                        boolChanged ? 'bg-env-amber/25 font-semibold' : ''} ${objEdit && !objEdit.arrEditable[intCol] ? 'text-muted' : ''} ${boolCanEdit ? 'cursor-cell' : ''}`}>
                      {objValue === null || objValue === undefined ? <span className="text-muted italic">{boolNew && boolCanEdit ? 'default' : 'NULL'}</span> : display(objValue)}
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
