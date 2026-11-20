import { useMemo, useState } from 'react';
import {
  buildAlterScript, buildRebuildScript, catalogName, isChanged, isReordered, renameTableSql, validate, type ColumnDraft,
} from '../sql/alterTable';
import type { Connection, QueryResult } from '../types';
import { IconChevronDown, IconPlus, IconTrash, IconUndo } from './icons';
import { ScriptReview } from './ScriptReview';

interface Props {
  objConnection: Connection;
  /** Qualified, quoted table name, then its schema and name as the catalog spells them. */
  strTable: string;
  strSchema: string;
  strName: string;
  /** Constraints / Indexes grids, copied into the rebuild script when the column order changes. */
  objConstraints?: QueryResult;
  objIndexes?: QueryResult;
  /** The Columns grid of the object viewer: column, type, nullable, default, comment. */
  objColumns: QueryResult;
  strComment: string;
  onOpenSql: (strSql: string, boolAutoRun: boolean) => void;
  /** Statements ran (all or some): the caller reloads the object. strNewName is set when the table was renamed. */
  onApplied: (strNewName?: string) => void;
  onClose: () => void;
}

function toDrafts(objColumns: QueryResult): ColumnDraft[] {
  const indexOf = (strName: string) => objColumns.columns.findIndex(objColumn => objColumn.name === strName);
  const [intName, intType, intNullable, intDefault, intComment] = ['column', 'type', 'nullable', 'default', 'comment'].map(indexOf);
  return objColumns.rows.map((arrRow, intRow) => {
    const objOriginal = {
      name: String(arrRow[intName] ?? ''),
      type: String(arrRow[intType] ?? ''),
      notNull: arrRow[intNullable] === false || arrRow[intNullable] === 'N',
      default: String(arrRow[intDefault] ?? '').trim(),
      comment: String(arrRow[intComment] ?? ''),
    };
    return { ...objOriginal, key: `col-${intRow}`, original: objOriginal, dropped: false };
  });
}

/** Edits a table's columns and comments, then shows the ALTER script before anything runs. */
export function TableEditor({
  objConnection, strTable, strSchema, strName, objConstraints, objIndexes, objColumns, strComment, onOpenSql, onApplied, onClose,
}: Props) {
  const [arrDrafts, setArrDrafts] = useState<ColumnDraft[]>(() => toDrafts(objColumns));
  const [strNewComment, setStrNewComment] = useState(strComment);
  const [strNewName, setStrNewName] = useState(strName);
  const [boolReview, setBoolReview] = useState(false);
  const [intAdded, setIntAdded] = useState(0);

  const strKind = objConnection.kind;
  const strRenamed = strNewName.trim() !== strName ? strNewName.trim() : null;
  const strInvalid = useMemo(() => (strNewName.trim() === '' ? 'The table needs a name.' : validate(arrDrafts)), [arrDrafts, strNewName]);
  // The rename goes last: every statement before it still uses the old name.
  const arrScript = useMemo(() => (strInvalid ? [] : [
    ...buildAlterScript(strTable, strKind, arrDrafts, strComment, strNewComment),
    ...(strRenamed ? [renameTableSql(strTable, strKind, strRenamed)] : []),
  ]), [strInvalid, strTable, strKind, arrDrafts, strComment, strNewComment, strRenamed]);
  // No ALTER can move a column: the order is changed by a rebuild script the user runs by hand.
  const boolReordered = useMemo(() => isReordered(arrDrafts), [arrDrafts]);
  const boolPending = arrScript.length > 0 || (boolReordered && !strInvalid);

  const move = (intRow: number, intDelta: number) => setArrDrafts(arrPrev => {
    const intTarget = intRow + intDelta;
    if (intTarget < 0 || intTarget >= arrPrev.length) return arrPrev;
    const arrNext = [...arrPrev];
    [arrNext[intRow], arrNext[intTarget]] = [arrNext[intTarget], arrNext[intRow]];
    return arrNext;
  });

  const openScript = () => onOpenSql(boolReordered
    ? buildRebuildScript({ strSchema, strName, strKind, arrDrafts, strNewComment, strNewName: strRenamed, objConstraints, objIndexes })
    : arrScript.map(strStatement => `${strStatement};`).join('\n'), false);
  const boolDrops = arrDrafts.some(objDraft => objDraft.dropped && objDraft.original);

  const patch = (strKey: string, objPatch: Partial<ColumnDraft>) =>
    setArrDrafts(arrPrev => arrPrev.map(objDraft => (objDraft.key === strKey ? { ...objDraft, ...objPatch } : objDraft)));

  const addColumn = () => {
    setArrDrafts(arrPrev => [...arrPrev, { key: `new-${intAdded}`, name: '', type: '', notNull: false, default: '', comment: '', dropped: false }]);
    setIntAdded(intPrev => intPrev + 1);
  };

  // A column that was never saved just disappears; an existing one is marked and can be restored.
  const toggleDrop = (objDraft: ColumnDraft) => (objDraft.original
    ? patch(objDraft.key, { dropped: !objDraft.dropped })
    : setArrDrafts(arrPrev => arrPrev.filter(objItem => objItem.key !== objDraft.key)));

  const discard = () => {
    setArrDrafts(toDrafts(objColumns));
    setStrNewComment(strComment);
    setStrNewName(strName);
  };

  if (boolReview) {
    return (
      <ScriptReview objConnection={objConnection} arrScript={arrScript} onBack={() => setBoolReview(false)}
        onApplied={boolAll => onApplied(boolAll && strRenamed ? catalogName(strRenamed, strKind) : undefined)}
        strWarning={boolDrops ? 'Dropping a column deletes its data. This cannot be undone.' : undefined} />
    );
  }

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-3">
        <button className="btn h-6 px-2" onClick={addColumn}><IconPlus intSize={12} /> Add column</button>
        <span className={`ml-2 truncate ${strInvalid ? 'text-danger' : 'text-muted'}`}>
          {strInvalid ?? (boolReordered
            ? 'Column order changed: the table must be rebuilt. Use Script changes and review the script.'
            : arrScript.length === 0 ? 'No changes' : `${arrScript.length} pending ${arrScript.length === 1 ? 'statement' : 'statements'}`)}
        </span>
        <div className="ml-auto flex shrink-0 gap-1.5">
          <button className="btn h-6 px-2" onClick={discard} disabled={!boolPending && !strInvalid}>Discard</button>
          <button className="btn h-6 px-2" disabled={!boolPending} title="Open the script in a query tab without running it"
            onClick={openScript}>Script changes</button>
          <button className="btn btn-primary h-6 px-2" disabled={arrScript.length === 0 || boolReordered}
            title={boolReordered ? 'A new column order needs a table rebuild: use Script changes' : 'Review the ALTER script, then run it'}
            onClick={() => setBoolReview(true)}>Apply changes…</button>
          <button className="btn h-6 px-2" onClick={onClose}>Close editor</button>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-1.5 text-muted">
        <label className="flex items-center gap-2">
          Table name
          <input className="field h-6 w-56 font-mono text-xs" value={strNewName} onChange={objEvent => setStrNewName(objEvent.target.value)} />
        </label>
        <label className="flex min-w-0 flex-1 items-center gap-2">
          Comment
          <input className="field h-6 min-w-0 flex-1 text-xs" value={strNewComment} onChange={objEvent => setStrNewComment(objEvent.target.value)} />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 bg-bg text-left">
            <tr>
              {['', 'Name', 'Data type', 'Not null', 'Default', 'Comment', ''].map((strHead, intIndex) => (
                <th key={intIndex} className="border-b border-r border-line px-2 py-1 font-semibold">{strHead}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {arrDrafts.map((objDraft, intRow) => {
              const boolDropped = objDraft.dropped;
              const strCell = `h-6 w-full bg-transparent px-2 font-mono text-xs outline-none focus:bg-panel ${boolDropped ? 'text-muted line-through' : ''}`;
              return (
                <tr key={objDraft.key} className="border-b border-line/60 hover:bg-hover/40">
                  <td className={`w-10 border-r border-line px-2 text-right ${!objDraft.original ? 'text-success' : isChanged(objDraft) ? 'text-accent' : 'text-muted'}`}
                    title={!objDraft.original ? 'New column' : boolDropped ? 'Will be dropped' : isChanged(objDraft) ? 'Changed' : ''}>
                    {!objDraft.original ? '+' : boolDropped ? '×' : isChanged(objDraft) ? '•' : intRow + 1}
                  </td>
                  <td className="w-[22%] border-r border-line/60">
                    <input className={strCell} value={objDraft.name} disabled={boolDropped} placeholder="column_name" aria-label="Column name"
                      onChange={objEvent => patch(objDraft.key, { name: objEvent.target.value })} />
                  </td>
                  <td className="w-[20%] border-r border-line/60">
                    <input className={strCell} value={objDraft.type} disabled={boolDropped} aria-label="Data type"
                      placeholder={objConnection.kind === 'Oracle' ? 'VARCHAR2(50)' : 'varchar(50)'}
                      onChange={objEvent => patch(objDraft.key, { type: objEvent.target.value })} />
                  </td>
                  <td className="w-16 border-r border-line/60 text-center">
                    <input type="checkbox" checked={objDraft.notNull} disabled={boolDropped} aria-label="Not null"
                      onChange={objEvent => patch(objDraft.key, { notNull: objEvent.target.checked })} />
                  </td>
                  <td className="w-[18%] border-r border-line/60">
                    <input className={strCell} value={objDraft.default} disabled={boolDropped} aria-label="Default" title="SQL expression, e.g. 0, 'N', SYSDATE"
                      onChange={objEvent => patch(objDraft.key, { default: objEvent.target.value })} />
                  </td>
                  <td className="border-r border-line/60">
                    <input className={strCell.replace('font-mono ', '')} value={objDraft.comment} disabled={boolDropped} aria-label="Comment"
                      onChange={objEvent => patch(objDraft.key, { comment: objEvent.target.value })} />
                  </td>
                  <td className="w-24 whitespace-nowrap text-center">
                    <button type="button" className="icon-btn" onClick={() => move(intRow, -1)} disabled={intRow === 0}
                      aria-label="Move up" title="Move up"><IconChevronDown intSize={13} className="rotate-180" /></button>
                    <button type="button" className="icon-btn" onClick={() => move(intRow, 1)} disabled={intRow === arrDrafts.length - 1}
                      aria-label="Move down" title="Move down"><IconChevronDown intSize={13} /></button>
                    <button type="button" className="icon-btn" onClick={() => toggleDrop(objDraft)}
                      aria-label={boolDropped ? 'Keep column' : 'Drop column'} title={boolDropped ? 'Keep column' : 'Drop column'}>
                      {boolDropped ? <IconUndo intSize={13} /> : <IconTrash intSize={13} />}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="p-3 text-muted">
          Default is a SQL expression (text needs quotes). Keys and indexes are edited on their own tabs. Moving a column needs a table rebuild, which is only offered as a script.
        </p>
      </div>
    </div>
  );
}
