import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { buildSvg, downloadBlob, parseDiagramFile, svgToPng, type DiagramFile } from '../diagramExport';
import type { ColumnMeta, Connection, DbObjectInfo } from '../types';

export interface DiagramRow { name: string; type: string; key: boolean; primary: boolean }

/** One table box. x / y is where the layout puts it; a saved or dragged position wins. */
export interface DiagramNode {
  key: string; schema: string; name: string;
  /** The table the diagram is about: drawn with the accent color and not opened on double-click. */
  highlight: boolean;
  rows: DiagramRow[]; more: number; x: number; y: number;
}

/** A relation drawn from the referencing table to the referenced one (arrow at `to`). */
export interface DiagramEdge { key: string; from: string; fromColumn?: string; to: string; toColumn?: string; label: string; inferred: boolean }

interface Props {
  objConnection: Connection;
  /** Name of this diagram in the saved layouts, e.g. table|schema.name. */
  strDiagram: string;
  /** Tables of another schema show their schema next to the name. */
  strHomeSchema: string;
  arrNodes: DiagramNode[];
  arrEdges: DiagramEdge[];
  objStatus: ReactNode;
  objToolbar?: ReactNode;
  onReload: () => void;
  onOpenObject: (objObject: DbObjectInfo) => void;
}

export const BOX_W = 250;
export const GAP_X = 150;
export const GAP_Y = 24;
export const PAD = 24;
const HEAD_H = 28;
const ROW_H = 20;
const MAX_ROWS = 12;
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5];

type Positions = Record<string, { x: number; y: number }>;

export const nodeHeight = (intRows: number, intMore: number) => HEAD_H + (intRows + (intMore > 0 ? 1 : 0)) * ROW_H + 6;

/** Rows of a related table: key columns always show, the rest fills up to MAX_ROWS in the table's own order. */
export function rowsFor(arrMeta: ColumnMeta[] | undefined, hsKeys: Set<string>, hsPrimary: Set<string>) {
  const arrAll: DiagramRow[] = arrMeta
    ? arrMeta.map(objColumn => ({ name: objColumn.name, type: objColumn.dataType, key: hsKeys.has(objColumn.name), primary: hsPrimary.has(objColumn.name) }))
    : [...new Set([...hsPrimary, ...hsKeys])].map(strColumn => ({ name: strColumn, type: '', key: hsKeys.has(strColumn), primary: hsPrimary.has(strColumn) }));
  const isPinned = (objRow: DiagramRow) => objRow.key || objRow.primary;
  let intSpare = Math.max(MAX_ROWS - arrAll.filter(isPinned).length, 0);
  const arrRows = arrAll.length <= MAX_ROWS ? arrAll : arrAll.filter(objRow => isPinned(objRow) || intSpare-- > 0);
  return { rows: arrRows, more: arrAll.length - arrRows.length };
}

/** Y of a column's row inside its box, or of the header when the column is not listed. */
function anchorY(objNode: DiagramNode, strColumn: string | undefined) {
  const intRow = objNode.rows.findIndex(objRow => objRow.name === strColumn);
  return intRow < 0 ? objNode.y + HEAD_H / 2 : objNode.y + HEAD_H + intRow * ROW_H + ROW_H / 2;
}

/** Table boxes joined by relation lines: drag a header to move a box, positions are saved per diagram. */
export function DiagramCanvas({ objConnection, strDiagram, strHomeSchema, arrNodes, arrEdges, objStatus, objToolbar, onReload, onOpenObject }: Props) {
  const [decZoom, setDecZoom] = useState(1);
  const [dicMoved, setDicMoved] = useState<Positions>({});
  const [boolSaveFailed, setBoolSaveFailed] = useState(false);
  // Result of the last export / import, shown in the status line.
  const [objNotice, setObjNotice] = useState<{ text: string; error: boolean } | null>(null);
  const refCanvas = useRef<HTMLDivElement>(null);
  const refImport = useRef<HTMLInputElement>(null);
  const [boolMenu, setBoolMenu] = useState(false);
  const refMoved = useRef<Positions>({});
  const refDrag = useRef<{ key: string; startX: number; startY: number; x: number; y: number; moved: boolean } | null>(null);

  const apply = (dicNext: Positions) => { refMoved.current = dicNext; setDicMoved(dicNext); };

  // Saved positions; a diagram never seen before starts from the automatic layout.
  useEffect(() => {
    let boolStale = false;
    apply({});
    api.diagramLayout(objConnection.id, strDiagram).then(
      dicSaved => { if (!boolStale) apply(dicSaved); },
      () => { /* no saved layout is not an error worth showing */ },
    );
    return () => { boolStale = true; };
  }, [objConnection.id, strDiagram]);

  const save = (dicNext: Positions) => {
    api.saveDiagramLayout(objConnection.id, strDiagram, dicNext).then(() => setBoolSaveFailed(false), () => setBoolSaveFailed(true));
  };

  const objLayout = useMemo(() => {
    const arrPlaced = arrNodes.map(objNode => (dicMoved[objNode.key] ? { ...objNode, ...dicMoved[objNode.key] } : objNode));
    const dicByKey = new Map(arrPlaced.map(objNode => [objNode.key, objNode]));

    const arrLines = arrEdges.flatMap(objEdge => {
      const objFrom = dicByKey.get(objEdge.from);
      const objTo = dicByKey.get(objEdge.to);
      if (!objFrom || !objTo) return [];
      // Each line leaves from the sides that face each other.
      const boolToLeft = objTo.x + BOX_W / 2 < objFrom.x + BOX_W / 2;
      const intX1 = boolToLeft ? objFrom.x : objFrom.x + BOX_W;
      const intX2 = boolToLeft ? objTo.x + BOX_W : objTo.x;
      const intY1 = anchorY(objFrom, objEdge.fromColumn);
      const intY2 = anchorY(objTo, objEdge.toColumn);
      const intBend = (boolToLeft ? -1 : 1) * Math.max(Math.abs(intX2 - intX1) / 2, 40);
      return [{
        key: objEdge.key, label: objEdge.label, inferred: objEdge.inferred,
        path: `M ${intX1} ${intY1} C ${intX1 + intBend} ${intY1}, ${intX2 - intBend} ${intY2}, ${intX2} ${intY2}`,
      }];
    });

    return {
      nodes: arrPlaced, lines: arrLines,
      // room to drag further out
      width: Math.max(0, ...arrPlaced.map(objNode => objNode.x + BOX_W)) + PAD * 4,
      height: Math.max(0, ...arrPlaced.map(objNode => objNode.y + nodeHeight(objNode.rows.length, objNode.more))) + PAD * 4,
    };
  }, [arrNodes, arrEdges, dicMoved]);

  const intZoom = ZOOMS.indexOf(decZoom);

  const startDrag = (objEvent: React.PointerEvent<HTMLDivElement>, objNode: DiagramNode) => {
    if (objEvent.button !== 0) return;
    objEvent.currentTarget.setPointerCapture(objEvent.pointerId);
    refDrag.current = { key: objNode.key, startX: objEvent.clientX, startY: objEvent.clientY, x: objNode.x, y: objNode.y, moved: false };
  };
  const drag = (objEvent: React.PointerEvent<HTMLDivElement>) => {
    const objDrag = refDrag.current;
    if (!objDrag) return;
    // Pointer distance is in screen pixels, box positions are in unzoomed ones.
    const intX = Math.max(Math.round(objDrag.x + (objEvent.clientX - objDrag.startX) / decZoom), 0);
    const intY = Math.max(Math.round(objDrag.y + (objEvent.clientY - objDrag.startY) / decZoom), 0);
    if (intX === objDrag.x && intY === objDrag.y && !objDrag.moved) return; // a click, not a drag
    objDrag.moved = true;
    apply({ ...refMoved.current, [objDrag.key]: { x: intX, y: intY } });
  };
  const endDrag = () => {
    if (refDrag.current?.moved) save(refMoved.current);
    refDrag.current = null;
  };

  const reset = () => { apply({}); save({}); };

  // schema.name(args) -> a name Windows accepts
  const strFileBase = `diagram-${strDiagram.replace(/^\w+\|/, '').replace(/[^\w.-]+/g, '_').replace(/_+$/, '')}`;

  const exportAs = async (strKind: 'png' | 'svg' | 'json') => {
    try {
      if (strKind === 'json') {
        const objFile: DiagramFile = {
          format: 'dbstudio-diagram', version: 1, diagram: strDiagram, exportedAt: new Date().toISOString(),
          nodes: objLayout.nodes, edges: arrEdges.map(({ key: _strKey, ...objEdge }) => objEdge),
        };
        downloadBlob(new Blob([JSON.stringify(objFile, null, 2)], { type: 'application/json' }), `${strFileBase}.json`);
      } else {
        const objSvg = buildSvg({
          arrNodes: objLayout.nodes, arrLines: objLayout.lines, intBoxWidth: BOX_W, intHeadHeight: HEAD_H, intRowHeight: ROW_H,
          strHomeSchema, objThemeSource: refCanvas.current ?? document.documentElement,
        });
        downloadBlob(strKind === 'svg'
          ? new Blob([objSvg.svg], { type: 'image/svg+xml;charset=utf-8' })
          : await svgToPng(objSvg.svg, objSvg.width, objSvg.height), `${strFileBase}.${strKind}`);
      }
      setObjNotice({ text: `${strFileBase}.${strKind} is ready: choose where to save it`, error: false });
    } catch (objEx) {
      setObjNotice({ text: (objEx as Error).message, error: true });
    }
  };

  // A diagram file brings its box positions; tables this diagram doesn't have are skipped.
  const importFile = async (objFile: File | undefined) => {
    if (!objFile) return;
    const objParsed = parseDiagramFile(await objFile.text());
    if ('error' in objParsed) { setObjNotice({ text: objParsed.error, error: true }); return; }
    const hsKeys = new Set(arrNodes.map(objNode => objNode.key));
    const dicNext: Positions = { ...refMoved.current };
    let intApplied = 0;
    for (const objNode of objParsed.file.nodes) {
      if (!hsKeys.has(objNode.key)) continue;
      dicNext[objNode.key] = { x: Math.max(Math.round(objNode.x), 0), y: Math.max(Math.round(objNode.y), 0) };
      intApplied++;
    }
    if (intApplied === 0) { setObjNotice({ text: 'The file has no table of this diagram: nothing was changed.', error: true }); return; }
    apply(dicNext);
    save(dicNext);
    setObjNotice({
      text: `Imported the position of ${intApplied} of ${objParsed.file.nodes.length} tables`
        + (objParsed.file.diagram === strDiagram ? '' : ' (the file was made from another diagram)'),
      error: false,
    });
  };

  const runMenu = (strAction: 'png' | 'svg' | 'json' | 'import') => {
    setBoolMenu(false);
    if (strAction === 'import') refImport.current?.click();
    else exportAs(strAction);
  };
  const MENU_ITEMS: ['png' | 'svg' | 'json' | 'import', string][] = [
    ['png', 'Export picture (PNG)'], ['svg', 'Export picture (SVG)'], ['json', 'Export diagram file'], ['import', 'Import diagram file…'],
  ];

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line px-3 text-muted">
        <span className="min-w-0 truncate">
          {objStatus}
          {boolSaveFailed && <span className="text-danger"> · layout not saved</span>}
          {objNotice && <span className={objNotice.error ? 'text-danger' : 'text-success'}> · {objNotice.text}</span>}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {objToolbar}
          <span className="toolbar-sep" />
          <div className="flex h-6 items-center rounded border border-line" role="group" aria-label="Zoom">
            <button className="h-full w-6 rounded-l hover:bg-hover disabled:opacity-40" onClick={() => setDecZoom(ZOOMS[intZoom - 1])}
              disabled={intZoom <= 0} aria-label="Zoom out">−</button>
            <span className="w-11 border-x border-line text-center leading-[22px]">{Math.round(decZoom * 100)}%</span>
            <button className="h-full w-6 rounded-r hover:bg-hover disabled:opacity-40" onClick={() => setDecZoom(ZOOMS[intZoom + 1])}
              disabled={intZoom >= ZOOMS.length - 1} aria-label="Zoom in">+</button>
          </div>
          <span className="toolbar-sep" />
          <button className="btn h-6 px-2" onClick={reset} disabled={Object.keys(dicMoved).length === 0}
            title="Put every table back where the automatic layout placed it">Reset layout</button>
          <div className="relative" onBlur={objEvent => { if (!objEvent.currentTarget.contains(objEvent.relatedTarget)) setBoolMenu(false); }}>
            <button className="btn h-6 px-2" aria-haspopup="menu" aria-expanded={boolMenu}
              title="Save the diagram as a picture or a file, or load a diagram file" onClick={() => setBoolMenu(boolPrev => !boolPrev)}>
              Export / Import ▾
            </button>
            {boolMenu && (
              <div role="menu" className="absolute right-0 top-7 z-20 min-w-48 rounded border border-line bg-panel py-1 shadow-lg">
                {MENU_ITEMS.map(([strAction, strLabel]) => (
                  <button key={strAction} role="menuitem" className="block w-full whitespace-nowrap px-3 py-1 text-left text-fg hover:bg-hover"
                    onClick={() => runMenu(strAction)}>{strLabel}</button>
                ))}
              </div>
            )}
          </div>
          <input ref={refImport} type="file" accept=".json,application/json" className="hidden"
            onChange={objEvent => { importFile(objEvent.target.files?.[0]); objEvent.target.value = ''; }} />
          <button className="btn h-6 px-2" onClick={onReload}>Reload</button>
        </div>
      </div>

      <div ref={refCanvas} className="min-h-0 flex-1 overflow-auto bg-bg">
        <div className="relative" style={{ width: objLayout.width, height: objLayout.height, zoom: decZoom }}>
          <svg className="pointer-events-none absolute inset-0 text-muted" width={objLayout.width} height={objLayout.height} aria-hidden="true">
            <defs>
              <marker id="diagram-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
              </marker>
            </defs>
            {objLayout.lines.map(objLine => (
              <path key={objLine.key} d={objLine.path} fill="none" stroke="currentColor" strokeWidth={1.4} markerEnd="url(#diagram-arrow)"
                strokeDasharray={objLine.inferred ? '5 4' : undefined} style={{ pointerEvents: 'stroke' }}>
                <title>{objLine.label}</title>
              </path>
            ))}
          </svg>

          {objLayout.nodes.map(objNode => (
            <div key={objNode.key} className={`absolute overflow-hidden rounded border bg-panel shadow-sm ${objNode.highlight ? 'border-accent' : 'border-line'}`}
              style={{ left: objNode.x, top: objNode.y, width: BOX_W, height: nodeHeight(objNode.rows.length, objNode.more) }}>
              <div className={`flex cursor-move select-none items-center gap-1 truncate border-b px-2 font-semibold ${
                objNode.highlight ? 'border-accent bg-accent/15' : 'border-line bg-bg hover:bg-hover'}`}
                style={{ height: HEAD_H }}
                title={`${objNode.schema}.${objNode.name} · drag to move${objNode.highlight ? '' : ', double-click to open'}`}
                onPointerDown={objEvent => startDrag(objEvent, objNode)} onPointerMove={drag} onPointerUp={endDrag} onPointerCancel={endDrag}
                onDoubleClick={() => { if (!objNode.highlight) onOpenObject({ schema: objNode.schema, name: objNode.name, type: 'TABLE' }); }}>
                <span className="truncate">{objNode.name}</span>
                {objNode.schema !== strHomeSchema && <span className="shrink-0 font-normal text-muted">{objNode.schema}</span>}
              </div>
              {objNode.rows.map(objRow => (
                <div key={objRow.name} className="flex items-center gap-1.5 px-2 font-mono" style={{ height: ROW_H }} title={`${objRow.name} ${objRow.type}`}>
                  <span className={`w-5 shrink-0 text-[9px] font-semibold ${objRow.primary ? 'text-accent' : 'text-muted'}`}>
                    {objRow.primary ? 'PK' : objRow.key ? 'FK' : ''}
                  </span>
                  <span className={`truncate ${objRow.key || objRow.primary ? '' : 'text-muted'}`}>{objRow.name}</span>
                  <span className="ml-auto shrink-0 truncate pl-2 text-[10px] text-muted" style={{ maxWidth: 110 }}>{objRow.type.toLowerCase()}</span>
                </div>
              ))}
              {objNode.more > 0 && <div className="px-2 text-muted" style={{ height: ROW_H, lineHeight: `${ROW_H}px` }}>… {objNode.more} more columns</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
