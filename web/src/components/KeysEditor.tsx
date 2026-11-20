import { useMemo, useState } from 'react';
import {
  addConstraintSql, addIndexSql, dropConstraintSql, dropIndexSql, validateConstraint, validateIndex,
  type ConstraintType, type NewConstraint, type NewIndex,
} from '../sql/alterTable';
import type { Connection, QueryResult } from '../types';
import { IconPlus, IconTrash, IconUndo } from './icons';
import { ScriptReview } from './ScriptReview';

interface Props {
  objConnection: Connection;
  strMode: 'Constraints' | 'Indexes';
  /** Qualified, quoted table name, and its schema as the catalog spells it. */
  strTable: string;
  strSchema: string;
  /** The Constraints / Indexes grid of the object viewer; its first column is the name. */
  objGrid: QueryResult;
  arrColumnNames: string[];
  onOpenSql: (strSql: string, boolAutoRun: boolean) => void;
  onApplied: () => void;
  onClose: () => void;
}

const CONSTRAINT_TYPES: ConstraintType[] = ['PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY', 'CHECK'];
const INPUT = 'field h-6 min-w-0 font-mono text-xs';

/** Adds and drops a table's constraints or indexes. Changing one = drop it and add it again. */
export function KeysEditor({ objConnection, strMode, strTable, strSchema, objGrid, arrColumnNames, onOpenSql, onApplied, onClose }: Props) {
  const boolConstraints = strMode === 'Constraints';
  const strKind = objConnection.kind;
  const strNoun = boolConstraints ? 'constraint' : 'index';

  const [arrDropped, setArrDropped] = useState<string[]>([]);
  const [arrConstraints, setArrConstraints] = useState<NewConstraint[]>([]);
  const [arrIndexes, setArrIndexes] = useState<NewIndex[]>([]);
  const [intAdded, setIntAdded] = useState(0);
  const [boolReview, setBoolReview] = useState(false);

  const intPrimaryCol = objGrid.columns.findIndex(objColumn => objColumn.name === 'primary');

  const strInvalid = useMemo(() => {
    for (const objItem of arrConstraints) { const strError = validateConstraint(objItem); if (strError) return strError; }
    for (const objItem of arrIndexes) { const strError = validateIndex(objItem); if (strError) return strError; }
    return null;
  }, [arrConstraints, arrIndexes]);

  // Drops first so a replacement can reuse the name.
  const arrScript = useMemo(() => (strInvalid ? [] : [
    ...arrDropped.map(strName => (boolConstraints ? dropConstraintSql(strTable, strKind, strName) : dropIndexSql(strSchema, strKind, strName))),
    ...arrConstraints.map(objItem => addConstraintSql(strTable, strKind, objItem, arrColumnNames)),
    ...arrIndexes.map(objItem => addIndexSql(strTable, strSchema, strKind, objItem, arrColumnNames)),
  ]), [strInvalid, arrDropped, arrConstraints, arrIndexes, boolConstraints, strTable, strSchema, strKind, arrColumnNames]);

  const toggleDrop = (strName: string) =>
    setArrDropped(arrPrev => (arrPrev.includes(strName) ? arrPrev.filter(strItem => strItem !== strName) : [...arrPrev, strName]));

  const add = () => {
    const strKey = `new-${intAdded}`;
    setIntAdded(intPrev => intPrev + 1);
    if (boolConstraints)
      setArrConstraints(arrPrev => [...arrPrev, { key: strKey, name: '', type: 'UNIQUE', columns: '', refTable: '', refColumns: '', onDelete: '', check: '' }]);
    else setArrIndexes(arrPrev => [...arrPrev, { key: strKey, name: '', unique: false, columns: '' }]);
  };

  const patchConstraint = (strKey: string, objPatch: Partial<NewConstraint>) =>
    setArrConstraints(arrPrev => arrPrev.map(objItem => (objItem.key === strKey ? { ...objItem, ...objPatch } : objItem)));
  const patchIndex = (strKey: string, objPatch: Partial<NewIndex>) =>
    setArrIndexes(arrPrev => arrPrev.map(objItem => (objItem.key === strKey ? { ...objItem, ...objPatch } : objItem)));

  const discard = () => { setArrDropped([]); setArrConstraints([]); setArrIndexes([]); };

  if (boolReview) {
    return (
      <ScriptReview objConnection={objConnection} arrScript={arrScript} onBack={() => setBoolReview(false)} onApplied={() => onApplied()}
        strWarning={arrDropped.length > 0
          ? (boolConstraints
            ? 'Dropping a constraint stops the database from enforcing it. A dropped key may also drop its index.'
            : 'Queries that rely on a dropped index can become slow.')
          : undefined} />
    );
  }

  const strColumnsHint = `Columns of this table: ${arrColumnNames.join(', ')}`;

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-3">
        <button className="btn h-6 px-2" onClick={add}><IconPlus intSize={12} /> Add {strNoun}</button>
        <span className={`ml-2 truncate ${strInvalid ? 'text-danger' : 'text-muted'}`}>
          {strInvalid ?? (arrScript.length === 0 ? 'No changes' : `${arrScript.length} pending ${arrScript.length === 1 ? 'statement' : 'statements'}`)}
        </span>
        <div className="ml-auto flex shrink-0 gap-1.5">
          <button className="btn h-6 px-2" onClick={discard} disabled={arrScript.length === 0 && !strInvalid}>Discard</button>
          <button className="btn h-6 px-2" disabled={arrScript.length === 0} title="Open the script in a query tab without running it"
            onClick={() => onOpenSql(arrScript.map(strStatement => `${strStatement};`).join('\n'), false)}>Script changes</button>
          <button className="btn btn-primary h-6 px-2" disabled={arrScript.length === 0} title="Review the script, then run it"
            onClick={() => setBoolReview(true)}>Apply changes…</button>
          <button className="btn h-6 px-2" onClick={onClose}>Close editor</button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {/* existing */}
        {objGrid.rows.length === 0 && <p className="px-3 py-2 text-muted">This table has no {strNoun} yet.</p>}
        {objGrid.rows.map(arrRow => {
          const strName = String(arrRow[0] ?? '');
          const boolDropped = arrDropped.includes(strName);
          // PostgreSQL marks the index behind the primary key: it goes away with the constraint, not on its own.
          const boolLocked = !boolConstraints && intPrimaryCol >= 0 && arrRow[intPrimaryCol] === true;
          const strDetail = arrRow.slice(1)
            .map((objValue, intCol) => (objValue === null || objValue === '' ? null : `${objGrid.columns[intCol + 1].name}: ${String(objValue)}`))
            .filter(strPart => strPart !== null).join(' · ');
          return (
            <div key={strName} className="flex items-center gap-2 border-b border-line/60 px-3 py-1 hover:bg-hover/40">
              <span className={`w-64 shrink-0 truncate font-mono ${boolDropped ? 'text-muted line-through' : ''}`} title={strName}>{strName}</span>
              <span className={`min-w-0 flex-1 truncate ${boolDropped ? 'text-muted line-through' : 'text-muted'}`} title={strDetail}>{strDetail}</span>
              {boolDropped && <span className="shrink-0 text-danger">will be dropped</span>}
              <button type="button" className="icon-btn" onClick={() => toggleDrop(strName)} disabled={boolLocked}
                aria-label={boolDropped ? `Keep ${strNoun}` : `Drop ${strNoun}`}
                title={boolLocked ? 'Belongs to the primary key: drop the constraint instead' : boolDropped ? `Keep ${strNoun}` : `Drop ${strNoun}`}>
                {boolDropped ? <IconUndo intSize={13} /> : <IconTrash intSize={13} />}
              </button>
            </div>
          );
        })}

        {/* new constraints */}
        {arrConstraints.map(objItem => (
          <div key={objItem.key} className="flex flex-wrap items-center gap-1.5 border-b border-line/60 bg-success/5 px-3 py-1.5">
            <span className="w-3 text-success">+</span>
            <input className={`${INPUT} w-48`} value={objItem.name} placeholder="name (optional)" aria-label="Constraint name"
              onChange={objEvent => patchConstraint(objItem.key, { name: objEvent.target.value })} />
            <select className="field h-6 w-auto py-0 text-xs" value={objItem.type} aria-label="Constraint type"
              onChange={objEvent => patchConstraint(objItem.key, { type: objEvent.target.value as ConstraintType })}>
              {CONSTRAINT_TYPES.map(strType => <option key={strType} value={strType}>{strType}</option>)}
            </select>
            {objItem.type === 'CHECK'
              ? (
                <input className={`${INPUT} flex-1`} value={objItem.check} placeholder="condition, e.g. amount >= 0" aria-label="Check condition"
                  onChange={objEvent => patchConstraint(objItem.key, { check: objEvent.target.value })} />
              )
              : (
                <input className={`${INPUT} w-56 flex-1`} value={objItem.columns} placeholder="columns: col1, col2" aria-label="Columns" title={strColumnsHint}
                  onChange={objEvent => patchConstraint(objItem.key, { columns: objEvent.target.value })} />
              )}
            {objItem.type === 'FOREIGN KEY' && (
              <>
                <span className="text-muted">references</span>
                <input className={`${INPUT} w-48`} value={objItem.refTable} placeholder="schema.table" aria-label="Referenced table"
                  onChange={objEvent => patchConstraint(objItem.key, { refTable: objEvent.target.value })} />
                <input className={`${INPUT} w-40`} value={objItem.refColumns} placeholder="its columns (optional)" aria-label="Referenced columns"
                  title="Empty = the referenced table's primary key"
                  onChange={objEvent => patchConstraint(objItem.key, { refColumns: objEvent.target.value })} />
                <select className="field h-6 w-auto py-0 text-xs" value={objItem.onDelete} aria-label="On delete"
                  onChange={objEvent => patchConstraint(objItem.key, { onDelete: objEvent.target.value as NewConstraint['onDelete'] })}>
                  <option value="">on delete: restrict</option>
                  <option value="CASCADE">on delete: cascade</option>
                  <option value="SET NULL">on delete: set null</option>
                </select>
              </>
            )}
            <button type="button" className="icon-btn" aria-label="Remove" title="Remove"
              onClick={() => setArrConstraints(arrPrev => arrPrev.filter(objOther => objOther.key !== objItem.key))}>
              <IconTrash intSize={13} />
            </button>
          </div>
        ))}

        {/* new indexes */}
        {arrIndexes.map(objItem => (
          <div key={objItem.key} className="flex flex-wrap items-center gap-1.5 border-b border-line/60 bg-success/5 px-3 py-1.5">
            <span className="w-3 text-success">+</span>
            <input className={`${INPUT} w-56`} value={objItem.name} placeholder="index name" aria-label="Index name"
              onChange={objEvent => patchIndex(objItem.key, { name: objEvent.target.value })} />
            <label className="flex items-center gap-1 text-muted">
              <input type="checkbox" checked={objItem.unique} onChange={objEvent => patchIndex(objItem.key, { unique: objEvent.target.checked })} />
              Unique
            </label>
            <input className={`${INPUT} flex-1`} value={objItem.columns} placeholder="columns: col1, col2 DESC" aria-label="Columns" title={strColumnsHint}
              onChange={objEvent => patchIndex(objItem.key, { columns: objEvent.target.value })} />
            <button type="button" className="icon-btn" aria-label="Remove" title="Remove"
              onClick={() => setArrIndexes(arrPrev => arrPrev.filter(objOther => objOther.key !== objItem.key))}>
              <IconTrash intSize={13} />
            </button>
          </div>
        ))}

        <p className="p-3 text-muted">
          To change {boolConstraints ? 'a constraint' : 'an index'}, drop it and add it again: both run in one script.
          {!boolConstraints && ' An index that backs a primary key or unique constraint is dropped with that constraint.'}
        </p>
      </div>
    </div>
  );
}
