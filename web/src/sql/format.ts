/**
 * SQL formatter for the editor. sql-formatter lays out plain SQL (DML, DDL); procedural code
 * (PL/SQL blocks, CREATE PROCEDURE / FUNCTION / PACKAGE / TRIGGER / TYPE, DO) is returned as typed:
 * the library splits it at every inner `;`. The built-in layout below is the fallback for DML.
 * Only whitespace and keyword case change: the result is re-tokenized and dropped if any token differs.
 */
import { formatDialect, plsql, postgresql } from 'sql-formatter';
import { skipBlockComment, skipQuoted, splitStatements, type SqlDialect } from './statements';

type TokenKind = 'word' | 'string' | 'quoted' | 'number' | 'bind' | 'op' | 'punct' | 'line' | 'block' | 'other';

interface Token {
  kind: TokenKind;
  text: string;
  /** Upper-cased text of a word, '' otherwise. */
  upper: string;
  /** Whitespace / a line break stood before it in the source. */
  space: boolean;
  newline: boolean;
}

const WORD = /[A-Za-z_\u0080-￿][\w$#\u0080-￿]*/y;
const NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const BIND = /:[\w$#]+|\$\d+/y;
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/y;
const OPERATOR = /[-+*/<>=~!@#%^&|?]+/y;
const STRING_PREFIX = /^(?:e|n|q|nq|b|x)$/i;
const Q_QUOTE_CLOSE: Record<string, string> = { '[': ']', '{': '}', '<': '>', '(': ')' };

function tokenize(strSql: string, strDialect: SqlDialect): Token[] {
  const arrTokens: Token[] = [];
  const boolOracle = strDialect === 'oracle';
  let intPos = 0;
  let boolSpace = false;
  let boolNewline = false;

  const push = (enmKind: TokenKind, intEnd: number, intFrom = intPos) => {
    const strText = strSql.slice(intFrom, intEnd);
    arrTokens.push({ kind: enmKind, text: strText, upper: enmKind === 'word' ? strText.toUpperCase() : '', space: boolSpace, newline: boolNewline });
    boolSpace = boolNewline = false;
    intPos = intEnd;
  };
  const match = (objRegex: RegExp) => {
    objRegex.lastIndex = intPos;
    return objRegex.exec(strSql)?.[0];
  };

  while (intPos < strSql.length) {
    const strChar = strSql[intPos];
    const strNext = strSql[intPos + 1];

    if (/\s/.test(strChar)) {
      boolSpace = true;
      if (strChar === '\n') boolNewline = true;
      intPos++;
    } else if (strChar === '-' && strNext === '-') {
      const intEol = strSql.indexOf('\n', intPos);
      push('line', intEol < 0 ? strSql.length : strSql[intEol - 1] === '\r' ? intEol - 1 : intEol);
    } else if (strChar === '/' && strNext === '*') {
      push('block', skipBlockComment(strSql, intPos, !boolOracle));
    } else if (strChar === "'") {
      // e'..', n'..', q'[..]': the prefix was read as a word, take it back.
      const objPrev = arrTokens[arrTokens.length - 1];
      const boolPrefixed = !boolSpace && objPrev?.kind === 'word' && STRING_PREFIX.test(objPrev.text);
      const strPrefix = boolPrefixed ? objPrev.upper : '';
      let intFrom = intPos;
      if (boolPrefixed) {
        arrTokens.pop();
        intFrom = intPos - strPrefix.length;
        boolSpace = objPrev.space;
        boolNewline = objPrev.newline;
      }
      let intEnd: number;
      if (boolOracle && strPrefix.endsWith('Q') && strNext) {
        const intClose = strSql.indexOf((Q_QUOTE_CLOSE[strNext] ?? strNext) + "'", intPos + 2);
        intEnd = intClose < 0 ? strSql.length : intClose + 2;
      } else intEnd = skipQuoted(strSql, intPos, "'", !boolOracle && strPrefix === 'E');
      push('string', intEnd, intFrom);
    } else if (strChar === '"') {
      push('quoted', skipQuoted(strSql, intPos, '"', false));
    } else if (!boolOracle && strChar === '$' && match(DOLLAR_TAG)) {
      const strTag = match(DOLLAR_TAG)!;
      const intClose = strSql.indexOf(strTag, intPos + strTag.length);
      push('string', intClose < 0 ? strSql.length : intClose + strTag.length);
    } else if (match(WORD)) {
      push('word', intPos + match(WORD)!.length);
    } else if (match(NUMBER)) {
      push('number', intPos + match(NUMBER)!.length);
    } else if (strChar === ':' && (strNext === ':' || strNext === '=')) {
      push(strNext === ':' ? 'punct' : 'op', intPos + 2);
    } else if (match(BIND)) {
      push('bind', intPos + match(BIND)!.length);
    } else if ('(),.;[]'.includes(strChar)) {
      push('punct', intPos + 1);
    } else if (match(OPERATOR)) {
      let strOp = match(OPERATOR)!;
      // A comment may start inside the run.
      const intComment = Math.min(...['--', '/*'].map(strMark => strOp.indexOf(strMark, 1)).filter(intAt => intAt > 0), strOp.length);
      strOp = strOp.slice(0, intComment);
      // As PostgreSQL lexes it: `=-1` is `=` then `-`.
      while (strOp.length > 1 && /[-+]$/.test(strOp) && !/[~!@#%^&|?]/.test(strOp)) strOp = strOp.slice(0, -1);
      push('op', intPos + strOp.length);
    } else {
      push('other', intPos + 1);
    }
  }
  return arrTokens;
}

const KEYWORDS = new Set(`SELECT FROM WHERE AND OR NOT IN EXISTS BETWEEN LIKE ILIKE IS NULL JOIN INNER LEFT RIGHT FULL OUTER CROSS
  NATURAL ON USING GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET FETCH DISTINCT AS CASE WHEN THEN ELSE END UNION ALL INTERSECT
  EXCEPT MINUS WITH RECURSIVE INSERT INTO VALUES UPDATE SET DELETE RETURNING MERGE MATCHED OVER PARTITION NULLS CONNECT START
  PRIOR NOCYCLE SIBLINGS FOR ANY SOME TRUE FALSE DEFAULT CONFLICT DO NOTHING ESCAPE LATERAL WINDOW`.split(/\s+/));

// Longest first: `ORDER SIBLINGS BY` must win over a shorter phrase.
const CLAUSES = [
  'ORDER SIBLINGS BY', 'WHEN NOT MATCHED', 'DO UPDATE SET', 'WHEN MATCHED', 'INSERT INTO', 'DELETE FROM', 'MERGE INTO', 'UPDATE SET',
  'GROUP BY', 'ORDER BY', 'UNION ALL', 'CONNECT BY', 'START WITH', 'FOR UPDATE', 'ON CONFLICT',
  'SELECT', 'FROM', 'WHERE', 'HAVING', 'LIMIT', 'OFFSET', 'FETCH', 'UNION', 'INTERSECT', 'EXCEPT', 'MINUS',
  'INSERT', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'RETURNING', 'WITH', 'USING', 'WINDOW',
].map(strPhrase => strPhrase.split(' '));
const JOIN_LEAD = new Set(['NATURAL', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER']);
const FORMATTED = new Set(['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'MERGE']);
const INDENT = '  ';

interface Frame {
  kind: 'query' | 'paren' | 'case';
  /** Indent of clause keywords (query), or of the line the frame opened on. */
  base: number;
  close: number;
  clause: string | null;
  between: boolean;
  /** The SELECT list goes under the keyword: break before its first item. */
  selectBreak: boolean;
}

function layout(arrTokens: Token[]): string {
  let strOut = '';
  let boolLineStart = true;
  let intLineIndent = 0;
  let boolMustBreak = false; // a line comment was just written
  let objPrev: (Token & { keyword: boolean; unary: boolean }) | null = null;
  const arrFrames: Frame[] = [{ kind: 'query', base: 0, close: 0, clause: null, between: false, selectBreak: false }];
  const top = () => arrFrames[arrFrames.length - 1];
  const continuation = () => (top().kind === 'query' ? top().base + 1 : intLineIndent);

  const newline = (intIndent: number) => {
    if (!boolLineStart) strOut = strOut.trimEnd() + '\n';
    boolLineStart = true;
    intLineIndent = intIndent;
  };

  const isKeyword = (objToken: Token, intIndex: number) =>
    objToken.kind === 'word' && KEYWORDS.has(objToken.upper)
    && arrTokens[intIndex - 1]?.text !== '.' && arrTokens[intIndex + 1]?.text !== '.';

  const needSpace = (objToken: Token) => {
    if (!objPrev) return false;
    const strText = objToken.text;
    const strBefore = objPrev.text;
    if (objPrev.kind === 'line' || objPrev.kind === 'block' || objToken.kind === 'line' || objToken.kind === 'block') return true;
    if (objToken.kind === 'punct' && ',;)]'.includes(strText)) return false;
    if (strText === '.' || strBefore === '.' || strText === '::' || strBefore === '::') return false;
    if (objPrev.kind === 'punct' && (strBefore === '(' || strBefore === '[')) return false;
    if (strText === '(') {
      if (objPrev.kind === 'word') return objPrev.keyword && strBefore.toUpperCase() !== 'LEFT' && strBefore.toUpperCase() !== 'RIGHT' ? true : objToken.space;
      return objPrev.kind === 'quoted' || strBefore === ')' || strBefore === ']' ? objToken.space : true;
    }
    if (strText === '[') return objToken.space;
    if (objPrev.unary) return false;
    if (objToken.kind === 'op' || objPrev.kind === 'op') return true;
    if (objToken.kind === 'bind' || objToken.kind === 'other' || objPrev.kind === 'other') return objToken.space;
    return true;
  };

  const write = (objToken: Token, intIndex: number, strText = objToken.text) => {
    if (boolMustBreak && !boolLineStart) newline(continuation());
    boolMustBreak = false;
    if (boolLineStart) strOut += INDENT.repeat(intLineIndent);
    else if (needSpace(objToken)) strOut += ' ';
    strOut += strText;
    boolLineStart = false;
    const boolKeyword = isKeyword(objToken, intIndex);
    const boolUnary = objToken.kind === 'op' && (strText === '-' || strText === '+')
      && (!objPrev || objPrev.kind === 'op' || objPrev.keyword || (objPrev.kind === 'punct' && '(,['.includes(objPrev.text)));
    objPrev = { ...objToken, keyword: boolKeyword, unary: boolUnary };
  };

  const writeWord = (objToken: Token, intIndex: number) =>
    write(objToken, intIndex, isKeyword(objToken, intIndex) ? objToken.upper : objToken.text);

  /** Words of the phrase starting at intIndex, or 0. */
  const phraseAt = (intIndex: number, arrWords: string[]) =>
    arrWords.every((strWord, intOffset) => arrTokens[intIndex + intOffset]?.upper === strWord) ? arrWords.length : 0;

  const joinAt = (intIndex: number) => {
    let intCount = 0;
    while (JOIN_LEAD.has(arrTokens[intIndex + intCount]?.upper ?? '')) intCount++;
    return arrTokens[intIndex + intCount]?.upper === 'JOIN' ? intCount + 1 : 0;
  };

  const clauseAt = (intIndex: number): string[] | undefined => {
    const objFrame = top();
    const arrClause = CLAUSES.find(arrWords => phraseAt(intIndex, arrWords));
    if (!arrClause) return undefined;
    const strClause = arrClause.join(' ');
    const strBefore = arrTokens[intIndex - 1]?.upper;
    if (strClause === 'WITH' && objFrame.clause !== null) return undefined;
    if (strClause === 'USING' && objFrame.clause !== 'MERGE INTO' && objFrame.clause !== 'DELETE FROM') return undefined;
    if (strClause === 'SET' && objFrame.clause !== 'UPDATE') return undefined;
    if (strClause === 'FROM' && strBefore === 'DISTINCT' && objFrame.clause !== 'SELECT') return undefined; // IS DISTINCT FROM
    return arrClause;
  };

  /** True when the SELECT list starting at intIndex has more than one item. */
  const hasListComma = (intIndex: number) => {
    let intDepth = 0;
    for (let intAt = intIndex; intAt < arrTokens.length; intAt++) {
      const objToken = arrTokens[intAt];
      if (objToken.text === '(' || objToken.text === '[') intDepth++;
      else if (objToken.text === ')' || objToken.text === ']') { if (--intDepth < 0) return false; }
      else if (intDepth === 0 && objToken.text === ',' && objToken.kind === 'punct') return true;
      else if (intDepth === 0 && (objToken.upper === 'FROM' || objToken.upper === 'UNION' || objToken.upper === 'INTO')) return false;
    }
    return false;
  };

  const nextCode = (intIndex: number) => {
    let intAt = intIndex + 1;
    while (arrTokens[intAt]?.kind === 'line' || arrTokens[intAt]?.kind === 'block') intAt++;
    return arrTokens[intAt];
  };

  for (let intIndex = 0; intIndex < arrTokens.length; intIndex++) {
    const objToken = arrTokens[intIndex];
    const objFrame = top();

    if (objToken.kind === 'line' || objToken.kind === 'block') {
      // A comment that had its own line keeps one.
      if (objToken.newline && !boolLineStart) newline(continuation());
      write(objToken, intIndex);
      if (objToken.kind === 'line' || arrTokens[intIndex + 1]?.newline) boolMustBreak = true;
      continue;
    }

    if (objFrame.kind === 'query' && objFrame.selectBreak && !['DISTINCT', 'ALL', 'UNIQUE'].includes(objToken.upper)) {
      objFrame.selectBreak = false;
      newline(objFrame.base + 1);
    }

    if (objToken.kind === 'word') {
      if (objFrame.kind === 'query') {
        const arrClause = clauseAt(intIndex);
        const intJoin = arrClause ? 0 : joinAt(intIndex);
        const intWords = arrClause?.length ?? intJoin;
        if (intWords) {
          newline(objFrame.base);
          for (let intOffset = 0; intOffset < intWords; intOffset++)
            write(arrTokens[intIndex + intOffset], intIndex + intOffset, arrTokens[intIndex + intOffset].upper);
          intIndex += intWords - 1;
          if (arrClause) {
            objFrame.clause = arrClause.join(' ');
            objFrame.between = false;
            objFrame.selectBreak = objFrame.clause === 'SELECT' && hasListComma(intIndex + 1);
          }
          continue;
        }
        if (objToken.upper === 'AND' || objToken.upper === 'OR') {
          if (objToken.upper === 'AND' && objFrame.between) objFrame.between = false;
          else newline(objFrame.base + 1);
        }
      }
      if (objToken.upper === 'BETWEEN') objFrame.between = true;

      if (objFrame.kind === 'case' && isKeyword(objToken, intIndex)) {
        if (objToken.upper === 'WHEN' || objToken.upper === 'ELSE') newline(objFrame.close + 1);
        else if (objToken.upper === 'END') {
          newline(objFrame.close);
          arrFrames.pop();
        }
      }
      const boolCase = objToken.upper === 'CASE' && isKeyword(objToken, intIndex);
      writeWord(objToken, intIndex);
      if (boolCase) arrFrames.push({ kind: 'case', base: intLineIndent, close: intLineIndent, clause: null, between: false, selectBreak: false });
      continue;
    }

    if (objToken.kind === 'punct' && objToken.text === '(') {
      const strInner = nextCode(intIndex)?.upper;
      write(objToken, intIndex);
      arrFrames.push({
        kind: strInner === 'SELECT' || strInner === 'WITH' ? 'query' : 'paren',
        base: intLineIndent + 1, close: intLineIndent, clause: null, between: false, selectBreak: false,
      });
      continue;
    }
    if (objToken.kind === 'punct' && objToken.text === ')' && arrFrames.length > 1 && objFrame.kind !== 'case') {
      if (objFrame.kind === 'query') newline(objFrame.close);
      arrFrames.pop();
      write(objToken, intIndex);
      continue;
    }

    write(objToken, intIndex);
    if (objToken.kind === 'punct' && objToken.text === ',' && objFrame.kind === 'query')
      newline(objFrame.clause === 'WITH' ? objFrame.base : objFrame.base + 1);
  }
  return strOut.trimEnd();
}

/** Same tokens, ignoring whitespace and the case of bare words. */
function sameTokens(arrBefore: Token[], arrAfter: Token[]) {
  return arrBefore.length === arrAfter.length && arrBefore.every((objToken, intIndex) => {
    const objOther = arrAfter[intIndex];
    return objToken.kind === objOther.kind && (objToken.kind === 'word' ? objToken.upper === objOther.upper : objToken.text === objOther.text);
  });
}

/** UPDATE / DELETE with no WHERE anywhere in it: it touches every row of the table. */
export function isUnfilteredWrite(strSql: string, strDialect: SqlDialect): boolean {
  const arrWords = tokenize(strSql, strDialect).filter(objToken => objToken.kind === 'word').map(objToken => objToken.upper);
  return (arrWords[0] === 'UPDATE' || arrWords[0] === 'DELETE') && !arrWords.includes('WHERE');
}

const PROCEDURAL_START = new Set(['BEGIN', 'DECLARE', 'DO']);
const PROCEDURAL_OBJECT = new Set(['PROCEDURE', 'FUNCTION', 'PACKAGE', 'TRIGGER', 'TYPE']);

/** Code with inner `;` that must stay as typed. */
function isProcedural(arrTokens: Token[]) {
  const arrCode = arrTokens.filter(objToken => objToken.kind !== 'line' && objToken.kind !== 'block');
  if (PROCEDURAL_START.has(arrCode[0]?.upper ?? '')) return true;
  if (arrCode[0]?.upper !== 'CREATE') return false;
  // CREATE [OR REPLACE] [EDITIONABLE] PROCEDURE ...: the object word comes before any name.
  for (const objToken of arrCode.slice(1, 6)) {
    if (PROCEDURAL_OBJECT.has(objToken.upper)) return true;
    if (objToken.kind !== 'word') break;
  }
  return false;
}

/** One statement (no terminator). Returns it unchanged when it is procedural or no layout can be trusted. */
export function formatStatement(strSql: string, strDialect: SqlDialect): string {
  const arrTokens = tokenize(strSql, strDialect);
  if (arrTokens.length === 0 || isProcedural(arrTokens)) return strSql;
  const isSafe = (strFormatted: string) => sameTokens(arrTokens, tokenize(strFormatted, strDialect));

  try {
    const strFormatted = formatDialect(strSql, {
      dialect: strDialect === 'oracle' ? plsql : postgresql,
      keywordCase: 'upper',
      tabWidth: 2,
    });
    if (isSafe(strFormatted)) return strFormatted;
  } catch {
    // The library could not parse it: try the built-in layout.
  }

  if (!FORMATTED.has(arrTokens[0].upper)) return strSql;
  const strFormatted = layout(arrTokens);
  return isSafe(strFormatted) ? strFormatted : strSql;
}

/** Formats every statement of the text; terminators, comments and blank lines between statements stay as typed. */
export function formatSql(strSql: string, strDialect: SqlDialect): string {
  let strOut = '';
  let intFrom = 0;
  for (const objStatement of splitStatements(strSql, strDialect)) {
    strOut += strSql.slice(intFrom, objStatement.start) + formatStatement(objStatement.text, strDialect);
    intFrom = objStatement.end;
  }
  return strOut + strSql.slice(intFrom);
}
