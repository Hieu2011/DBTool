/**
 * Splits editor text into statements so Ctrl+Enter can run the one under the cursor.
 * Skips strings, quoted identifiers, comments, PostgreSQL dollar quotes and Oracle q-quotes.
 * Oracle PL/SQL blocks (BEGIN / DECLARE / CREATE PROCEDURE...) end at a line holding only `/`.
 */
/** mongo: shell / JavaScript statements split at a `;` outside every bracket (// comments, backslash escapes, `template` strings).
 * redis: one command per line. */
export type SqlDialect = 'pgsql' | 'oracle' | 'mongo' | 'redis';

export interface SqlStatement {
  /** Statement without its terminator. */
  text: string;
  /** Offset of the first code character. */
  start: number;
  /** Offset just past the text. */
  end: number;
  /** Offset just past the terminator. */
  stop: number;
}

// Same set as OracleProvider.PlSqlStart: these keep their inner `;`.
const PLSQL_START = /(?:begin|declare|create\s+(?:or\s+replace\s+)?(?:(?:non)?editionable\s+)?(?:procedure|function|package|trigger|type))\b/iy;
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/y;
const Q_QUOTE_CLOSE: Record<string, string> = { '[': ']', '{': '}', '<': '>', '(': ')' };

const isWordChar = (strChar: string | undefined) => !!strChar && /[\w$#]/.test(strChar);

/** Returns the offset just past the closing quote. */
export function skipQuoted(strSql: string, intOpen: number, strQuote: string, boolBackslash: boolean) {
  let intPos = intOpen + 1;
  while (intPos < strSql.length) {
    const strChar = strSql[intPos];
    if (boolBackslash && strChar === '\\') intPos += 2;
    else if (strChar !== strQuote) intPos++;
    else if (strSql[intPos + 1] === strQuote) intPos += 2; // doubled quote
    else return intPos + 1;
  }
  return strSql.length;
}

export function skipBlockComment(strSql: string, intOpen: number, boolNested: boolean) {
  let intDepth = 1;
  let intPos = intOpen + 2;
  while (intPos < strSql.length) {
    if (strSql[intPos] === '*' && strSql[intPos + 1] === '/') {
      intPos += 2;
      if (--intDepth === 0) return intPos;
    } else if (boolNested && strSql[intPos] === '/' && strSql[intPos + 1] === '*') {
      intDepth++;
      intPos += 2;
    } else intPos++;
  }
  return strSql.length;
}

/** True when the `/` at intPos is alone on its line (SQL*Plus terminator). */
function isSlashLine(strSql: string, intPos: number) {
  for (let intLeft = intPos - 1; intLeft >= 0 && strSql[intLeft] !== '\n'; intLeft--)
    if (!/\s/.test(strSql[intLeft])) return false;
  for (let intRight = intPos + 1; intRight < strSql.length && strSql[intRight] !== '\n'; intRight++)
    if (!/\s/.test(strSql[intRight])) return false;
  return true;
}

export function splitStatements(strSql: string, strDialect: SqlDialect): SqlStatement[] {
  const arrStatements: SqlStatement[] = [];
  if (strDialect === 'redis') {
    // One command per line; `;` is data. Lines starting with # are comments.
    let intLineStart = 0;
    for (const strLine of strSql.split('\n')) {
      const strText = strLine.trim();
      if (strText && !strText.startsWith('#')) {
        const intStart = intLineStart + (strLine.length - strLine.trimStart().length);
        arrStatements.push({ text: strText, start: intStart, end: intStart + strText.length, stop: intLineStart + strLine.length });
      }
      intLineStart += strLine.length + 1;
    }
    return arrStatements;
  }
  const boolOracle = strDialect === 'oracle';
  const boolMongo = strDialect === 'mongo';
  let intStart = -1; // first code character of the current statement
  let boolBlock = false;
  let intDepth = 0; // mongo: open ( [ { — a `;` inside a block or a for(;;) belongs to the statement
  let intPos = 0;

  const push = (intEnd: number, intStop: number) => {
    if (intStart >= 0) {
      const strText = strSql.slice(intStart, intEnd).trimEnd();
      if (strText) arrStatements.push({ text: strText, start: intStart, end: intStart + strText.length, stop: intStop });
    }
    intStart = -1;
    boolBlock = false;
    intDepth = 0;
  };

  while (intPos < strSql.length) {
    const strChar = strSql[intPos];
    const strNext = strSql[intPos + 1];

    if (boolMongo ? strChar === '/' && strNext === '/' : strChar === '-' && strNext === '-') {
      const intEol = strSql.indexOf('\n', intPos);
      intPos = intEol < 0 ? strSql.length : intEol;
      continue;
    }
    if (strChar === '/' && strNext === '*') {
      intPos = skipBlockComment(strSql, intPos, !boolOracle && !boolMongo);
      continue;
    }
    if (boolOracle && strChar === '/' && isSlashLine(strSql, intPos)) {
      push(intPos, intPos + 1);
      intPos++;
      continue;
    }
    if (/\s/.test(strChar)) {
      intPos++;
      continue;
    }
    if (strChar === ';' && !boolBlock && intDepth === 0) {
      push(intPos, intPos + 1);
      intPos++;
      continue;
    }

    if (intStart < 0) {
      intStart = intPos;
      if (boolOracle) {
        PLSQL_START.lastIndex = intPos;
        boolBlock = PLSQL_START.test(strSql);
      }
    }

    if (strChar === "'") {
      const strPrev = strSql[intPos - 1]?.toLowerCase();
      const strPrev2 = strSql[intPos - 2]?.toLowerCase();
      // q'[...]' and nq'[...]'
      const boolQQuote = boolOracle && strPrev === 'q' && (!isWordChar(strPrev2) || (strPrev2 === 'n' && !isWordChar(strSql[intPos - 3])));
      if (boolQQuote && strNext) {
        const intClose = strSql.indexOf((Q_QUOTE_CLOSE[strNext] ?? strNext) + "'", intPos + 2);
        intPos = intClose < 0 ? strSql.length : intClose + 2;
      } else {
        const boolEscapeString = boolMongo || (!boolOracle && strPrev === 'e' && !isWordChar(strPrev2)); // E'it\'s'
        intPos = skipQuoted(strSql, intPos, "'", boolEscapeString);
      }
      continue;
    }
    if (strChar === '"') {
      intPos = skipQuoted(strSql, intPos, '"', boolMongo);
      continue;
    }
    if (boolMongo) {
      if (strChar === '`') {
        intPos = skipQuoted(strSql, intPos, '`', true);
        continue;
      }
      if (strChar === '(' || strChar === '[' || strChar === '{') intDepth++;
      else if ((strChar === ')' || strChar === ']' || strChar === '}') && intDepth > 0) intDepth--;
    }
    if (!boolOracle && !boolMongo && strChar === '$' && !isWordChar(strSql[intPos - 1])) {
      DOLLAR_TAG.lastIndex = intPos;
      const arrTag = DOLLAR_TAG.exec(strSql);
      if (arrTag) {
        const intClose = strSql.indexOf(arrTag[0], intPos + arrTag[0].length);
        intPos = intClose < 0 ? strSql.length : intClose + arrTag[0].length;
        continue;
      }
    }
    intPos++;
  }
  push(strSql.length, strSql.length);
  return arrStatements;
}

/**
 * Statement under the cursor. Between two statements: the one before when the cursor
 * is still on its last line, otherwise the one after.
 */
export function statementAt(arrStatements: SqlStatement[], strSql: string, intOffset: number): SqlStatement | undefined {
  let objPrevious: SqlStatement | undefined;
  for (const objStatement of arrStatements) {
    if (intOffset <= objStatement.stop && intOffset >= objStatement.start) return objStatement;
    if (intOffset < objStatement.start) {
      const boolSameLine = objPrevious && !strSql.slice(objPrevious.stop, intOffset).includes('\n');
      return boolSameLine ? objPrevious : objStatement;
    }
    objPrevious = objStatement;
  }
  return objPrevious;
}
