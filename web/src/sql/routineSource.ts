/**
 * Reads a procedure's / function's code: its parameters (with defaults) and its body.
 * Text only, no parser: used to prefill the Execute form and to build a copy of the body
 * with sample values in place of the parameters. Imports nothing, so node can run it.
 */
export interface SourceParameter {
  name: string;
  mode: 'IN' | 'OUT' | 'INOUT';
  /** Type as written (may be TABLE.COLUMN%TYPE). */
  type: string;
  /** Default expression as written. */
  defaultSql?: string;
}

export interface RoutineSource { parameters: SourceParameter[]; declarations: string; body: string }

interface Token { kind: 'word' | 'string' | 'comment' | 'number' | 'symbol'; text: string; start: number; end: number }

const WORD = /[A-Za-z_\u0080-￿][\w$#\u0080-￿]*/y;
const NUMBER = /\d[\w.]*/y;
const DOLLAR_TAG = /\$(?:[A-Za-z_][\w]*)?\$/y;

function tokenize(strSql: string, boolPg: boolean): Token[] {
  const arrTokens: Token[] = [];
  const add = (strKind: Token['kind'], intStart: number, intEnd: number) => {
    arrTokens.push({ kind: strKind, text: strSql.slice(intStart, intEnd), start: intStart, end: intEnd });
    return intEnd;
  };
  const quoted = (intOpen: number, strQuote: string) => {
    let intPos = intOpen + 1;
    while (intPos < strSql.length) {
      if (strSql[intPos] !== strQuote) intPos++;
      else if (strSql[intPos + 1] === strQuote) intPos += 2;
      else return intPos + 1;
    }
    return strSql.length;
  };

  let intPos = 0;
  while (intPos < strSql.length) {
    const strChar = strSql[intPos];
    const strNext = strSql[intPos + 1];
    if (/\s/.test(strChar)) { intPos++; continue; }
    if (strChar === '-' && strNext === '-') {
      const intEol = strSql.indexOf('\n', intPos);
      intPos = add('comment', intPos, intEol < 0 ? strSql.length : intEol);
      continue;
    }
    if (strChar === '/' && strNext === '*') {
      const intClose = strSql.indexOf('*/', intPos + 2);
      intPos = add('comment', intPos, intClose < 0 ? strSql.length : intClose + 2);
      continue;
    }
    if (strChar === "'") { intPos = add('string', intPos, quoted(intPos, "'")); continue; }
    if (strChar === '"') { intPos = add('word', intPos, quoted(intPos, '"')); continue; }
    if (boolPg && strChar === '$') {
      DOLLAR_TAG.lastIndex = intPos;
      const arrTag = DOLLAR_TAG.exec(strSql);
      if (arrTag) {
        const intClose = strSql.indexOf(arrTag[0], intPos + arrTag[0].length);
        intPos = add('string', intPos, intClose < 0 ? strSql.length : intClose + arrTag[0].length);
        continue;
      }
    }
    WORD.lastIndex = intPos;
    const arrWord = WORD.exec(strSql);
    if (arrWord) { intPos = add('word', intPos, intPos + arrWord[0].length); continue; }
    NUMBER.lastIndex = intPos;
    const arrNumber = NUMBER.exec(strSql);
    if (arrNumber) { intPos = add('number', intPos, intPos + arrNumber[0].length); continue; }
    intPos = add('symbol', intPos, intPos + (strChar === ':' && strNext === '=' ? 2 : 1));
  }
  return arrTokens;
}

const isWord = (objToken: Token | undefined, ...arrWords: string[]) =>
  objToken?.kind === 'word' && arrWords.includes(objToken.text.toUpperCase());
const isSymbol = (objToken: Token | undefined, strText: string) => objToken?.kind === 'symbol' && objToken.text === strText;
const bare = (strName: string) => strName.replace(/^"|"$/g, '');

/** DECLARE ... BEGIN body END of a block: the first BEGIN and the last END. */
function splitBlock(strCode: string, boolPg: boolean): { declarations: string; body: string } | null {
  const arrTokens = tokenize(strCode, boolPg).filter(objToken => objToken.kind !== 'comment');
  const objBegin = arrTokens.find(objToken => isWord(objToken, 'BEGIN'));
  const objEnd = [...arrTokens].reverse().find(objToken => isWord(objToken, 'END'));
  if (!objBegin || !objEnd || objEnd.start <= objBegin.end) return null;
  return {
    declarations: strCode.slice(0, objBegin.start).replace(/^\s*declare\b/i, ''),
    body: strCode.slice(objBegin.end, objEnd.start),
  };
}

export function parseRoutine(strDdl: string, boolPg: boolean): RoutineSource | null {
  const arrTokens = tokenize(strDdl, boolPg).filter(objToken => objToken.kind !== 'comment');
  let intAt = arrTokens.findIndex(objToken => isWord(objToken, 'PROCEDURE', 'FUNCTION'));
  if (intAt < 0) return null;
  intAt++; // the name, maybe schema.name
  while (isSymbol(arrTokens[intAt + 1], '.')) intAt += 2;
  intAt++;

  const arrParameters: SourceParameter[] = [];
  if (isSymbol(arrTokens[intAt], '(')) {
    let intDepth = 0;
    let arrPart: Token[] = [];
    const flush = () => {
      const objParameter = readParameter(strDdl, arrPart, boolPg);
      if (objParameter) arrParameters.push(objParameter);
      arrPart = [];
    };
    for (; intAt < arrTokens.length; intAt++) {
      const objToken = arrTokens[intAt];
      if (isSymbol(objToken, '(') && intDepth++ === 0) continue;
      if (isSymbol(objToken, ')') && --intDepth === 0) { flush(); intAt++; break; }
      if (isSymbol(objToken, ',') && intDepth === 1) flush();
      else arrPart.push(objToken);
    }
  }

  if (boolPg) {
    // The code is the dollar-quoted string after the header.
    const objCode = arrTokens.slice(intAt).find(objToken => objToken.kind === 'string' && objToken.text.startsWith('$'));
    if (!objCode) return null;
    const strInner = objCode.text.replace(/^\$\w*\$/, '').replace(/\$\w*\$$/, '');
    return { parameters: arrParameters, ...(splitBlock(strInner, true) ?? { declarations: '', body: strInner }) };
  }

  const objIs = arrTokens.slice(intAt).find(objToken => isWord(objToken, 'IS', 'AS'));
  if (!objIs) return null;
  const objBlock = splitBlock(strDdl.slice(objIs.end), false);
  return objBlock ? { parameters: arrParameters, ...objBlock } : null;
}

/** Oracle: name [IN] [OUT] [NOCOPY] type [:= | DEFAULT expr]. PostgreSQL: [mode] name type [DEFAULT | = expr]. */
function readParameter(strDdl: string, arrPart: Token[], boolPg: boolean): SourceParameter | null {
  let intAt = 0;
  let strMode: SourceParameter['mode'] = 'IN';
  const readMode = () => {
    if (isWord(arrPart[intAt], 'IN')) {
      intAt++;
      if (isWord(arrPart[intAt], 'OUT')) { intAt++; strMode = 'INOUT'; }
    } else if (isWord(arrPart[intAt], 'OUT')) { intAt++; strMode = 'OUT'; }
    else if (isWord(arrPart[intAt], 'INOUT')) { intAt++; strMode = 'INOUT'; }
    else if (boolPg && isWord(arrPart[intAt], 'VARIADIC')) intAt++;
  };
  if (boolPg) readMode();
  const objName = arrPart[intAt++];
  if (objName?.kind !== 'word') return null;
  readMode();
  if (isWord(arrPart[intAt], 'NOCOPY')) intAt++;

  const intTypeStart = intAt;
  while (intAt < arrPart.length && !isSymbol(arrPart[intAt], ':=') && !isWord(arrPart[intAt], 'DEFAULT') && !(boolPg && isSymbol(arrPart[intAt], '='))) intAt++;
  if (intAt === intTypeStart) return null; // PostgreSQL: a parameter without a name
  const strType = strDdl.slice(arrPart[intTypeStart].start, arrPart[intAt - 1].end);
  const strDefault = intAt + 1 < arrPart.length ? strDdl.slice(arrPart[intAt + 1].start, arrPart[arrPart.length - 1].end).trim() : undefined;
  return { name: bare(objName.text), mode: strMode, type: strType, defaultSql: strDefault || undefined };
}

/** A default that is a plain value, as the Execute form wants it typed (no quotes). Expressions give undefined. */
export function defaultInput(strDefaultSql: string | undefined): string | undefined {
  if (!strDefaultSql) return undefined;
  // PostgreSQL prints 'x'::character varying
  const strSql = strDefaultSql.replace(/^('(?:[^']|'')*'|[+-]?[\d.]+)\s*::[\w\s"()[\].,]+$/, '$1').trim();
  if (/^[+-]?\d+(\.\d+)?$/.test(strSql) || /^(true|false)$/i.test(strSql)) return strSql;
  const arrText = /^'((?:[^']|'')*)'$/.exec(strSql);
  return arrText ? arrText[1].replace(/''/g, "'") : undefined;
}

function sampleSql(objParameter: SourceParameter, strCatalogType: string | undefined, boolPg: boolean): string {
  const strType = (strCatalogType || objParameter.type).toLowerCase();
  const boolDate = /date|time/.test(strType);
  // A date: today as a literal (also for a default of "now"), so the value is visible and easy to change.
  const boolNow = /^(sysdate|systimestamp|current_date|current_timestamp|localtimestamp|now\(\))$/i.test(objParameter.defaultSql ?? '');
  if (objParameter.defaultSql && !/^null(\s*::.*)?$/i.test(objParameter.defaultSql) && !(boolDate && boolNow)) return objParameter.defaultSql;
  if (/bool/.test(strType)) return 'true';
  if (boolDate) {
    const dtNow = new Date();
    const strToday = `${dtNow.getFullYear()}-${String(dtNow.getMonth() + 1).padStart(2, '0')}-${String(dtNow.getDate()).padStart(2, '0')}`;
    return boolPg ? `'${strToday}'::${strType === 'date' ? 'date' : 'timestamp'}` : `TO_DATE('${strToday}', 'YYYY-MM-DD')`;
  }
  if (/num|int|dec|float|double|real|serial|money/.test(strType)) return '1';
  return "'text'";
}

function dedent(strText: string) {
  const arrLines = strText.replace(/^\s*\n/, '').trimEnd().split('\n');
  const intIndent = Math.min(...arrLines.filter(strLine => strLine.trim()).map(strLine => strLine.length - strLine.trimStart().length));
  return arrLines.map(strLine => strLine.slice(Number.isFinite(intIndent) ? intIndent : 0)).join('\n');
}

/**
 * The body with every input parameter replaced by a sample value and `OPEN cursor FOR` / `RETURN QUERY`
 * dropped, so its queries run on their own. Null when the code could not be read.
 * dicTypes: real parameter types by lower-case name (the catalog knows what %TYPE stands for).
 */
export function debugScript(strDdl: string, boolPg: boolean, strTitle: string, dicTypes: Record<string, string> = {}): string | null {
  const objSource = parseRoutine(strDdl, boolPg);
  if (!objSource || !objSource.body.trim()) return null;

  const dicValues = new Map<string, string>();
  for (const objParameter of objSource.parameters) {
    const strCatalogType = dicTypes[objParameter.name.toLowerCase()];
    if (objParameter.mode === 'OUT' || /cursor/i.test(strCatalogType || objParameter.type)) continue;
    dicValues.set(objParameter.name.toLowerCase(), sampleSql(objParameter, strCatalogType, boolPg));
  }

  const strBody = objSource.body;
  const arrTokens = tokenize(strBody, boolPg).filter(objToken => objToken.kind !== 'comment');
  const arrEdits: { start: number; end: number; text: string }[] = [];
  const startsQuery = (objToken: Token | undefined) => isWord(objToken, 'SELECT', 'WITH') || isSymbol(objToken, '(');
  for (const [intIndex, objToken] of arrTokens.entries()) {
    if (objToken.kind !== 'word') continue;
    const objPrev = arrTokens[intIndex - 1];
    const objNext = arrTokens[intIndex + 1];
    // OPEN v_out FOR SELECT ... -> SELECT ...
    if (isWord(objToken, 'OPEN') && objNext?.kind === 'word' && isWord(arrTokens[intIndex + 2], 'FOR') && startsQuery(arrTokens[intIndex + 3])) {
      arrEdits.push({ start: objToken.start, end: arrTokens[intIndex + 2].end, text: '' });
      continue;
    }
    if (boolPg && isWord(objToken, 'RETURN') && isWord(objNext, 'QUERY') && startsQuery(arrTokens[intIndex + 2])) {
      arrEdits.push({ start: objToken.start, end: objNext!.end, text: '' });
      continue;
    }
    const strValue = objToken.text.startsWith('"') ? undefined : dicValues.get(objToken.text.toLowerCase());
    if (strValue === undefined) continue;
    // Not a column (t.v_id), a bind, an assignment target or a named argument (v_id => ...).
    if (isSymbol(objPrev, '.') || isSymbol(objPrev, ':') || isSymbol(objNext, '.') || isSymbol(objNext, ':=')) continue;
    if (isSymbol(objNext, '=') && isSymbol(arrTokens[intIndex + 2], '>')) continue;
    // The parameter's name stays next to its value.
    arrEdits.push({ start: objToken.start, end: objToken.end, text: `${strValue} /* ${objToken.text} */` });
  }
  let strResult = strBody;
  for (const objEdit of arrEdits.reverse()) strResult = strResult.slice(0, objEdit.start) + objEdit.text + strResult.slice(objEdit.end).replace(objEdit.text ? /^/ : /^\s+/, '');

  const arrHead = [`-- Debug copy of ${strTitle}: parameters are replaced by sample values. Running it does not change the routine.`];
  for (const [strName, strValue] of dicValues) arrHead.push(`--   ${strName} = ${strValue}`);
  const strDeclarations = objSource.declarations.trim();
  if (strDeclarations) arrHead.push('-- Declarations of the routine (not run):', ...dedent(strDeclarations).split('\n').map(strLine => `--   ${strLine}`));
  return `${arrHead.join('\n')}\n\n${dedent(strResult)}\n`;
}
