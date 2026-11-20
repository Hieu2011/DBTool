/** What the parser worker tells the autocomplete about the statement under the cursor. */

/** A table the cursor can see. columns set = a subquery or CTE: its output columns, as written. */
export interface ScopeTable {
  /** Table reference as written (`schema.table`, `"Name"`), or the CTE's name. */
  ref: string;
  alias?: string;
  columns?: string[];
}

export interface SqlAnalysis {
  /** What the grammar accepts at the cursor: table, view, column, function, procedure... */
  contexts: string[];
  keywords: string[];
  scope: ScopeTable[];
}

export type ParserDialect = 'pgsql' | 'oracle';

/** line / column: 1-based position of the cursor inside sql. */
export interface AnalyzeRequest { id: number; dialect: ParserDialect; sql: string; line: number; column: number }
export interface AnalyzeResponse { id: number; analysis: SqlAnalysis | null }
