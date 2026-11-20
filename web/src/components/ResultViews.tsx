import { useMemo } from 'react';
import type { QueryResult } from '../types';
import { display } from './ResultGrid';

const TEXT_ROWS = 2000;
const TEXT_WIDTH = 60;
const RECORD_ROWS = 20;

const oneLine = (objValue: unknown) => (objValue === null || objValue === undefined ? '[NULL]' : display(objValue).replace(/\s+/g, ' '));
const fit = (strText: string, intWidth: number) => (strText.length > intWidth ? `${strText.slice(0, intWidth - 1)}…` : strText.padEnd(intWidth));

/** The rows as plain text in aligned columns, to read or copy. arrRows: indexes in objResult.rows. */
export function TextView({ objResult, arrRows }: { objResult: QueryResult; arrRows: number[] }) {
  const strText = useMemo(() => {
    const arrShown = arrRows.slice(0, TEXT_ROWS);
    const arrCells = arrShown.map(intRow => objResult.columns.map((_, intCol) => oneLine(objResult.rows[intRow]?.[intCol])));
    const arrWidths = objResult.columns.map((objColumn, intCol) =>
      Math.min(TEXT_WIDTH, arrCells.reduce((intMax, arrRow) => Math.max(intMax, arrRow[intCol].length), objColumn.name.length)));
    const line = (arrRow: string[]) => arrRow.map((strCell, intCol) => fit(strCell, arrWidths[intCol])).join(' | ');
    const arrLines = [line(objResult.columns.map(objColumn => objColumn.name)), arrWidths.map(intWidth => '-'.repeat(intWidth)).join('-+-'), ...arrCells.map(line)];
    if (arrRows.length > TEXT_ROWS) arrLines.push('', `(${(arrRows.length - TEXT_ROWS).toLocaleString()} more rows not shown as text)`);
    return arrLines.join('\n');
  }, [objResult, arrRows]);

  return <pre className="h-full overflow-auto p-2 font-mono text-xs leading-5" style={{ userSelect: 'text' }}>{strText}</pre>;
}

/** One column per row, one line per field: for wide rows. arrRows: indexes in objResult.rows. */
export function RecordView({ objResult, arrRows }: { objResult: QueryResult; arrRows: number[] }) {
  const arrShown = arrRows.slice(0, RECORD_ROWS);
  if (arrShown.length === 0) return <p className="p-3 text-xs text-muted">No row to show.</p>;
  return (
    <div className="h-full overflow-auto font-mono text-xs" style={{ userSelect: 'text' }}>
      <table className="border-collapse">
        <thead className="sticky top-0 z-10 bg-bg font-sans">
          <tr>
            <th className="border-b border-r border-line px-2 py-1 text-left font-semibold">Column</th>
            {arrShown.map(intRow => (
              <th key={intRow} className="border-b border-r border-line px-2 py-1 text-left font-semibold">Row {intRow + 1}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {objResult.columns.map((objColumn, intCol) => (
            <tr key={intCol} className="hover:bg-hover/60">
              <td className="whitespace-nowrap border-b border-r border-line/60 px-2 leading-6">
                <span className="font-sans font-semibold">{objColumn.name}</span> <span className="font-sans text-[11px] text-muted">{objColumn.dataType}</span>
              </td>
              {arrShown.map(intRow => {
                const objValue = objResult.rows[intRow]?.[intCol];
                return (
                  <td key={intRow} className="max-w-xl whitespace-pre-wrap break-all border-b border-r border-line/60 px-2 leading-6">
                    {objValue === null || objValue === undefined ? <span className="italic text-muted">NULL</span> : display(objValue)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {arrRows.length > RECORD_ROWS && <p className="p-2 font-sans text-muted">Showing the first {RECORD_ROWS} of {arrRows.length.toLocaleString()} selected rows.</p>}
    </div>
  );
}
