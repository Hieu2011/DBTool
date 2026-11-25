import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { api, ApiError } from '../api';
import { showToast } from '../toast';
import { TREE_STICKY_TOP, useOuterScroll } from './useOuterScroll';
import { qualifiedName, quoteIdent } from '../sql/identifiers';
import {
  countScript, deleteScript, dropScript, executeScript, insertScript, nextValueScript, selectScript, updateScript,
} from '../sql/scripts';
import { ContextMenu, type MenuItem } from './ContextMenu';
import type { ColumnMeta, Connection, DbKind, DbObjectInfo, ObjectDetail, SchemaMetadata } from '../types';
import {
  IconChevronDown, IconChevronRight, IconColumn, IconDatabase, IconFolder, IconFunction, IconIndex, IconInfo, IconKey,
  IconLink, IconPackage, IconPlay, IconPlus, IconRefresh, IconRows, IconSequence, IconTable, IconTrigger, IconView,
} from './icons';

interface Props {
  objConnection: Connection;
  objMetadata: SchemaMetadata | undefined;
  /** strSchema: also load that schema (Oracle loads one schema at a time). */
  loadMetadata: (strId: string, boolRefresh?: boolean, strSchema?: string) => Promise<SchemaMetadata>;
  onOpenObject: (objObject: DbObjectInfo) => void;
  onOpenData: (objObject: DbObjectInfo) => void;
  /** Opens an editor tab holding the SQL (right-click menu). */
  onOpenSql: (strSql: string, boolAutoRun?: boolean) => void;
  /** Opens the form that runs a procedure or function with parameters. */
  onExecuteRoutine: (objRoutine: DbObjectInfo) => void;
  /** The object of the active tab: the tree opens down to it, shows it and marks it. */
  objReveal?: DbObjectInfo | null;
  /** The sidebar's one filter box, shared by every tree. */
  strFilter: string;
  onFilter: (strFilter: string) => void;
  /** Goes up when the connection's Refresh button is pressed. */
  intRefresh: number;
}

/** 1234 → 1,234; 15300 → 15.3K; 2400000 → 2.4M. */
const compactCount = (intRows: number) =>
  intRows < 10000 ? intRows.toLocaleString()
    : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(intRows);

interface TreeItem { object: DbObjectInfo; columns?: ColumnMeta[]; rows?: number | null }
interface TreeSchema { schema: string; loaded: boolean; groups: [string, TreeItem[]][] }

type DetailState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; detail: ObjectDetail };

type TreeRow =
  // filtered: opened by the filter, not by the user (collapsing it is remembered apart).
  | { kind: 'schema' | 'group' | 'folder'; key: string; depth: number; label: string; count: number | null; expanded: boolean; filtered?: boolean }
  | { kind: 'object'; key: string; depth: number; item: TreeItem; expandable: boolean; expanded: boolean }
  | { kind: 'leaf'; key: string; depth: number; folder: string; label: string; detail: string; open?: DbObjectInfo }
  | { kind: 'message'; key: string; depth: number; text: string; danger: boolean };

const ROW_H = 22;
const COLUMNS = 'Columns';

/** Folders under a schema, always shown, in this order. Other types found get a folder named after the type. */
const SCHEMA_GROUPS: Partial<Record<DbKind, [string, string][]>> = {
  Oracle: [
    ['TABLE', 'Tables'], ['VIEW', 'Views'], ['PACKAGE', 'Packages'], ['PROCEDURE', 'Procedures'], ['FUNCTION', 'Functions'],
    ['TRIGGER', 'Triggers'], ['TYPE', 'User Types'], ['SEQUENCE', 'Sequences'],
    ['MATERIALIZED VIEW', 'Materialized Views'], ['SYNONYM', 'Synonyms'],
  ],
  PostgreSql: [
    ['TABLE', 'Tables'], ['VIEW', 'Views'], ['MATERIALIZED VIEW', 'Materialized Views'],
    ['FUNCTION', 'Functions'], ['PROCEDURE', 'Procedures'], ['SEQUENCE', 'Sequences'],
  ],
  // Schemas are the databases; "columns" are the fields sampled from each collection.
  MongoDb: [['COLLECTION', 'Collections'], ['VIEW', 'Views']],
};

/**
 * What an object opens into. Columns come from the metadata; every other name is the title of a
 * detail grid the server returns for that object type (SectionQueries in the providers).
 * A single entry is listed directly under the object, several become folders.
 */
const OBJECT_FOLDERS: Partial<Record<DbKind, Record<string, string[]>>> = {
  Oracle: {
    TABLE: [COLUMNS, 'Constraints', 'Indexes', 'Triggers', 'Procedures', 'Functions', 'Packages'],
    'MATERIALIZED VIEW': [COLUMNS, 'Indexes', 'Procedures', 'Functions', 'Packages'],
    VIEW: [COLUMNS, 'Procedures', 'Functions', 'Packages'],
    PACKAGE: ['Members'],
    PROCEDURE: ['Parameters'],
    FUNCTION: ['Parameters'],
  },
  PostgreSql: {
    TABLE: [COLUMNS, 'Constraints', 'Indexes', 'Triggers', 'Functions', 'Procedures'],
    'MATERIALIZED VIEW': [COLUMNS, 'Indexes', 'Functions', 'Procedures'],
    VIEW: [COLUMNS, 'Functions', 'Procedures'],
    'FOREIGN TABLE': [COLUMNS],
  },
  MongoDb: {
    COLLECTION: [COLUMNS, 'Indexes'],
    VIEW: [COLUMNS],
  },
};

/**
 * Folders listing the code that uses a table. Slower to compute, so each is fetched on its own when
 * opened (OnDemandSectionQueries in the providers). Value: the type of the objects listed.
 */
const USED_BY_FOLDERS: Record<string, string> = { Procedures: 'PROCEDURE', Functions: 'FUNCTION', Packages: 'PACKAGE' };

export const TABLE_LIKE = new Set(['TABLE', 'FOREIGN TABLE', 'VIEW', 'MATERIALIZED VIEW', 'COLLECTION']);

type IconType = typeof IconTable;

const TYPE_ICON: Record<string, IconType> = {
  TABLE: IconTable, 'FOREIGN TABLE': IconTable, COLLECTION: IconTable, VIEW: IconView, 'MATERIALIZED VIEW': IconView,
  FUNCTION: IconFunction, PROCEDURE: IconFunction, PACKAGE: IconPackage, TYPE: IconPackage,
  SEQUENCE: IconSequence, TRIGGER: IconTrigger, SYNONYM: IconLink,
};

const LEAF_ICON: Record<string, IconType> = {
  Columns: IconColumn, Constraints: IconKey, Indexes: IconIndex, Triggers: IconTrigger,
  Members: IconFunction, Parameters: IconColumn,
  Procedures: IconFunction, Functions: IconFunction, Packages: IconPackage,
};

const schemaKey = (strSchema: string) => `s:${strSchema}`;
const objectKey = (objObject: DbObjectInfo) =>
  `o:${objObject.schema}:${objObject.type}:${objObject.name}:${objObject.signature ?? ''}`;
interface DetailRequest { object: DbObjectInfo; section?: string }

/** Cache key of an object's quick grids, or of one of its on-demand folders. */
const detailKey = (objObject: DbObjectInfo, strSection?: string) =>
  strSection ? `${objectKey(objObject)}#${strSection}` : objectKey(objObject);
// PostgreSQL's long type names and the short ones DBeaver shows.
const SHORT_TYPES: Record<string, string> = {
  'character varying': 'varchar', character: 'bpchar', integer: 'int4', bigint: 'int8', smallint: 'int2', boolean: 'bool',
  'double precision': 'float8', real: 'float4', 'timestamp without time zone': 'timestamp', 'timestamp with time zone': 'timestamptz',
  'time without time zone': 'time', 'time with time zone': 'timetz', 'bit varying': 'varbit',
};

/** "INOUT v_out refcursor, v_id character varying" -> "refcursor, varchar": parameter types only, as DBeaver lists them. */
const compactSignature = (strSignature: string) => strSignature.split(',')
  .map(strArgument => {
    const strRest = strArgument.trim().replace(/^(INOUT|IN|OUT|VARIADIC)\s+/i, '');
    const shorten = (strType: string) => {
      const strBase = strType.replace(/(\[\])+$/, '');
      return (SHORT_TYPES[strBase.toLowerCase()] ?? strBase) + strType.slice(strBase.length);
    };
    // The name is optional: a text that is a whole type on its own has none.
    const intSpace = strRest.search(/\s/);
    const boolUnnamed = intSpace < 0 || strRest.replace(/(\[\])+$/, '').toLowerCase() in SHORT_TYPES;
    return shorten(boolUnnamed ? strRest : strRest.slice(intSpace).trim());
  })
  .filter(strArgument => strArgument !== '').join(', ');

const sectionOf =(strFolder: string) => (strFolder in USED_BY_FOLDERS ? strFolder : undefined);

const errorMessage = (objEx: unknown) => (objEx instanceof ApiError ? objEx.detail.message : (objEx as Error).message);

/** Second column of a detail grid, shown dimmed after the name when it is short enough to help. */
const leafDetail = (objValue: unknown) => {
  if (objValue === true) return 'unique';
  return typeof objValue === 'string' && objValue.length <= 28 ? objValue.toLowerCase() : '';
};

/** Every schema with its objects by type, in display order. The login's own schema comes first. */
function groupObjects(objMetadata: SchemaMetadata, arrFixedGroups: [string, string][]): TreeSchema[] {
  const dicSchemas = new Map<string, Map<string, TreeItem[]>>();
  const groupsOf = (strSchema: string) => {
    let dicGroups = dicSchemas.get(strSchema);
    if (!dicGroups) dicSchemas.set(strSchema, dicGroups = new Map(arrFixedGroups.map(([strType]) => [strType, []])));
    return dicGroups;
  };
  const add = (objItem: TreeItem) => {
    const dicGroups = groupsOf(objItem.object.schema);
    const arrItems = dicGroups.get(objItem.object.type);
    if (arrItems) arrItems.push(objItem);
    else dicGroups.set(objItem.object.type, [objItem]);
  };
  for (const strSchema of objMetadata.schemas ?? []) groupsOf(strSchema);
  for (const objTable of objMetadata.tables)
    add({ object: { schema: objTable.schema, name: objTable.name, type: objTable.type }, columns: objTable.columns, rows: objTable.rows });
  for (const objObject of objMetadata.objects ?? []) add({ object: objObject });

  // Without a schema list everything was loaded in one go.
  const hsLoaded = objMetadata.schemas ? new Set(objMetadata.loadedSchemas ?? []) : null;
  const strOwn = objMetadata.schemas ? objMetadata.loadedSchemas?.[0] : undefined;

  return [...dicSchemas.entries()]
    .sort(([strLeft], [strRight]) =>
      Number(strRight === strOwn) - Number(strLeft === strOwn) || strLeft.localeCompare(strRight))
    .map(([strSchema, dicGroups]) => ({
      schema: strSchema,
      loaded: !hsLoaded || hsLoaded.has(strSchema),
      groups: [...dicGroups.entries()], // a Map keeps insertion order: fixed folders first, extras after
    }));
}

export function ObjectTree({
  objConnection, objMetadata, loadMetadata, onOpenObject, onOpenData, onOpenSql, onExecuteRoutine, objReveal, strFilter, onFilter, intRefresh,
}: Props) {
  // Row of the active tab's object; strScrollTo: still to be scrolled into view (its rows may not exist yet).
  const [strCurrentKey, setStrCurrentKey] = useState<string | null>(null);
  const [strScrollTo, setStrScrollTo] = useState<string | null>(null);
  const refRevealed = useRef<string | null>(null);
  // The sidebar scrolls all trees as one list: rows are virtualized against its scroller.
  const refList = useRef<HTMLDivElement>(null);
  const objOuter = useOuterScroll(refList);
  const intMargin = objOuter?.margin ?? 0;
  const [objMenu, setObjMenu] = useState<{ x: number; y: number; row: TreeRow } | null>(null);
  const [boolScripting, setBoolScripting] = useState(false);
  const refAutoExpanded = useRef(false);
  const [hsExpanded, setHsExpanded] = useState<Set<string>>(new Set());
  const setStrFilter = (fnNext: (strPrev: string) => string) => { const strNext = fnNext(strFilter); if (strNext !== strFilter) onFilter(strNext); };
  // The filter opens every schema / group that holds a match; these are the ones the user closed again.
  const [hsFilterClosed, setHsFilterClosed] = useState<Set<string>>(new Set());
  useEffect(() => { setHsFilterClosed(new Set()); }, [strFilter]);
  const [strState, setStrState] = useState<'idle' | 'loading' | string>('idle');
  // Schemas being loaded ('loading') or that failed to load (the error text).
  const [dicSchemaState, setDicSchemaState] = useState<Record<string, string>>({});
  // Constraints, indexes, triggers... of the objects opened so far, by object key.
  const [dicDetails, setDicDetails] = useState<Record<string, DetailState>>({});

  const arrFixedGroups = SCHEMA_GROUPS[objConnection.kind] ?? [];
  const dicGroupLabel = useMemo(() => new Map(arrFixedGroups), [arrFixedGroups]);
  const dicObjectFolders = OBJECT_FOLDERS[objConnection.kind] ?? {};

  const refConnected = useRef(false);
  const load = (boolRefresh: boolean) => {
    setStrState('loading');
    setDicSchemaState({});
    setDicDetails({});
    loadMetadata(objConnection.id, boolRefresh).then(
      () => {
        setStrState('idle');
        if (!refConnected.current) showToast('success', `Connected to ${objConnection.name}`);
        refConnected.current = true;
      },
      objEx => {
        setStrState(errorMessage(objEx));
        showToast('error', `${objConnection.name}: ${boolRefresh ? 'refresh' : 'connection'} failed`, errorMessage(objEx));
      },
    );
  };

  const loadSchema = (strSchema: string) => {
    setDicSchemaState(dicPrev => ({ ...dicPrev, [strSchema]: 'loading' }));
    loadMetadata(objConnection.id, false, strSchema).then(
      () => setDicSchemaState(({ [strSchema]: _, ...dicRest }) => dicRest),
      objEx => setDicSchemaState(dicPrev => ({ ...dicPrev, [strSchema]: errorMessage(objEx) })),
    );
  };

  /** strSection: one on-demand folder, cached apart from the object's quick grids. */
  const loadDetail = ({ object: objObject, section: strSection }: DetailRequest) => {
    const strKey = detailKey(objObject, strSection);
    setDicDetails(dicPrev => ({ ...dicPrev, [strKey]: { status: 'loading' } }));
    api.objectDetail(objConnection.id, objObject, false, strSection).then(
      objDetail => setDicDetails(dicPrev => ({ ...dicPrev, [strKey]: { status: 'done', detail: objDetail } })),
      objEx => setDicDetails(dicPrev => ({ ...dicPrev, [strKey]: { status: 'error', message: errorMessage(objEx) } })),
    );
  };

  useEffect(() => {
    if (!objMetadata && strState === 'idle') load(false);
  }, [objMetadata, strState, objConnection.id]);

  // Objects that arrive (this tree's load or an editor's) make an older error stale.
  useEffect(() => {
    if (objMetadata) setStrState(strPrev => (strPrev === 'loading' ? strPrev : 'idle'));
  }, [objMetadata]);

  const arrSchemas = useMemo(
    () => (objMetadata ? groupObjects(objMetadata, arrFixedGroups) : []),
    [objMetadata, arrFixedGroups]);

  // Starts with the login's own schema open (or the only schema there is).
  useEffect(() => {
    if (refAutoExpanded.current || arrSchemas.length === 0) return;
    refAutoExpanded.current = true;
    const strFirst = objMetadata?.schemas ? objMetadata.loadedSchemas?.[0] : arrSchemas.length === 1 ? arrSchemas[0].schema : undefined;
    if (strFirst) setHsExpanded(hsPrev => new Set(hsPrev).add(schemaKey(strFirst)));
  }, [arrSchemas, objMetadata]);

  // An open schema that isn't loaded yet (just opened, or dropped by Refresh) gets loaded.
  useEffect(() => {
    for (const objSchema of arrSchemas)
      if (!objSchema.loaded && hsExpanded.has(schemaKey(objSchema.schema)) && !(objSchema.schema in dicSchemaState))
        loadSchema(objSchema.schema);
  }, [arrSchemas, hsExpanded, dicSchemaState]);

  // Follows the active tab: opens the schema (loading it when needed), its folder and the object itself.
  const strRevealId = objReveal ? `${objReveal.schema}:${objReveal.type}:${objReveal.name}:${objReveal.signature ?? ''}` : null;
  useEffect(() => {
    if (!objReveal || !strRevealId) { refRevealed.current = null; return setStrCurrentKey(null); }
    if (refRevealed.current === strRevealId) return;
    const objSchema = arrSchemas.find(objItem => objItem.schema === objReveal.schema);
    if (!objSchema) return;
    if (!objSchema.loaded) return setHsExpanded(hsPrev => (hsPrev.has(schemaKey(objReveal.schema)) ? hsPrev : new Set(hsPrev).add(schemaKey(objReveal.schema))));
    const objItem = objSchema.groups.find(([strType]) => strType === objReveal.type)?.[1].find(objCandidate =>
      objCandidate.object.name === objReveal.name && (objReveal.signature == null || objCandidate.object.signature == null || objCandidate.object.signature === objReveal.signature));
    refRevealed.current = strRevealId; // found or not: one try per tab switch
    if (!objItem) return setStrCurrentKey(null);
    const strKey = objectKey(objItem.object);
    setHsExpanded(hsPrev => new Set(hsPrev).add(schemaKey(objReveal.schema)).add(`g:${objReveal.schema}:${objReveal.type}`).add(strKey));
    // A filter that hides it would hide the answer.
    setStrFilter(strPrev => (strPrev.trim() && !objReveal.name.toLowerCase().includes(strPrev.trim().toLowerCase()) ? '' : strPrev));
    setStrCurrentKey(strKey);
    setStrScrollTo(strKey);
  }, [strRevealId, arrSchemas]);

  const { arrRows, arrNeedDetail } = useMemo(() => {
    const strNeedle = strFilter.trim().toLowerCase();
    const arrResult: TreeRow[] = [];
    const arrNeeded: DetailRequest[] = [];

    /** The entries of one folder of an object: its columns, or the rows of a detail grid. */
    const pushLeaves = (objItem: TreeItem, strKey: string, strFolder: string, intDepth: number) => {
      const strPrefix = `${strKey}/${strFolder}`;
      const message = (strText: string, boolDanger = false) =>
        arrResult.push({ kind: 'message', key: `${strPrefix}/m`, depth: intDepth, text: strText, danger: boolDanger });

      if (strFolder === COLUMNS) {
        const arrColumns = objItem.columns ?? [];
        if (arrColumns.length === 0) message('No columns');
        for (const objColumn of arrColumns)
          arrResult.push({
            kind: 'leaf', key: `${strPrefix}/${objColumn.name}`, depth: intDepth, folder: strFolder,
            label: objColumn.name, detail: objColumn.dataType.toLowerCase(),
          });
        return;
      }

      const objState = dicDetails[detailKey(objItem.object, sectionOf(strFolder))];
      if (!objState) arrNeeded.push({ object: objItem.object, section: sectionOf(strFolder) });
      if (!objState || objState.status === 'loading') return void message('Loading…');
      if (objState.status === 'error') return void message(objState.message, true);

      const boolOracle = objConnection.kind === 'Oracle';
      const strUsedByType = USED_BY_FOLDERS[strFolder];
      const arrGridRows = objState.detail.sections.find(objSection => objSection.title === strFolder)?.result.rows ?? [];
      if (arrGridRows.length === 0)
        message(strUsedByType ? `No ${strFolder.toLowerCase()} use this ${objItem.object.type.toLowerCase()}` : `No ${strFolder.toLowerCase()}`);

      arrGridRows.forEach((arrGridRow, intIndex) => {
        const strName = String(arrGridRow[0] ?? '');
        let strDetail = leafDetail(arrGridRow[1]);
        let objOpen: DbObjectInfo | undefined;
        if (strUsedByType) {
          // Grid columns: Oracle (name, owner), PostgreSQL (name, arguments, schema).
          const strOwner = String(arrGridRow[boolOracle ? 1 : 2] ?? objItem.object.schema);
          objOpen = {
            schema: strOwner, name: strName, type: strUsedByType,
            signature: boolOracle ? undefined : String(arrGridRow[1] ?? ''),
          };
          strDetail = strOwner === objItem.object.schema ? '' : strOwner.toLowerCase(); // only worth showing when it differs
        } else if (strFolder === 'Triggers' && boolOracle) {
          objOpen = { schema: objItem.object.schema, name: strName, type: 'TRIGGER' }; // an object of its own on Oracle
        }
        arrResult.push({
          kind: 'leaf', key: `${strPrefix}/${intIndex}`, depth: intDepth, folder: strFolder,
          label: strName, detail: strDetail, open: objOpen,
        });
      });
    };

    const pushObject = (objItem: TreeItem) => {
      const strKey = objectKey(objItem.object);
      const arrFolders = dicObjectFolders[objItem.object.type] ?? [];
      const boolOpen = arrFolders.length > 0 && hsExpanded.has(strKey);
      arrResult.push({ kind: 'object', key: strKey, depth: 2, item: objItem, expandable: arrFolders.length > 0, expanded: boolOpen });
      if (!boolOpen) return;
      if (arrFolders.length === 1) return pushLeaves(objItem, strKey, arrFolders[0], 3);

      for (const strFolder of arrFolders) {
        const strFolderKey = `${strKey}/f:${strFolder}`;
        const boolFolderOpen = hsExpanded.has(strFolderKey);
        const objState = dicDetails[detailKey(objItem.object, sectionOf(strFolder))];
        const intCount = strFolder === COLUMNS
          ? objItem.columns?.length ?? 0
          : objState?.status === 'done'
            ? objState.detail.sections.find(objSection => objSection.title === strFolder)?.result.rows.length ?? 0
            : null;
        arrResult.push({ kind: 'folder', key: strFolderKey, depth: 3, label: strFolder, count: intCount, expanded: boolFolderOpen });
        if (boolFolderOpen) pushLeaves(objItem, strKey, strFolder, 4);
      }
    };

    for (const { schema: strSchema, loaded: boolLoaded, groups: arrGroups } of arrSchemas) {
      const strSchemaKey = schemaKey(strSchema);
      const arrMatching = strNeedle
        ? arrGroups
          .map(([strType, arrItems]) =>
            [strType, arrItems.filter(objItem => objItem.object.name.toLowerCase().includes(strNeedle))] as [string, TreeItem[]])
          .filter(([, arrItems]) => arrItems.length > 0)
        : arrGroups;

      // Filtering: matching objects are shown without clicking through. A schema whose own name
      // matches stays listed (that is how an unloaded schema is found) and shows all its objects.
      const boolByObjects = !!strNeedle && arrMatching.length > 0;
      if (strNeedle && !boolByObjects && !strSchema.toLowerCase().includes(strNeedle)) continue;
      const arrVisible = boolByObjects ? arrMatching : arrGroups;
      const boolSchemaOpen = boolByObjects ? !hsFilterClosed.has(strSchemaKey) : hsExpanded.has(strSchemaKey);

      arrResult.push({
        kind: 'schema', key: strSchemaKey, depth: 0, label: strSchema, expanded: boolSchemaOpen, filtered: boolByObjects,
        count: boolLoaded ? arrVisible.reduce((intSum, [, arrItems]) => intSum + arrItems.length, 0) : null,
      });
      if (!boolSchemaOpen) continue;

      if (!boolLoaded) {
        const strSchemaState = dicSchemaState[strSchema];
        const boolFailed = !!strSchemaState && strSchemaState !== 'loading';
        arrResult.push({
          kind: 'message', key: `m:${strSchema}`, depth: 1, danger: boolFailed,
          text: boolFailed ? `${strSchemaState} (collapse and open again to retry)` : 'Loading…',
        });
        continue;
      }

      for (const [strType, arrItems] of arrVisible) {
        const strGroupKey = `g:${strSchema}:${strType}`;
        const boolGroupOpen = arrItems.length > 0 && (boolByObjects ? !hsFilterClosed.has(strGroupKey) : hsExpanded.has(strGroupKey));
        arrResult.push({
          kind: 'group', key: strGroupKey, depth: 1, label: dicGroupLabel.get(strType) ?? strType,
          count: arrItems.length, expanded: boolGroupOpen, filtered: boolByObjects,
        });
        if (boolGroupOpen) arrItems.forEach(pushObject);
      }
    }
    return { arrRows: arrResult, arrNeedDetail: arrNeeded };
  }, [arrSchemas, hsExpanded, hsFilterClosed, strFilter, dicSchemaState, dicDetails, dicGroupLabel, dicObjectFolders, objConnection.kind]);

  // A folder was opened whose content isn't here yet.
  useEffect(() => {
    arrNeedDetail.forEach(loadDetail);
  }, [arrNeedDetail]);

  const closeMenu = useCallback(() => setObjMenu(null), []);

  const objVirtual = useVirtualizer({
    count: arrRows.length,
    getScrollElement: () => objOuter?.element ?? null,
    estimateSize: () => ROW_H,
    overscan: 15,
    scrollMargin: intMargin,
    scrollPaddingStart: TREE_STICKY_TOP,
  });

  const refRefresh = useRef(intRefresh);
  useEffect(() => {
    if (refRefresh.current === intRefresh) return;
    refRefresh.current = intRefresh;
    load(true);
  }, [intRefresh]);

  useEffect(() => {
    if (!strScrollTo) return;
    const intIndex = arrRows.findIndex(objRow => objRow.key === strScrollTo);
    if (intIndex < 0) return;
    objVirtual.scrollToIndex(intIndex, { align: 'center' });
    setStrScrollTo(null);
  }, [strScrollTo, arrRows]);

  const toggle = (objRow: TreeRow) => {
    // Collapsing a schema that failed to load clears the error, so opening it again retries.
    if (objRow.kind === 'schema' && objRow.expanded)
      setDicSchemaState(({ [objRow.label]: strDropped, ...dicRest }) =>
        (strDropped === 'loading' ? { ...dicRest, [objRow.label]: strDropped } : dicRest));
    const flip = (hsPrev: Set<string>) => {
      const hsNext = new Set(hsPrev);
      if (!hsNext.delete(objRow.key)) hsNext.add(objRow.key);
      return hsNext;
    };
    if ((objRow.kind === 'schema' || objRow.kind === 'group') && objRow.filtered) setHsFilterClosed(flip);
    else setHsExpanded(flip);
  };

  const chevron = (boolExpanded: boolean) => (
    <span className="text-muted">{boolExpanded ? <IconChevronDown intSize={12} /> : <IconChevronRight intSize={12} />}</span>
  );
  const noChevron = <span className="w-3 shrink-0" />;

  const renderRow = (objRow: TreeRow) => {
    if (objRow.kind === 'message') {
      return <span className={`truncate pl-4 ${objRow.danger ? 'text-danger' : 'text-muted'}`} title={objRow.text}>{objRow.text}</span>;
    }
    if (objRow.kind === 'leaf') {
      const LeafIcon = LEAF_ICON[objRow.folder] ?? IconColumn;
      return (
        <>
          {noChevron}
          <span className="text-muted"><LeafIcon intSize={13} /></span>
          <span className="truncate" title={objRow.open?.signature != null ? `${objRow.label}(${objRow.open.signature})` : undefined}>
            {objRow.label}
            {objRow.open?.signature != null && <span className="text-muted">({compactSignature(objRow.open.signature)})</span>}
          </span>
          <span className="ml-auto shrink-0 truncate pl-2 font-mono text-[10.5px] text-muted">{objRow.detail}</span>
        </>
      );
    }
    if (objRow.kind !== 'object') {
      const boolSchema = objRow.kind === 'schema';
      const boolEmpty = objRow.count === 0 && !boolSchema;
      return (
        <>
          {boolEmpty ? noChevron : chevron(objRow.expanded)}
          <span className={boolSchema ? 'text-accent' : 'text-env-amber'}>
            {boolSchema ? <IconDatabase intSize={14} /> : <IconFolder intSize={14} />}
          </span>
          <span className={`truncate ${boolSchema ? 'font-medium' : ''} ${boolEmpty ? 'text-muted' : ''}`}>{objRow.label}</span>
          <span className="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-muted">{objRow.count?.toLocaleString()}</span>
        </>
      );
    }
    const { object: objObject } = objRow.item;
    const TypeIcon = TYPE_ICON[objObject.type] ?? IconPackage;
    return (
      <>
        {objRow.expandable ? chevron(objRow.expanded) : noChevron}
        <span className="text-muted"><TypeIcon intSize={14} /></span>
        <span className="truncate" title={objObject.signature != null ? `${objObject.name}(${objObject.signature})` : undefined}>
          {objObject.name}
          {objObject.signature != null && <span className="text-muted">({compactSignature(objObject.signature)})</span>}
        </span>
        <span className="ml-auto hidden shrink-0 gap-0.5 pl-1 group-hover:flex">
          {TABLE_LIKE.has(objObject.type) && (
            <button className="icon-btn icon-btn-sm h-5 min-w-5" aria-label="Open data" title="Open the rows in a new tab"
              onClick={objEvent => { objEvent.stopPropagation(); onOpenData(objObject); }}>
              <IconRows intSize={13} />
            </button>
          )}
          <button className="icon-btn icon-btn-sm h-5 min-w-5" aria-label="Details" title="Columns, indexes, DDL (double-click)"
            onClick={objEvent => { objEvent.stopPropagation(); onOpenObject(objObject); }}>
            <IconInfo intSize={13} />
          </button>
        </span>
        {objRow.item.rows != null && (
          <span className="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-muted group-hover:ml-0"
            title={`About ${objRow.item.rows.toLocaleString()} rows (estimate from the database statistics)`}>
            {compactCount(objRow.item.rows)}
          </span>
        )}
      </>
    );
  };

  const canToggle = (objRow: TreeRow) =>
    objRow.kind === 'schema' || (objRow.kind === 'object' && objRow.expandable) ||
    ((objRow.kind === 'group' || objRow.kind === 'folder') && objRow.count !== 0);

  const openTarget = (objRow: TreeRow) =>
    objRow.kind === 'object' ? objRow.item.object : objRow.kind === 'leaf' ? objRow.open : undefined;

  // ---- right-click menu ----
  const copy = (strText: string) => { navigator.clipboard.writeText(strText); };

  /** The DDL comes from the server; everything else in the menu is built here. */
  const openDdl = async (objObject: DbObjectInfo) => {
    setBoolScripting(true);
    try {
      const objDetail = await api.objectDetail(objConnection.id, objObject);
      if (objDetail.ddl) onOpenSql(objDetail.ddl);
      else alert(objDetail.ddlError ?? 'No DDL is available for this kind of object.');
    } catch (objEx) {
      alert(errorMessage(objEx));
    } finally {
      setBoolScripting(false);
    }
  };

  const menuItems = (objRow: TreeRow): MenuItem[] => {
    const strKind = objConnection.kind;
    const objRefresh: MenuItem = { label: 'Refresh', icon: <IconRefresh intSize={14} />, onSelect: () => load(true) };

    if (objRow.kind === 'message') return [];
    // An entry that is an object of its own (a procedure using the table, a trigger) gets that object's menu.
    if (objRow.kind === 'leaf' && !objRow.open) return [{ label: 'Copy name', onSelect: () => copy(objRow.label) }];
    if (objRow.kind !== 'object' && objRow.kind !== 'leaf') {
      return [
        ...(canToggle(objRow) ? [{ label: objRow.expanded ? 'Collapse' : 'Expand', onSelect: () => toggle(objRow) }] : []),
        ...(objRow.kind === 'schema'
          ? [
            { label: 'New SQL tab', icon: <IconPlus intSize={14} />, onSelect: () => onOpenSql('') },
            { label: 'Copy name', onSelect: () => copy(quoteIdent(objRow.label, strKind)) },
          ]
          : []),
        { kind: 'separator' },
        objRefresh,
      ];
    }

    const objObject = objRow.kind === 'leaf' ? objRow.open! : objRow.item.object;
    const arrColumns = objRow.kind === 'object' ? objRow.item.columns ?? [] : [];
    const { type: strType } = objObject;
    const boolTableLike = TABLE_LIKE.has(strType);
    const boolWritable = strType === 'TABLE' || strType === 'COLLECTION';
    const boolCallable = strType === 'PROCEDURE' || strType === 'FUNCTION';

    return [
      ...(boolCallable
        ? [{ label: 'Execute…', icon: <IconPlay intSize={12} />, onSelect: () => onExecuteRoutine(objObject) }]
        : []),
      ...(boolTableLike
        ? [
          { label: 'Open data', icon: <IconRows intSize={14} />, onSelect: () => onOpenData(objObject) },
          { label: 'Count rows', onSelect: () => onOpenSql(countScript(objObject, strKind), true) },
        ]
        : []),
      { label: 'View details', icon: <IconInfo intSize={14} />, onSelect: () => onOpenObject(objObject) },
      { kind: 'separator' },
      { kind: 'header', label: 'Generate script' },
      ...(boolTableLike ? [{ label: 'SELECT', onSelect: () => onOpenSql(selectScript(objObject, arrColumns, strKind)) }] : []),
      ...(boolWritable
        ? [
          { label: 'INSERT', onSelect: () => onOpenSql(insertScript(objObject, arrColumns, strKind)) },
          { label: 'UPDATE', onSelect: () => onOpenSql(updateScript(objObject, arrColumns, strKind)) },
          { label: 'DELETE', onSelect: () => onOpenSql(deleteScript(objObject, strKind)) },
        ]
        : []),
      ...(boolCallable ? [{ label: 'EXECUTE', onSelect: () => onOpenSql(executeScript(objObject, strKind)) }] : []),
      ...(strType === 'SEQUENCE' ? [{ label: 'NEXTVAL', onSelect: () => onOpenSql(nextValueScript(objObject, strKind)) }] : []),
      { label: 'CREATE (DDL)', onSelect: () => { openDdl(objObject); } },
      { label: 'DROP', danger: true, onSelect: () => onOpenSql(dropScript(objObject, strKind)) },
      { kind: 'separator' },
      { label: 'Copy name', onSelect: () => copy(quoteIdent(objObject.name, strKind)) },
      { label: 'Copy qualified name', onSelect: () => copy(qualifiedName(objObject.schema, objObject.name, strKind)) },
      { kind: 'separator' },
      objRefresh,
    ];
  };

  const arrMenuItems = objMenu ? menuItems(objMenu.row) : [];

  // ---- pinned ancestors of the first visible row ----
  /** Indexes of the rows a row is nested in, outermost first. */
  const ancestorsOf = (intIndex: number) => {
    const arrChain: number[] = [];
    let intDepth = arrRows[intIndex]?.depth ?? 0;
    for (let intBack = intIndex - 1; intBack >= 0 && intDepth > 0; intBack--) {
      if (arrRows[intBack].depth < intDepth) {
        arrChain.unshift(intBack);
        intDepth = arrRows[intBack].depth;
      }
    }
    return arrChain;
  };

  // Pinned rows cover the top of the list, so the row they describe is the first one still visible
  // below them: settle on a chain whose length agrees with the row it was computed for.
  const intFirstVisible = Math.floor(Math.max(0, (objVirtual.scrollOffset ?? 0) + TREE_STICKY_TOP - intMargin) / ROW_H);
  let arrPinned: number[] = [];
  for (let intPass = 0; intPass < 5 && arrRows.length > 0; intPass++) {
    const intTarget = Math.min(intFirstVisible + arrPinned.length, arrRows.length - 1);
    const arrNext = ancestorsOf(intTarget).filter((intIndex, intPosition) => intIndex < intFirstVisible + intPosition);
    const boolSettled = arrNext.length === arrPinned.length;
    arrPinned = arrNext;
    if (boolSettled) break;
  }

  return (
    <div className="pb-1 text-xs">
      {(strState === 'loading' || boolScripting) && (
        <p className="px-3 py-1 text-muted">{boolScripting ? 'Building DDL…' : objMetadata ? 'Reloading objects…' : 'Connecting…'}</p>
      )}
      {strState !== 'idle' && strState !== 'loading' && !objMetadata && (
        <p className="mx-2 mb-1.5 rounded border border-danger/40 p-2 text-xs text-danger">{strState}</p>
      )}
      {objMetadata?.objectsError && (
        <p className="mx-2 mb-1.5 rounded border border-line p-2 text-xs text-muted" title={objMetadata.objectsError}>
          Functions and sequences could not be listed.
        </p>
      )}

      <div ref={refList}>
        {/* The schema / folder / table the top row belongs to stays pinned, so a folder with hundreds
            of entries can be collapsed (click) without scrolling back up to it. */}
        <div className="sticky z-10 h-0" style={{ top: TREE_STICKY_TOP }}>
          {arrPinned.length > 0 && (
            <div className="border-b border-line bg-bg shadow-md">
              {arrPinned.map(intIndex => {
                const objRow = arrRows[intIndex];
                return (
                  <div
                    key={objRow.key}
                    className="group flex w-full items-center gap-1.5 pr-1.5 hover:bg-hover"
                    style={{ height: ROW_H, paddingLeft: 8 + objRow.depth * 12 }}
                    title="Click to collapse"
                    onClick={() => {
                      if (canToggle(objRow)) toggle(objRow);
                      objVirtual.scrollToIndex(intIndex, { align: 'start' });
                    }}
                    onContextMenu={objEvent => {
                      objEvent.preventDefault();
                      setObjMenu({ x: objEvent.clientX, y: objEvent.clientY, row: objRow });
                    }}
                  >
                    {renderRow(objRow)}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div style={{ height: objVirtual.getTotalSize(), position: 'relative' }}>
          {objVirtual.getVirtualItems().map(objItem => {
            const objRow = arrRows[objItem.index];
            const objTarget = openTarget(objRow);
            return (
              <div
                key={objRow.key}
                className={`group absolute left-0 flex w-full items-center gap-1.5 pr-1.5 hover:bg-hover ${
                  objRow.key === strCurrentKey ? 'bg-accent/15 shadow-[inset_2px_0_0_var(--accent)]' : ''}`}
                style={{ height: ROW_H, transform: `translateY(${objItem.start - intMargin}px)`, paddingLeft: 8 + objRow.depth * 12 }}
                onClick={canToggle(objRow) ? () => toggle(objRow) : undefined}
                onDoubleClick={objTarget ? () => onOpenObject(objTarget) : undefined}
                onContextMenu={objEvent => {
                  objEvent.preventDefault();
                  setObjMenu({ x: objEvent.clientX, y: objEvent.clientY, row: objRow });
                }}
              >
                {renderRow(objRow)}
              </div>
            );
          })}
        </div>
        {objMetadata && arrRows.length === 0 && (
          <p className="px-3 py-2 text-muted">{strFilter.trim() ? 'Nothing matches the filter.' : 'No objects.'}</p>
        )}
      </div>

      {objMenu && arrMenuItems.length > 0 && (
        <ContextMenu intX={objMenu.x} intY={objMenu.y} arrItems={arrMenuItems} onClose={closeMenu} />
      )}
    </div>
  );
}
