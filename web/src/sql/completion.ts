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
const AFTER_TABLE_KEYWORD = /\b(from|join|update|into)\s+[\w$#."]*$/i;

/** Longer statements are not sent to the parser: it would cost more than the suggestions are worth. */
const MAX_PARSED_LENGTH = 20_000;
/** A parse that takes longer (ANTLR warming up) is answered by the regex rules. */
const PARSE_TIMEOUT_MS = 1200;

export const unquote = (strValue: string) => strValue.replace(/"/g, '').toLowerCase();

/** Monaco model uri -> metadata of the connection that editor is bound to. */
const dicRegistry = new Map<string, () => SchemaMetadata | undefined>();

const dialectOf = (objModel: Monaco.editor.ITextModel): ParserDialect => (objModel.getLanguageId() === 'pgsql' ? 'pgsql' : 'oracle');

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
export function findTable(objMeta: SchemaMetadata, strRef: string): TableMeta | undefined {
  const arrParts = strRef.split('.').map(unquote);
  const [strSchema, strName] = arrParts.length === 2 ? arrParts : [undefined, arrParts[0]];
  return objMeta.tables.find(objTable =>
    objTable.name.toLowerCase() === strName && (!strSchema || objTable.schema.toLowerCase() === strSchema));
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

let boolRegistered = false;

export function registerSqlCompletion(objMonaco: typeof Monaco) {
  if (boolRegistered) return;
  boolRegistered = true;

  const objProvider: Monaco.languages.CompletionItemProvider = {
    triggerCharacters: ['.', ' '],
    async provideCompletionItems(objModel, objPosition, _objContext, objToken) {
      const objMeta = dicRegistry.get(objModel.uri.toString())?.();
      const objWord = objModel.getWordUntilPosition(objPosition);
      const objRange = {
        startLineNumber: objPosition.lineNumber,
        endLineNumber: objPosition.lineNumber,
        startColumn: objWord.startColumn,
        endColumn: objWord.endColumn,
      };
      const objKind = objMonaco.languages.CompletionItemKind;
      const keywordItems = (arrWords: string[] = KEYWORDS) => arrWords.map(strKeyword => ({
        label: strKeyword, kind: objKind.Keyword, insertText: strKeyword, range: objRange, sortText: '3' + strKeyword,
      }));
      // The user's snippets, offered by prefix wherever a statement can start or continue.
      const snippetItems = () => getSnippets().filter(objSnippet => objSnippet.prefix).map(objSnippet => ({
        label: objSnippet.prefix,
        kind: objKind.Snippet,
        detail: objSnippet.name,
        documentation: objSnippet.body,
        insertText: objSnippet.body,
        insertTextRules: objMonaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range: objRange,
        sortText: '0' + objSnippet.prefix,
      }));
      if (!objMeta) return { suggestions: [...snippetItems(), ...keywordItems()] };

      // Picking a table writes schema.table, except where the bare name already resolves:
      // the login's own schema on Oracle, public on PostgreSQL. boolQualify false: the schema was typed.
      const strDialect = dialectOf(objModel);
      const strDbKind: DbKind = strDialect === 'pgsql' ? 'PostgreSql' : 'Oracle';
      const strDefaultSchema = strDbKind === 'Oracle' ? objMeta.loadedSchemas?.[0] : 'public';
      const tableItem = (objTable: TableMeta, boolQualify = true) => ({
        label: objTable.name,
        kind: objTable.type === 'VIEW' ? objKind.Interface : objKind.Struct,
        detail: `${objTable.type.toLowerCase()} ${objTable.schema}`,
        insertText: boolQualify && objTable.schema !== strDefaultSchema
          ? qualifiedName(objTable.schema, objTable.name, strDbKind)
          : quoteIdent(objTable.name, strDbKind),
        range: objRange,
        sortText: '2' + objTable.name,
      });
      const columnItems = (objTable: TableMeta) => objTable.columns.map((objColumn, intIndex) => ({
        label: objColumn.name,
        kind: objKind.Field,
        detail: `${objColumn.dataType}  ${objTable.name}`,
        insertText: objColumn.name,
        range: objRange,
        sortText: '1' + String(intIndex).padStart(4, '0'),
      }));
      // Output columns of a subquery / CTE: names only, the parser does not know their types.
      const derivedItems = (objEntry: ScopeTable) => (objEntry.columns ?? []).map((strColumn, intIndex) => ({
        label: strColumn,
        kind: objKind.Field,
        detail: objEntry.alias ?? objEntry.ref,
        insertText: strColumn,
        range: objRange,
        sortText: '1' + String(intIndex).padStart(4, '0'),
      }));
      const scopeColumns = (objEntry: ScopeTable) => {
        if (objEntry.columns) return derivedItems(objEntry);
        const objTable = findTable(objMeta, objEntry.ref);
        return objTable ? columnItems(objTable) : [];
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
          sortText: '25' + objItem.name,
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
        return [...derivedItems({ ref: objDerived.name, columns: objDerived.columns }), ...arrStarTables.flatMap(columnItems)];
      };

      // `x.` -> columns of the alias / table / subquery, or the tables of schema x
      const arrDot = /("?[\w$#]+"?)\.$/.exec(strTextBefore);
      if (arrDot) {
        const strQualifier = unquote(arrDot[1]);
        const objEntry = scopeEntry(arrScope, strQualifier);
        if (objEntry) {
          const arrColumns = scopeColumns(objEntry);
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
        return {
          suggestions: [...arrInSchema.map(objItem => tableItem(objItem, false)), ...routineItems(['FUNCTION', 'PROCEDURE', 'PACKAGE'], strQualifier)],
        };
      }

      const hsContexts = new Set(objAnalysis?.contexts ?? []);
      const boolTables = hsContexts.has('table') || hsContexts.has('view');
      const boolColumns = hsContexts.has('column');
      // Only a routine fits (CALL ...): elsewhere functions come with columns and would flood the list.
      const boolRoutines = hsContexts.has('procedure') || (hsContexts.has('function') && !boolTables && !boolColumns);

      // The parser placed the cursor: offer what fits there. A keyword-only answer is trusted from the
      // PostgreSQL grammar alone: the generic one (Oracle) misses places where names are still valid.
      const boolKeywordsOnly = strDialect === 'pgsql' && (objAnalysis?.keywords.length ?? 0) > 0;
      if (objAnalysis && (boolTables || boolColumns || boolRoutines || boolKeywordsOnly)) {
        const arrItems: Monaco.languages.CompletionItem[] = [];
        if (boolColumns) {
          const arrColumns = arrScope.flatMap(scopeColumns);
          // Broken SQL can hide the FROM clause from the parser: the regex still finds its tables.
          arrItems.push(...(arrColumns.length > 0 ? arrColumns : [...new Set(tablesInQuery(objMeta, strSql).values())].flatMap(columnItems)));
          arrItems.push(...arrDerived.flatMap(textDerivedItems));
          for (const objEntry of arrScope) {
            if (!objEntry.alias) continue;
            arrItems.push({
              label: objEntry.alias, kind: objKind.Variable, detail: `alias of ${objEntry.columns ? 'subquery' : objEntry.ref}`,
              insertText: objEntry.alias, range: objRange, sortText: '15' + objEntry.alias,
            });
          }
        }
        if (boolTables) arrItems.push(...objMeta.tables.map(objItem => tableItem(objItem)));
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
        return { suggestions: objMeta.tables.map(objItem => tableItem(objItem)) };
      }

      const arrColumns = [...new Set(tablesInQuery(objMeta, strSql).values())].flatMap(columnItems);
      return {
        suggestions: [...snippetItems(), ...arrColumns, ...arrDerived.flatMap(textDerivedItems), ...objMeta.tables.map(objItem => tableItem(objItem)),
          ...keywordItems()],
      };
    },
  };

  objMonaco.languages.registerCompletionItemProvider('pgsql', objProvider);
  objMonaco.languages.registerCompletionItemProvider('sql', objProvider);
}
