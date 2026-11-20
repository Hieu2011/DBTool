/**
 * Runs dt-sql-parser off the UI thread: the first parses of a session take a second or more
 * while ANTLR warms up. PostgreSQL has its own grammar; Oracle gets the generic one (the library
 * has no PL/SQL), which only understands plain statements.
 */
import { PostgreSQL } from 'dt-sql-parser/dist/parser/postgresql';
import { GenericSQL } from 'dt-sql-parser/dist/parser/generic';
import type { AnalyzeRequest, AnalyzeResponse, ScopeTable, SqlAnalysis } from './analysis';

type Parser = PostgreSQL | GenericSQL;
type Entity = NonNullable<ReturnType<Parser['getAllEntities']>>[number];

const dicParsers: Partial<Record<AnalyzeRequest['dialect'], Parser>> = {};
const parserFor = (strDialect: AnalyzeRequest['dialect']): Parser =>
  (dicParsers[strDialect] ??= strDialect === 'pgsql' ? new PostgreSQL() : new GenericSQL());

const aliasOf = (objEntity: Entity) => (objEntity as { _alias?: { text: string } | null })._alias?.text;

/** `t.name` -> `name`; null for expressions and `*`. */
function columnName(strText: string): string | null {
  const strLast = strText.trim().split('.').pop() ?? '';
  return /^"[^"]+"$|^[\w$#]+$/.test(strLast) ? strLast : null;
}

function scopeOf(arrEntities: Entity[]): ScopeTable[] {
  const arrScope: ScopeTable[] = [];
  const hsSeen = new Set<string>();
  for (const objEntity of arrEntities) {
    if (objEntity.entityContextType !== 'table' && objEntity.entityContextType !== 'view') continue;
    if (objEntity.isAccessible !== true) continue;
    const strAlias = aliasOf(objEntity);
    // declareType 1: a subquery in FROM, or a reference to a CTE.
    const boolDerived = (objEntity as { declareType?: number }).declareType === 1;
    const objTable: ScopeTable = { ref: boolDerived && strAlias ? strAlias : objEntity.text.trim(), alias: strAlias };
    if (boolDerived) {
      const objResult = objEntity.relatedEntities?.find(objRelated => objRelated.entityContextType === 'queryResult');
      const arrColumns = (objResult as { columns?: Entity[] } | undefined)?.columns ?? [];
      objTable.columns = arrColumns
        .map(objColumn => aliasOf(objColumn) ?? columnName(objColumn.text))
        .filter((strName): strName is string => !!strName);
    }
    const strKey = `${objTable.ref}|${objTable.alias ?? ''}`;
    if (hsSeen.has(strKey)) continue;
    hsSeen.add(strKey);
    arrScope.push(objTable);
  }
  return arrScope;
}

function analyze(objRequest: AnalyzeRequest): SqlAnalysis | null {
  const objParser = parserFor(objRequest.dialect);
  const objCaret = { lineNumber: objRequest.line, column: objRequest.column };
  const objSuggestions = objParser.getSuggestionAtCaretPosition(objRequest.sql, objCaret);

  // Entities are a bonus: the collector gives up on some statements the suggestions handle.
  let arrScope: ScopeTable[] = [];
  try { arrScope = scopeOf(objParser.getAllEntities(objRequest.sql, objCaret) ?? []); } catch { /* keep the suggestions */ }

  if (!objSuggestions) return arrScope.length > 0 ? { contexts: [], keywords: [], scope: arrScope } : null;
  return {
    contexts: [...new Set(objSuggestions.syntax.map(objItem => String(objItem.syntaxContextType)))],
    keywords: objSuggestions.keywords,
    scope: arrScope,
  };
}

self.onmessage = (objEvent: MessageEvent<AnalyzeRequest>) => {
  let objAnalysis: SqlAnalysis | null = null;
  try { objAnalysis = analyze(objEvent.data); } catch { /* the caller falls back to its own rules */ }
  const objResponse: AnalyzeResponse = { id: objEvent.data.id, analysis: objAnalysis };
  self.postMessage(objResponse);
};
