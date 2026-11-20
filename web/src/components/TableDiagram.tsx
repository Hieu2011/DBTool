import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import type { Connection, DbObjectInfo, QueryResult, SchemaMetadata } from '../types';
import {
  BOX_W, DiagramCanvas, GAP_X, GAP_Y, PAD, nodeHeight, rowsFor, type DiagramEdge, type DiagramNode, type DiagramRow,
} from './DiagramCanvas';

interface Props {
  objConnection: Connection;
  objObject: DbObjectInfo;
  /** Columns grid of the table (column, type) and the names of its primary key columns. */
  objColumns?: QueryResult;
  hsPrimary: Set<string>;
  /** Gives the related tables their full column list when their schema is loaded. */
  objMetadata?: SchemaMetadata;
  onOpenObject: (objObject: DbObjectInfo) => void;
}

interface Relation {
  direction: 'out' | 'in'; constraint: string; schema: string; table: string; columns: string[]; otherColumns: string[];
  /** Guessed from column names, not a declared foreign key. */
  inferred: boolean;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; relations: Relation[]; guessed: Relation[]; guessError: string | null };

const MAX_GUESSED = 25; // per side: a key like storeid can match hundreds of tables

const splitNames = (objValue: unknown) => String(objValue ?? '').split(',').map(strName => strName.trim()).filter(strName => strName !== '');
const messageOf = (objEx: unknown) => (objEx instanceof ApiError ? objEx.detail.message : (objEx as Error).message);

function toRelations(objGrid: QueryResult | undefined, boolInferred: boolean): Relation[] {
  if (!objGrid) return [];
  const indexOf = (strName: string) => objGrid.columns.findIndex(objColumn => objColumn.name === strName);
  const [intDirection, intConstraint, intSchema, intTable, intColumns, intOther] =
    ['direction', 'constraint', 'schema', 'table', 'columns', 'other_columns'].map(indexOf);
  return objGrid.rows.map(arrRow => ({
    direction: arrRow[intDirection] === 'in' ? 'in' : 'out',
    constraint: String(arrRow[intConstraint] ?? ''),
    schema: String(arrRow[intSchema] ?? ''),
    table: String(arrRow[intTable] ?? ''),
    columns: splitNames(arrRow[intColumns]),
    otherColumns: splitNames(arrRow[intOther]),
    inferred: boolInferred,
  }));
}

/** The table, the tables it references (left) and the tables that reference it (right), joined by their foreign keys. */
export function TableDiagram({ objConnection, objObject, objColumns, hsPrimary, objMetadata, onOpenObject }: Props) {
  const [objState, setObjState] = useState<LoadState>({ status: 'loading' });
  const [intReload, setIntReload] = useState(0);
  const [boolGuess, setBoolGuess] = useState(true);
  const { schema: strSchema, name: strName, type: strType } = objObject;

  useEffect(() => {
    let boolStale = false;
    setObjState({ status: 'loading' });
    const objTarget = { schema: strSchema, name: strName, type: strType };
    (async () => {
      try {
        const objDeclared = await api.objectDetail(objConnection.id, objTarget, true, 'Relations');
        // The guess is a bonus: when it fails the declared keys still show.
        let arrGuessed: Relation[] = [];
        let strGuessError: string | null = null;
        try {
          arrGuessed = toRelations((await api.objectDetail(objConnection.id, objTarget, true, 'InferredRelations')).sections[0]?.result, true);
        } catch (objEx) {
          strGuessError = messageOf(objEx);
        }
        if (!boolStale)
          setObjState({ status: 'done', relations: toRelations(objDeclared.sections[0]?.result, false), guessed: arrGuessed, guessError: strGuessError });
      } catch (objEx) {
        if (!boolStale) setObjState({ status: 'error', message: messageOf(objEx) });
      }
    })();
    return () => { boolStale = true; };
  }, [objConnection.id, strSchema, strName, strType, intReload]);

  // Declared keys first; a guess is dropped when its table is already linked. Guesses are capped per side.
  const objShown = useMemo(() => {
    if (objState.status !== 'done') return null;
    const arrAll = [...objState.relations];
    const hsTables = new Set(arrAll.map(objRelation => `${objRelation.schema}.${objRelation.table}`));
    const dicCount = { out: 0, in: 0 };
    let intHidden = 0;
    if (boolGuess) {
      for (const objRelation of objState.guessed) {
        const strKey = `${objRelation.schema}.${objRelation.table}`;
        if (hsTables.has(strKey)) continue;
        if (dicCount[objRelation.direction] >= MAX_GUESSED) { intHidden++; continue; }
        dicCount[objRelation.direction]++;
        hsTables.add(strKey);
        arrAll.push(objRelation);
      }
    }
    return { relations: arrAll, hidden: intHidden, guessedShown: dicCount.out + dicCount.in };
  }, [objState, boolGuess]);

  const objGraph = useMemo(() => {
    if (!objShown) return null;
    const arrRelations = objShown.relations;
    const strCenterKey = `${strSchema}.${strName}`;
    const isSelf = (objRelation: Relation) => `${objRelation.schema}.${objRelation.table}` === strCenterKey;
    const hsOwnKeys = new Set(arrRelations.flatMap(objRelation => objRelation.columns));

    // the table itself, with every column
    const intColumn = objColumns?.columns.findIndex(objColumn => objColumn.name === 'column') ?? -1;
    const intType = objColumns?.columns.findIndex(objColumn => objColumn.name === 'type') ?? -1;
    const arrOwnRows: DiagramRow[] = (objColumns?.rows ?? []).map(arrRow => {
      const strColumn = String(arrRow[intColumn] ?? '');
      return { name: strColumn, type: String(arrRow[intType] ?? ''), key: hsOwnKeys.has(strColumn), primary: hsPrimary.has(strColumn) };
    });

    // one box per related table, on the side of its first relation
    const dicSides = new Map<string, { schema: string; name: string; left: boolean; keys: Set<string> }>();
    for (const objRelation of arrRelations) {
      if (isSelf(objRelation)) continue;
      const strKey = `${objRelation.schema}.${objRelation.table}`;
      const objSide = dicSides.get(strKey) ?? { schema: objRelation.schema, name: objRelation.table, left: objRelation.direction === 'out', keys: new Set<string>() };
      objRelation.otherColumns.forEach(strColumn => objSide.keys.add(strColumn));
      dicSides.set(strKey, objSide);
    }

    const boolLeft = [...dicSides.values()].some(objSide => objSide.left);
    const intCenterX = PAD + (boolLeft ? BOX_W + GAP_X : 0);
    const arrNodes: DiagramNode[] = [
      { key: strCenterKey, schema: strSchema, name: strName, highlight: true, rows: arrOwnRows, more: 0, x: intCenterX, y: PAD },
    ];
    let intLeftY = PAD;
    let intRightY = PAD;
    for (const [strKey, objSide] of dicSides) {
      const arrMeta = objMetadata?.tables.find(objTable => objTable.schema === objSide.schema && objTable.name === objSide.name)?.columns;
      const { rows: arrRows, more: intMore } = rowsFor(arrMeta, objSide.keys, new Set());
      arrNodes.push({
        key: strKey, schema: objSide.schema, name: objSide.name, highlight: false, rows: arrRows, more: intMore,
        x: objSide.left ? PAD : intCenterX + BOX_W + GAP_X, y: objSide.left ? intLeftY : intRightY,
      });
      const intStep = nodeHeight(arrRows.length, intMore) + GAP_Y;
      if (objSide.left) intLeftY += intStep; else intRightY += intStep;
    }

    const arrEdges: DiagramEdge[] = arrRelations.filter(objRelation => !isSelf(objRelation)).map(objRelation => {
      const strOtherKey = `${objRelation.schema}.${objRelation.table}`;
      const boolOut = objRelation.direction === 'out';
      const strLabel = boolOut
        ? `${objRelation.constraint}: ${strName} (${objRelation.columns.join(', ')}) → ${objRelation.table} (${objRelation.otherColumns.join(', ')})`
        : `${objRelation.constraint}: ${objRelation.table} (${objRelation.otherColumns.join(', ')}) → ${strName} (${objRelation.columns.join(', ')})`;
      return {
        key: `${objRelation.direction}-${strOtherKey}-${objRelation.constraint}`,
        from: boolOut ? strCenterKey : strOtherKey, fromColumn: boolOut ? objRelation.columns[0] : objRelation.otherColumns[0],
        to: boolOut ? strOtherKey : strCenterKey, toColumn: boolOut ? objRelation.otherColumns[0] : objRelation.columns[0],
        label: objRelation.inferred ? `Guessed from the column name: ${strLabel}` : strLabel, inferred: objRelation.inferred,
      };
    });

    return { nodes: arrNodes, edges: arrEdges, selfCount: arrRelations.filter(isSelf).length };
  }, [objShown, objColumns, hsPrimary, objMetadata, strSchema, strName]);

  if (objState.status === 'loading') return <p className="p-4 text-muted">Loading relations…</p>;
  if (objState.status === 'error')
    return <p className="whitespace-pre-wrap p-4 font-mono text-xs text-danger" style={{ userSelect: 'text' }}>{objState.message}</p>;
  if (!objGraph || !objShown) return null;

  return (
    <DiagramCanvas objConnection={objConnection} strDiagram={`table|${strSchema}.${strName}`} strHomeSchema={strSchema}
      arrNodes={objGraph.nodes} arrEdges={objGraph.edges} onReload={() => setIntReload(intPrev => intPrev + 1)} onOpenObject={onOpenObject}
      objStatus={(
        <>
          {objGraph.edges.length === 0
            ? 'No relation found: no foreign key is declared and no other table shares a key column.'
            : `${objGraph.edges.length - objShown.guessedShown} declared, ${objShown.guessedShown} guessed (dashed) · references on the left, referenced by on the right`}
          {objGraph.selfCount > 0 && ` · ${objGraph.selfCount} to itself (not drawn)`}
          {objShown.hidden > 0 && ` · ${objShown.hidden} more guessed tables not shown`}
          {objState.guessError && <span className="text-danger" title={objState.guessError}> · guessing failed</span>}
        </>
      )}
      objToolbar={(
        <button className={`btn h-6 px-2 ${boolGuess ? 'text-accent' : ''}`} aria-pressed={boolGuess} onClick={() => setBoolGuess(boolPrev => !boolPrev)}
          title="Links a table to another when it has all of that table's primary key columns (same names, same schema)">
          {boolGuess ? '✓ ' : ''}Guess relations
        </button>
      )} />
  );
}
