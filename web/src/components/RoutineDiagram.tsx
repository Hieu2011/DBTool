import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import type { Connection, DbObjectInfo, QueryResult, SchemaMetadata } from '../types';
import { BOX_W, DiagramCanvas, GAP_X, GAP_Y, PAD, nodeHeight, rowsFor, type DiagramEdge, type DiagramNode } from './DiagramCanvas';

interface Props {
  objConnection: Connection;
  /** A procedure, function or (Oracle) package. */
  objObject: DbObjectInfo;
  /** Column lists of the tables. */
  objMetadata?: SchemaMetadata;
  onOpenObject: (objObject: DbObjectInfo) => void;
}

interface UsedTable { key: string; schema: string; name: string; primary: string[] }
interface Link { from: string; fromColumns: string[]; to: string; toColumns: string[]; constraint: string; inferred: boolean }

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; tables: UsedTable[]; declared: Link[] };

const GENERIC_KEYS = new Set(['id', 'code', 'name']); // every table has one: not a relation
const MAX_COLUMNS = 4;

const splitNames = (objValue: unknown) => String(objValue ?? '').split(',').map(strName => strName.trim()).filter(strName => strName !== '');

function cells(objGrid: QueryResult | undefined, arrNames: string[]) {
  if (!objGrid) return [];
  const arrIndexes = arrNames.map(strName => objGrid.columns.findIndex(objColumn => objColumn.name === strName));
  return objGrid.rows.map(arrRow => arrIndexes.map(intCol => String(arrRow[intCol] ?? '')));
}

/** The tables a procedure / function works with, and how they relate to each other. */
export function RoutineDiagram({ objConnection, objObject, objMetadata, onOpenObject }: Props) {
  const [objState, setObjState] = useState<LoadState>({ status: 'loading' });
  const [intReload, setIntReload] = useState(0);
  const [boolGuess, setBoolGuess] = useState(true);
  const { schema: strSchema, name: strName, type: strType, signature: strSignature } = objObject;

  useEffect(() => {
    let boolStale = false;
    setObjState({ status: 'loading' });
    const objTarget = { schema: strSchema, name: strName, type: strType, signature: strSignature };
    Promise.all([
      api.objectDetail(objConnection.id, objTarget, true, 'RoutineTables'),
      api.objectDetail(objConnection.id, objTarget, true, 'RoutineRelations'),
    ]).then(
      ([objTables, objRelations]) => {
        if (boolStale) return;
        setObjState({
          status: 'done',
          tables: cells(objTables.sections[0]?.result, ['schema', 'table', 'primary_key']).map(([strTableSchema, strTable, strPrimary]) => ({
            key: `${strTableSchema}.${strTable}`, schema: strTableSchema, name: strTable, primary: splitNames(strPrimary),
          })),
          declared: cells(objRelations.sections[0]?.result, ['schema', 'table', 'columns', 'ref_schema', 'ref_table', 'ref_columns', 'constraint'])
            .map(([strFromSchema, strFrom, strColumns, strToSchema, strTo, strToColumns, strConstraint]) => ({
              from: `${strFromSchema}.${strFrom}`, fromColumns: splitNames(strColumns),
              to: `${strToSchema}.${strTo}`, toColumns: splitNames(strToColumns), constraint: strConstraint, inferred: false,
            })),
        });
      },
      objEx => {
        if (!boolStale) setObjState({ status: 'error', message: objEx instanceof ApiError ? objEx.detail.message : (objEx as Error).message });
      },
    );
    return () => { boolStale = true; };
  }, [objConnection.id, strSchema, strName, strType, strSignature, intReload]);

  const objGraph = useMemo(() => {
    if (objState.status !== 'done') return null;
    const { tables: arrTables, declared: arrDeclared } = objState;
    const columnsOf = (objTable: UsedTable) =>
      objMetadata?.tables.find(objMeta => objMeta.schema === objTable.schema && objMeta.name === objTable.name)?.columns;

    // Guess: A points at B when A has every primary key column of B. One line per pair, declared keys win.
    const arrLinks = arrDeclared.filter(objLink => objLink.from !== objLink.to);
    const hsPairs = new Set(arrLinks.flatMap(objLink => [`${objLink.from}>${objLink.to}`, `${objLink.to}>${objLink.from}`]));
    if (boolGuess) {
      for (const objParent of arrTables) {
        if (objParent.primary.length === 0 || objParent.primary.some(strColumn => GENERIC_KEYS.has(strColumn.toLowerCase()))) continue;
        for (const objChild of arrTables) {
          if (objChild.key === objParent.key || hsPairs.has(`${objChild.key}>${objParent.key}`)) continue;
          const hsChildColumns = new Set((columnsOf(objChild) ?? []).map(objColumn => objColumn.name));
          if (!objParent.primary.every(strColumn => hsChildColumns.has(strColumn))) continue;
          hsPairs.add(`${objChild.key}>${objParent.key}`).add(`${objParent.key}>${objChild.key}`);
          arrLinks.push({ from: objChild.key, fromColumns: objParent.primary, to: objParent.key, toColumns: objParent.primary, constraint: 'same column name', inferred: true });
        }
      }
    }

    const hsKeysOf = (strKey: string) => new Set(arrLinks.flatMap(objLink =>
      [...(objLink.from === strKey ? objLink.fromColumns : []), ...(objLink.to === strKey ? objLink.toColumns : [])]));

    // Balanced columns: each table goes to the column that is shortest so far.
    const intColumns = Math.min(Math.max(Math.ceil(Math.sqrt(arrTables.length)), 1), MAX_COLUMNS);
    const arrBottoms = Array.from({ length: intColumns }, () => PAD);
    const arrNodes: DiagramNode[] = arrTables.map(objTable => {
      const { rows: arrRows, more: intMore } = rowsFor(columnsOf(objTable), hsKeysOf(objTable.key), new Set(objTable.primary));
      const intColumn = arrBottoms.indexOf(Math.min(...arrBottoms));
      const intY = arrBottoms[intColumn];
      arrBottoms[intColumn] += nodeHeight(arrRows.length, intMore) + GAP_Y;
      return {
        key: objTable.key, schema: objTable.schema, name: objTable.name, highlight: false, rows: arrRows, more: intMore,
        x: PAD + intColumn * (BOX_W + GAP_X), y: intY,
      };
    });

    const nameOf = (strKey: string) => arrTables.find(objTable => objTable.key === strKey)?.name ?? strKey;
    const arrEdges: DiagramEdge[] = arrLinks.map((objLink, intIndex) => {
      const strLabel = `${objLink.constraint}: ${nameOf(objLink.from)} (${objLink.fromColumns.join(', ')}) → ${nameOf(objLink.to)} (${objLink.toColumns.join(', ')})`;
      return {
        key: `${intIndex}-${objLink.from}-${objLink.to}`, from: objLink.from, fromColumn: objLink.fromColumns[0],
        to: objLink.to, toColumn: objLink.toColumns[0],
        label: objLink.inferred ? `Guessed from the column name: ${strLabel}` : strLabel, inferred: objLink.inferred,
      };
    });

    return { nodes: arrNodes, edges: arrEdges, guessed: arrLinks.filter(objLink => objLink.inferred).length };
  }, [objState, objMetadata, boolGuess]);

  if (objState.status === 'loading') return <p className="p-4 text-muted">Finding the tables this {strType.toLowerCase()} uses…</p>;
  if (objState.status === 'error')
    return <p className="whitespace-pre-wrap p-4 font-mono text-xs text-danger" style={{ userSelect: 'text' }}>{objState.message}</p>;
  if (!objGraph) return null;

  const intTables = objGraph.nodes.length;

  return (
    <DiagramCanvas objConnection={objConnection} strDiagram={`routine|${strSchema}.${strName}(${strSignature ?? ''})`} strHomeSchema={strSchema}
      arrNodes={objGraph.nodes} arrEdges={objGraph.edges} onReload={() => setIntReload(intPrev => intPrev + 1)} onOpenObject={onOpenObject}
      objStatus={intTables === 0
        ? `No table was found in this ${strType.toLowerCase()}.`
        : `${intTables} ${intTables === 1 ? 'table' : 'tables'} used · ${objGraph.edges.length - objGraph.guessed} declared relations, ${objGraph.guessed} guessed (dashed)`}
      objToolbar={(
        <button className={`btn h-6 px-2 ${boolGuess ? 'text-accent' : ''}`} aria-pressed={boolGuess} onClick={() => setBoolGuess(boolPrev => !boolPrev)}
          title="Links a table to another when it has all of that table's primary key columns (same names)">
          {boolGuess ? '✓ ' : ''}Guess relations
        </button>
      )} />
  );
}
