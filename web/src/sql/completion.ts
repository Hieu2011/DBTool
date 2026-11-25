/**
 * Autocomplete.
 *  - Context (table / column / keyword position) and the tables in scope come from dt-sql-parser,
 *    run in a worker on the statement under the cursor: subqueries, CTEs and nested aliases resolve.
 *  - When the parser has nothing (Oracle-only syntax, PL/SQL blocks, a slow first parse) the older
 *    regex rules answer instead:
 *      after FROM / JOIN / UPDATE / INTO -> tables; `alias.` -> columns; `schema.` -> tables;
 *      anywhere else -> columns of tables in the query, tables, keywords.
 *
 * Keep the public API (registerSqlCompletion + metadataFor) so the editor code doesn't change.
 */
import type * as Monaco from 'monaco-editor';
import type { DbKind, SchemaMetadata, TableMeta } from '../types';
import type { AnalyzeRequest, AnalyzeResponse, ParserDialect, ScopeTable, SqlAnalysis } from './analysis';
import { builtinSnippets, snippetCode, snippetLabel } from './builtinSnippets';
import { derivedTables, type DerivedTable } from './derived';
import { qualifiedName, quoteIdent } from './identifiers';
import ParserWorker from './parser.worker?worker';
import { getSnippets } from './snippets';
import { splitStatements } from './statements';

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'ILIKE', 'IS', 'NULL',
  'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'ON', 'USING',
  'GROUP BY', 'HAVING', 'ORDER BY', 'ASC', 'DESC', 'LIMIT', 'OFFSET', 'FETCH FIRST', 'ROWS ONLY',
  'DISTINCT', 'AS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'UNION', 'UNION ALL', 'WITH',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'RETURNING', 'COUNT', 'SUM', 'MIN', 'MAX', 'AVG',
  'COALESCE', 'NVL', 'CAST', 'TO_CHAR', 'TO_DATE', 'NOW()', 'SYSDATE',
];

/** Words that can follow a table name but are not aliases. */
const NOT_ALIAS = new Set([
  'where', 'join', 'inner', 'left', 'right', 'full', 'cross', 'on', 'using', 'group', 'order', 'having',
  'limit', 'offset', 'fetch', 'union', 'set', 'values', 'returning', 'natural', 'start', 'connect',
  'for', 'window', 'except', 'intersect', 'minus', 'partition',
]);

const TABLE_REF = /\b(?:from|join|update|into)\s+((?:"?[\w$#]+"?\.)?"?[\w$#]+"?)(?:\s+(?:as\s+)?("?[\w$#]+"?))?/gi;
/** `FROM schema.table [AS] [alias] ` with the cursor after the last blank. Group 1: the keyword, 2: the alias. */
const AFTER_TABLE_NAME = /\b(from|join|update|into)\s+(?:"?[\w$#]+"?\.)?"?[\w$#]+"?(?:\s+(?:as\s+)?("?[\w$#]+"?))?\s+$/i;
const AFTER_TABLE_KEYWORD =/\b(from|join|update|into)\s+[\w$#."]*$/i;

/** Longer statements are not sent to the parser: it would cost more than the suggestions are worth. */
const MAX_PARSED_LENGTH = 20_000;
/** A parse that takes longer (ANTLR warming up) is answered by the regex rules. */
const PARSE_TIMEOUT_MS = 1200;

export const unquote = (strValue: string) => strValue.replace(/"/g, '').toLowerCase();

/** Monaco model uri -> metadata of the connection that editor is bound to. */
const dicRegistry = new Map<string, () => SchemaMetadata | undefined>();

const dialectOf = (objModel: Monaco.editor.ITextModel): ParserDialect => (objModel.getLanguageId() === 'pgsql' ? 'pgsql' : 'oracle');

// Oracle lists one schema at a time: how an editor loads another one, and the schemas that failed (not asked again).
type SchemaLoader = (strSchema: string) => Promise<SchemaMetadata>;
const dicSchemaLoaders = new Map<string, SchemaLoader>();
const dicFailedSchemas = new WeakMap<SchemaLoader, Set<string>>();

/** Lets autocomplete load a schema the statement names, so its tables are suggested without opening it in the tree first. */
export function schemaLoaderFor(objModel: Monaco.editor.ITextModel, fnLoad: SchemaLoader) {
  dicSchemaLoaders.set(objModel.uri.toString(), fnLoad);
  return () => dicSchemaLoaders.delete(objModel.uri.toString());
}

/**
 * The metadata with every schema loaded that the statement at the cursor names (`tms.` being typed, FROM tms.x):
 * each is loaded once, on first use.
 */
async function withNamedSchemas(objModel: Monaco.editor.ITextModel, objPosition: Monaco.Position, objMeta: SchemaMetadata): Promise<SchemaMetadata> {
  const fnLoad = dicSchemaLoaders.get(objModel.uri.toString());
  if (!fnLoad || !objMeta.schemas) return objMeta;
  const objStatement = statementAtCursor(objModel.getValue(), objModel.getOffsetAt(objPosition), dialectOf(objModel));
  const strLine = objModel.getLineContent(objPosition.lineNumber).slice(0, objPosition.column - 1);
  const arrNames = [
    /("?[\w$#]+"?)\s*\.\s*"?[\w$#]*$/.exec(strLine)?.[1],
    ...[...(objStatement?.sql ?? '').matchAll(TABLE_REF)].map(arrMatch => (arrMatch[1].includes('.') ? arrMatch[1].split('.')[0] : undefined)),
  ].filter((strName): strName is string => !!strName).map(unquote);

  let hsFailed = dicFailedSchemas.get(fnLoad);
  if (!hsFailed) dicFailedSchemas.set(fnLoad, hsFailed = new Set());
  let objLatest = objMeta;
  for (const strName of new Set(arrNames)) {
    const strSchema = objMeta.schemas.find(strItem => strItem.toLowerCase() === strName);
    if (!strSchema || objLatest.loadedSchemas?.includes(strSchema) || hsFailed.has(strSchema)) continue;
    try {
      objLatest = await fnLoad(strSchema);
    } catch {
      hsFailed.add(strSchema);
    }
  }
  return objLatest;
}

/** Metadata of the connection the model's editor is bound to (other completion providers use it too). */
export const metadataOf = (objModel: Monaco.editor.ITextModel) => dicRegistry.get(objModel.uri.toString())?.();

export function metadataFor(objModel: Monaco.editor.ITextModel, fnGetMetadata: () => SchemaMetadata | undefined) {
  dicRegistry.set(objModel.uri.toString(), fnGetMetadata);
  // Only SQL editors use the parser.
  if (objModel.getLanguageId() === 'pgsql' || objModel.getLanguageId() === 'sql') warmUp(dialectOf(objModel));
  return () => dicRegistry.delete(objModel.uri.toString());
}

// ---- parser worker ----
let objWorker: Worker | null = null;
let intNextId = 1;
const dicPending = new Map<number, (objAnalysis: SqlAnalysis | null) => void>();
const hsWarm = new Set<ParserDialect>();

function worker(): Worker | null {
  if (objWorker) return objWorker;
  try {
    objWorker = new ParserWorker();
    objWorker.onmessage = (objEvent: MessageEvent<AnalyzeResponse>) => {
      dicPending.get(objEvent.data.id)?.(objEvent.data.analysis);
      dicPending.delete(objEvent.data.id);
    };
    // A worker that fails to load answers nobody: the timeouts fall back to the regex rules.
    objWorker.onerror = () => {};
  } catch {
    objWorker = null;
  }
  return objWorker;
}

/** Null when the parser has no answer in time. */
function analyze(strDialect: ParserDialect, strSql: string, intLine: number, intColumn: number, intTimeoutMs = PARSE_TIMEOUT_MS) {
  return new Promise<SqlAnalysis | null>(fnResolve => {
    const objTarget = worker();
    if (!objTarget) return fnResolve(null);
    const intId = intNextId++;
    const intTimer = setTimeout(() => { dicPending.delete(intId); fnResolve(null); }, intTimeoutMs);
    dicPending.set(intId, objAnalysis => { clearTimeout(intTimer); fnResolve(objAnalysis); });
    const objRequest: AnalyzeRequest = { id: intId, dialect: strDialect, sql: strSql, line: intLine, column: intColumn };
    objTarget.postMessage(objRequest);
  });
}

/** The first parses of a dialect are the slow ones: do them before the user asks for suggestions. */
function warmUp(strDialect: ParserDialect) {
  if (hsWarm.has(strDialect)) return;
  hsWarm.add(strDialect);
  const strSql = 'select a.id, b.name from t a join u b on b.id = a.id where a.x = 1 and b.y in (1, 2) order by 1';
  void analyze(strDialect, strSql, 1, 8, 30_000)
    .then(() => analyze(strDialect, strSql, 1, strSql.indexOf('where') + 7, 30_000));
}

/** The statement being typed at intOffset, with the cursor's 1-based line / column inside it. */
function statementAtCursor(strSql: string, intOffset: number, strDialect: ParserDialect) {
  const objCandidate = splitStatements(strSql, strDialect).filter(objStatement => objStatement.start <= intOffset).at(-1);
  let intStart = 0;
  let intEnd = intOffset;
  if (objCandidate) {
    const boolTerminated = objCandidate.stop > objCandidate.end && /[;/]/.test(strSql[objCandidate.stop - 1]);
    if (boolTerminated && intOffset >= objCandidate.stop) intStart = objCandidate.stop; // a new statement after the `;`
    else {
      intStart = objCandidate.start;
      intEnd = boolTerminated ? Math.max(objCandidate.end, intOffset) : objCandidate.stop;
    }
  }
  const strStatement = strSql.slice(intStart, intEnd);
  if (!strStatement.trim() || strStatement.length > MAX_PARSED_LENGTH) return null;
  const arrLines = strStatement.slice(0, intOffset - intStart).split('\n');
  return { sql: strStatement, line: arrLines.length, column: arrLines[arrLines.length - 1].length + 1 };
}

// ---- metadata lookups ----
// Tables by lower-case name, built once per metadata object: a big Oracle schema has thousands of tables and
// autocomplete looks names up on every keystroke.
const dicTableIndex = new WeakMap<SchemaMetadata, Map<string, TableMeta[]>>();

export function findTable(objMeta: SchemaMetadata, strRef: string): TableMeta | undefined {
  const arrParts = strRef.split('.').map(unquote);
  const [strSchema, strName] = arrParts.length === 2 ? arrParts : [undefined, arrParts[0]];
  let dicByName = dicTableIndex.get(objMeta);
  if (!dicByName) {
    dicByName = new Map();
    for (const objTable of objMeta.tables) {
      const strKey = objTable.name.toLowerCase();
      const arrSame = dicByName.get(strKey);
      if (arrSame) arrSame.push(objTable);
      else dicByName.set(strKey, [objTable]);
    }
    dicTableIndex.set(objMeta, dicByName);
  }
  return dicByName.get(strName)?.find(objTable => !strSchema || objTable.schema.toLowerCase() === strSchema);
}

/** alias (or bare table name) -> table, for every table referenced in the statement. */
export function tablesInQuery(objMeta: SchemaMetadata, strSql: string) {
  const dicTables = new Map<string, TableMeta>();
  for (const arrMatch of strSql.matchAll(TABLE_REF)) {
    const objTable = findTable(objMeta, arrMatch[1]);
    if (!objTable) continue;
    dicTables.set(objTable.name.toLowerCase(), objTable);
    const strAlias = arrMatch[2] && unquote(arrMatch[2]);
    if (strAlias && !NOT_ALIAS.has(strAlias)) dicTables.set(strAlias, objTable);
  }
  return dicTables;
}

/** The scope entry `x.` points at: by alias first, then by its own name. */
function scopeEntry(arrScope: ScopeTable[], strQualifier: string) {
  return arrScope.find(objItem => objItem.alias && unquote(objItem.alias) === strQualifier)
    ?? arrScope.find(objItem => unquote(objItem.ref.split('.').pop() ?? '') === strQualifier);
}

// Short words an alias made of initials must not be.
const ALIAS_RESERVED = new Set(['AS', 'AT', 'BY', 'DO', 'GO', 'IF', 'IN', 'IS', 'NO', 'OF', 'ON', 'OR', 'TO', 'ADD', 'ALL', 'AND', 'ANY', 'ASC', 'END', 'FOR', 'NOT', 'ROW', 'SET', 'TOP']);

const KEYWORD_WORDS = new Set(KEYWORDS.flatMap(strWord => strWord.replace('()', '').split(' ')));
/**
 * A snippet the user wrote, in PostgreSQL's lower-case style: only whole upper-case keywords change, never names,
 * quoted text or the $VARIABLES of the snippet syntax.
 */
const lowerKeywords = (strBody: string) =>
  strBody.replace(/'[^']*'|"[^"]*"|\$[A-Z_]+|\b[A-Z_]+\b/g, strPart => (KEYWORD_WORDS.has(strPart) ? strPart.toLowerCase() : strPart));

const CLAUSE_KEYWORD =/\b(select|from|join|where|on|having|group\s+by|order\s+by|connect\s+by|start\s+with|set|into|update|values|using)\b/gi;
const FILTER_CLAUSES = new Set(['where', 'on', 'having', 'group by', 'order by', 'connect by', 'start with']);

let boolRegistered = false;

export function registerSqlCompletion(objMonaco: typeof Monaco) {
  if (boolRegistered) return;
  boolRegistered = true;

  const objProvider: Monaco.languages.CompletionItemProvider = {
    triggerCharacters: ['.', ' '],
    async provideCompletionItems(objModel, objPosition, _objContext, objToken) {
      const objKnown = dicRegistry.get(objModel.uri.toString())?.();
      const objMeta = objKnown && await withNamedSchemas(objModel, objPosition, objKnown);
      if (objToken.isCancellationRequested) return { suggestions: [] };
      const objWord = objModel.getWordUntilPosition(objPosition);
      const objRange = {
        startLineNumber: objPosition.lineNumber,
        endLineNumber: objPosition.lineNumber,
        startColumn: objWord.startColumn,
        endColumn: objWord.endColumn,
      };
      const objKind = objMonaco.languages.CompletionItemKind;
      // Keywords in the case each database's own style uses: lower for PostgreSQL, upper for Oracle.
      const boolLower = dialectOf(objModel) === 'pgsql';
      const keywordItems = (arrWords: string[] = KEYWORDS) => arrWords.map(strWord => (boolLower ? strWord.toLowerCase() : strWord.toUpperCase())).map(strKeyword => ({
        label: strKeyword, kind: objKind.Keyword, insertText: strKeyword, range: objRange, sortText: '3' + strKeyword,
      }));
      // The user's snippets, offered by prefix wherever a statement can start or continue.
      // Where a statement starts (nothing but comments since the last `;`) the snippets lead the list; elsewhere they
      // come last, under the names that fit the place.
      const strLead = objModel.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: objPosition.lineNumber, endColumn: objWord.startColumn });
      const boolStatementStart = strLead.slice(strLead.lastIndexOf(';') + 1).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim() === '';
      const arrOwn = getSnippets().filter(objSnippet => objSnippet.prefix)
        .map(objSnippet => (boolLower ? { ...objSnippet, body: lowerKeywords(objSnippet.body) } : objSnippet));
      const snippetItems = () => [...arrOwn, ...builtinSnippets(dialectOf(objModel), getSnippets())].map(objSnippet => ({
        label: snippetLabel(objSnippet),
        kind: objKind.Snippet,
        documentation: { value: '```sql\n' + snippetCode(objSnippet.body) + '\n```' },
        insertText: objSnippet.body,
        insertTextRules: objMonaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range: objRange,
        sortText: (boolStatementStart ? '0' : '8') + objSnippet.prefix,
      }));
      if (!objMeta) return { suggestions: [...snippetItems(), ...keywordItems()] };

      // Picking a table writes schema.table, except where the bare name already resolves:
      // the login's own schema on Oracle, public on PostgreSQL. boolQualify false: the schema was typed.
      const strDialect = dialectOf(objModel);
      const strDbKind: DbKind = strDialect === 'pgsql' ? 'PostgreSql' : 'Oracle';
      const strDefaultSchema = strDbKind === 'Oracle' ? objMeta.loadedSchemas?.[0] : 'public';
      // Right after FROM / JOIN a picked table also gets an alias, its initials (MD_DATASOURCE -> MD), as dbForge does.
      // Not when something that could be an alias already follows.
      // Worked out once per request, not once per table: the list can hold thousands of tables.
      let hsAliasTaken: Set<string> | null | undefined; // null: no alias fits here
      const aliasesTaken = () => {
        if (hsAliasTaken !== undefined) return hsAliasTaken;
        const strAfter = objModel.getLineContent(objPosition.lineNumber).slice(objWord.endColumn - 1);
        const boolFits = /\b(?:from|join)\s+(?:"?[\w$#]+"?\s*\.\s*)?$/i.test(strTextBefore)
          && /^\s*(?:$|[;)]|(?:where|join|inner|left|right|full|cross|on|order|group)\b)/i.test(strAfter);
        return hsAliasTaken = boolFits ? new Set(tablesInQuery(objMeta, objStatement?.sql ?? strSql).keys()) : null;
      };
      const aliasFor = (objTable: TableMeta) => {
        const hsTaken = aliasesTaken();
        if (!hsTaken) return '';
        const strBase = objTable.name.split(/[^A-Za-z0-9]+/).filter(Boolean).map(strPart => strPart[0]).join('') || 'T';
        let strAlias = strBase;
        for (let intNext = 1; hsTaken.has(strAlias.toLowerCase()) || NOT_ALIAS.has(strAlias.toLowerCase()) || ALIAS_RESERVED.has(strAlias.toUpperCase()) || /^\d/.test(strAlias); intNext++)
          strAlias = `${/^\d/.test(strBase) ? 'T' : strBase}${intNext}`;
        return ` ${strAlias}`;
      };
      const tableItem = (objTable: TableMeta, boolQualify = true) => ({
        label: objTable.name,
        kind: objTable.type === 'VIEW' ? objKind.Interface : objKind.Struct,
        detail: `${objTable.type.toLowerCase()} ${objTable.schema}`,
        insertText: (boolQualify && objTable.schema !== strDefaultSchema
          ? qualifiedName(objTable.schema, objTable.name, strDbKind)
          : quoteIdent(objTable.name, strDbKind)) + aliasFor(objTable),
        range: objRange,
        sortText: '2' + objTable.name,
      });
      // Where a table fits, so does a schema: picking one writes SCHEMA. and lists its tables (Oracle loads it on the way).
      const schemaItems = (): Monaco.languages.CompletionItem[] =>
        (objMeta.schemas ?? [...new Set(objMeta.tables.map(objTable => objTable.schema))]).map(strSchema => ({
          label: { label: strSchema, description: 'schema' },
          kind: objKind.Module,
          insertText: quoteIdent(strSchema, strDbKind) + '.',
          filterText: strSchema,
          range: objRange,
          sortText: '4' + strSchema, // under the tables ('2')
          command: { id: 'editor.action.triggerSuggest', title: 'Tables' },
        }));
      // strAlias: the table's alias in this statement; the column is then written alias.column.
      let intScopeNames = 0;
      // Columns stay grouped by table, in the order the tables were asked for.
      const dicGroup = new Map<string, string>();
      const groupOf = (strKey: string) => {
        if (!dicGroup.has(strKey)) dicGroup.set(strKey, String(dicGroup.size).padStart(2, '0'));
        return dicGroup.get(strKey)!;
      };
      const columnItems = (objTable: TableMeta, strAlias?: string): Monaco.languages.CompletionItem[] => objTable.columns.map((objColumn, intIndex) => ({
        // The list itself says whose column it is: PS.STOREID, with the table at the right edge.
        label: { label: strAlias ? `${strAlias}.${objColumn.name}` : objColumn.name, description: objTable.name },
        kind: objKind.Field,
        detail: `${objColumn.dataType}  ${strAlias ? `${strAlias} · ` : ''}${objTable.name}`,
        insertText: strAlias ? `${strAlias}.${objColumn.name}` : objColumn.name,
        // Typing the alias alone (`ps`) already lists its columns, as typing a column name does.
        filterText: strAlias ? `${strAlias}.${objColumn.name}` : objColumn.name,
        range: objRange,
        sortText: '1' + groupOf(`${strAlias ?? ''}|${objTable.schema}.${objTable.name}`) + String(intIndex).padStart(4, '0'),
      }));
      // PostgreSQL takes no alias on the column an UPDATE sets.
      const aliasAllowed = () => !(strDialect === 'pgsql' && /\bset\b(?:(?!\bwhere\b)[^;])*$/i.test(strTextBefore));
      /** Columns of the tables the text names (FROM / JOIN / UPDATE / INTO), each with its table's alias when it has one. */
      const columnsOfTables = (strText: string) => {
        const dicAlias = new Map<TableMeta, string | undefined>();
        for (const arrMatch of strText.matchAll(TABLE_REF)) {
          const objTable = findTable(objMeta, arrMatch[1]);
          if (!objTable) continue;
          const strAlias = arrMatch[2] && !NOT_ALIAS.has(unquote(arrMatch[2])) && aliasAllowed() ? arrMatch[2] : undefined;
          if (!dicAlias.get(objTable)) dicAlias.set(objTable, strAlias);
        }
        return [...dicAlias].flatMap(([objTable, strAlias]) => columnItems(objTable, strAlias));
      };
      /** An alias (or table name) of the statement: picked, it writes `name.` and opens the list of its columns. */
      const scopeNameItem = (strName: string, strOf: string, boolIsAlias: boolean): Monaco.languages.CompletionItem => ({
        label: { label: strName, description: boolIsAlias ? `alias of ${strOf}` : strOf },
        kind: objKind.Variable,
        insertText: `${strName}.`,
        filterText: strName,
        range: objRange,
        sortText: '05' + String(intScopeNames++).padStart(2, '0'), // above the columns ('1…')
        command: { id: 'editor.action.triggerSuggest', title: 'Columns' },
      });
      /** The same, read from the text (FROM / JOIN ...) when the parser gave no scope. */
      const namedTables = (strText: string) => {
        const dicNames = new Map<string, Monaco.languages.CompletionItem>();
        for (const arrMatch of strText.matchAll(TABLE_REF)) {
          if (!findTable(objMeta, arrMatch[1])) continue;
          const boolAlias = !!arrMatch[2] && !NOT_ALIAS.has(unquote(arrMatch[2]));
          const strName = boolAlias ? arrMatch[2] : arrMatch[1].split('.').pop()!;
          if (!dicNames.has(strName.toLowerCase())) dicNames.set(strName.toLowerCase(), scopeNameItem(strName, arrMatch[1], boolAlias));
        }
        return [...dicNames.values()];
      };
      // Output columns of a subquery / CTE: names only, the parser does not know their types.
      const derivedItems = (objEntry: ScopeTable, boolAlias = false): Monaco.languages.CompletionItem[] => (objEntry.columns ?? []).map((strColumn, intIndex) => ({
        label: boolAlias && objEntry.alias ? `${objEntry.alias}.${strColumn}` : strColumn,
        kind: objKind.Field,
        detail: objEntry.alias ?? objEntry.ref,
        insertText: boolAlias && objEntry.alias ? `${objEntry.alias}.${strColumn}` : strColumn,
        filterText: boolAlias && objEntry.alias ? `${objEntry.alias}.${strColumn}` : strColumn,
        range: objRange,
        sortText: '1' + groupOf(`${objEntry.alias ?? ''}|${objEntry.ref}`) + String(intIndex).padStart(4, '0'),
      }));
      // boolAlias false: the qualifier is already typed (`x.`).
      const scopeColumns = (objEntry: ScopeTable, boolAlias = true) => {
        const boolPrefix = boolAlias && aliasAllowed();
        if (objEntry.columns) return derivedItems(objEntry, boolPrefix);
        const objTable = findTable(objMeta, objEntry.ref);
        return objTable ? columnItems(objTable, boolPrefix ? objEntry.alias : undefined) : [];
      };
      const routineItems = (arrTypes: string[], strSchema?: string) => objMeta.objects
        .filter(objItem => arrTypes.includes(objItem.type) && (!strSchema || objItem.schema.toLowerCase() === strSchema))
        .map(objItem => ({
          label: objItem.name,
          kind: objKind.Function,
          detail: `${objItem.type.toLowerCase()} ${objItem.schema}`,
          insertText: strSchema || objItem.schema === strDefaultSchema
            ? quoteIdent(objItem.name, strDbKind)
            : qualifiedName(objItem.schema, objItem.name, strDbKind),
          range: objRange,
          sortText: '5' + objItem.name, // after tables ('2') and keywords ('3')
        }));

      const strTextBefore = objModel.getValueInRange({
        startLineNumber: Math.max(1, objPosition.lineNumber - 3),
        startColumn: 1,
        endLineNumber: objPosition.lineNumber,
        endColumn: objWord.startColumn,
      });
      const strSql = objModel.getValue();

      const objStatement = statementAtCursor(strSql, objModel.getOffsetAt(objPosition), strDialect);
      const objAnalysis = objStatement ? await analyze(strDialect, objStatement.sql, objStatement.line, objStatement.column) : null;
      if (objToken.isCancellationRequested) return { suggestions: [] };
      const arrScope = objAnalysis?.scope ?? [];

      // Subqueries / CTEs read from the text: the generic grammar (Oracle) does not report their columns.
      const boolParserDerived = arrScope.some(objEntry => objEntry.columns);
      const arrDerived = boolParserDerived ? [] : derivedTables(objStatement?.sql ?? strSql);
      const textDerivedItems = (objDerived: DerivedTable) => {
        const dicInner = tablesInQuery(objMeta, objDerived.inner);
        const arrStarTables = objDerived.stars.flatMap(strStar => {
          const objTable = strStar === '' ? undefined : dicInner.get(unquote(strStar));
          return strStar === '' ? [...new Set(dicInner.values())] : objTable ? [objTable] : [];
        });
        return [...derivedItems({ ref: objDerived.name, columns: objDerived.columns }), ...arrStarTables.flatMap(objTable => columnItems(objTable))];
      };

      // `x.` -> columns of the alias / table / subquery, or the tables of schema x
      const arrDot = /("?[\w$#]+"?)\.$/.exec(strTextBefore);
      if (arrDot) {
        const strQualifier = unquote(arrDot[1]);
        const objEntry = scopeEntry(arrScope, strQualifier);
        if (objEntry) {
          const arrColumns = scopeColumns(objEntry, false);
          if (arrColumns.length > 0 || objEntry.columns) return { suggestions: arrColumns };
        }
        const objDerived = arrDerived.find(objItem => unquote(objItem.name) === strQualifier);
        if (objDerived) {
          const arrColumns = textDerivedItems(objDerived);
          if (arrColumns.length > 0) return { suggestions: arrColumns };
        }
        const objTable = tablesInQuery(objMeta, strSql).get(strQualifier) ?? findTable(objMeta, strQualifier);
        if (objTable) return { suggestions: columnItems(objTable) };
        const arrInSchema = objMeta.tables.filter(objItem => objItem.schema.toLowerCase() === strQualifier);
        // FROM schema.| : only tables fit; procedures and packages would bury them.
        if (/\b(?:from|join|update|into)\s+"?[\w$#]+"?\.$/i.test(strTextBefore)) return { suggestions: arrInSchema.map(objItem => tableItem(objItem, false)) };
        return {
          suggestions: [...arrInSchema.map(objItem => tableItem(objItem, false)), ...routineItems(['FUNCTION', 'PROCEDURE', 'PACKAGE'], strQualifier)],
        };
      }

      // A table (and its alias) was just finished: `FROM t ps |`. What follows is a clause, never another table.
      const arrAfterTable = AFTER_TABLE_NAME.exec(strTextBefore);
      const strAfterAlias = arrAfterTable?.[2] ? unquote(arrAfterTable[2]) : '';
      if (arrAfterTable && strAfterAlias !== 'as' && !NOT_ALIAS.has(strAfterAlias)) {
        const strLeadWord = arrAfterTable[1].toLowerCase();
        const arrNext = strLeadWord === 'update' ? ['SET']
          : strLeadWord === 'into' ? ['VALUES', 'SELECT', 'USING']
            : [
              'WHERE', ...(strLeadWord === 'join' ? ['ON', 'USING'] : []),
              'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'GROUP BY', 'ORDER BY', 'HAVING', 'UNION', 'UNION ALL',
              ...(strDialect === 'pgsql' ? ['LIMIT', 'OFFSET'] : ['CONNECT BY', 'START WITH', 'MINUS']),
              ...(strAfterAlias ? [] : ['AS']),
            ];
        // In the order a statement is written, not by alphabet.
        return { suggestions: keywordItems(arrNext).map((objItem, intIndex) => ({ ...objItem, sortText: '3' + String(intIndex).padStart(2, '0') })) };
      }

      // WHERE / ON / HAVING / GROUP BY / ORDER BY: only the tables the statement already names fit, never the whole schema.
      // Closed (...) groups are dropped first, so a finished subquery does not decide the clause.
      let strOpen = strLead.slice(strLead.lastIndexOf(';') + 1).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'/g, "''");
      for (let strPrev = ''; strPrev !== strOpen;) { strPrev = strOpen; strOpen = strOpen.replace(/\([^()]*\)/g, ' '); }
      const strClause = [...strOpen.matchAll(CLAUSE_KEYWORD)].at(-1)?.[1].toLowerCase().replace(/\s+/g, ' ') ?? '';
      const boolFilterClause = FILTER_CLAUSES.has(strClause);

      const hsContexts = new Set(objAnalysis?.contexts ?? []);
      const boolTables = (hsContexts.has('table') || hsContexts.has('view')) && !boolFilterClause;
      const boolColumns = hsContexts.has('column') || boolFilterClause;
      // Only a routine fits (CALL ...): elsewhere functions come with columns and would flood the list.
      const boolRoutines = hsContexts.has('procedure') || (hsContexts.has('function') && !boolTables && !boolColumns);

      // The parser placed the cursor: offer what fits there. A keyword-only answer is trusted from the
      // PostgreSQL grammar alone: the generic one (Oracle) misses places where names are still valid.
      const boolKeywordsOnly = strDialect === 'pgsql' && (objAnalysis?.keywords.length ?? 0) > 0;
      if (objAnalysis && (boolTables || boolColumns || boolRoutines || boolKeywordsOnly)) {
        const arrItems: Monaco.languages.CompletionItem[] = [];
        if (boolColumns) {
          const arrColumns = arrScope.flatMap(objEntry => scopeColumns(objEntry));
          // Broken SQL can hide the FROM clause from the parser: the regex still finds its tables.
          arrItems.push(...(arrColumns.length > 0 ? arrColumns : columnsOfTables(objStatement?.sql ?? strSql)));
          arrItems.push(...arrDerived.flatMap(textDerivedItems));
          // The tables of the statement lead the list, by alias (or bare name): picking one writes `PS.` and lists its columns.
          const hsNamed = new Set<string>();
          for (const objEntry of arrScope) {
            const strName = objEntry.alias ?? (objEntry.columns ? undefined : objEntry.ref.split('.').pop());
            if (!strName || hsNamed.has(strName.toLowerCase())) continue;
            hsNamed.add(strName.toLowerCase());
            arrItems.push(scopeNameItem(strName, objEntry.columns ? 'subquery' : objEntry.ref, !!objEntry.alias));
          }
          if (hsNamed.size === 0) arrItems.push(...namedTables(objStatement?.sql ?? strSql));
        }
        if (boolTables) arrItems.push(...objMeta.tables.map(objItem => tableItem(objItem)), ...schemaItems());
        if (boolRoutines) arrItems.push(...routineItems(hsContexts.has('procedure') ? ['PROCEDURE'] : ['PROCEDURE', 'FUNCTION']));
        // The generic grammar (Oracle) knows few keywords: keep the fixed list there.
        const arrKeywords = strDialect === 'pgsql' && objAnalysis.keywords.length > 0 ? objAnalysis.keywords : KEYWORDS;
        // After FROM / JOIN only names fit; snippets and keywords would bury them.
        if (!boolTables || boolColumns) arrItems.unshift(...snippetItems());
        if (!boolTables || boolColumns || arrItems.length === 0) arrItems.push(...keywordItems(arrKeywords));
        return { suggestions: arrItems };
      }

      // ---- regex rules ----
      // right after FROM/JOIN -> tables only
      if (AFTER_TABLE_KEYWORD.test(strTextBefore)) {
        return { suggestions: [...objMeta.tables.map(objItem => tableItem(objItem)), ...schemaItems()] };
      }

      const arrColumns = columnsOfTables(objStatement?.sql ?? strSql);
      if (boolFilterClause && arrColumns.length > 0)
        return { suggestions: [...namedTables(objStatement?.sql ?? strSql), ...arrColumns,...arrDerived.flatMap(textDerivedItems), ...snippetItems(), ...keywordItems()] };
      return {
        suggestions: [...snippetItems(), ...arrColumns, ...arrDerived.flatMap(textDerivedItems), ...objMeta.tables.map(objItem => tableItem(objItem)),
          ...schemaItems(), ...keywordItems()],
      };
    },
  };

  objMonaco.languages.registerCompletionItemProvider('pgsql', objProvider);
  objMonaco.languages.registerCompletionItemProvider('sql', objProvider);
}
