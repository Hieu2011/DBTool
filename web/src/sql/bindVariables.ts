/**
 * Variables of an editor statement that need a value before it can run: `:name` (bind) and, on Oracle,
 * `&name` (SQL*Plus substitution). They are replaced in the text: the server never sees a parameter.
 * Imports nothing, so node can run it.
 */
export interface SqlVariable { name: string; raw: boolean; start: number; end: number }

// Oracle blocks keep their `:name`: the server binds those as cursors that come back as result sets.
const ORACLE_BLOCK = /^\s*(?:begin|declare|call|exec(?:ute)?)\b/i;
const DOLLAR_TAG = /\$(?:[A-Za-z_]\w*)?\$/y;
const NAME = /[A-Za-z_][\w$#]*/y;

export function findVariables(strSql: string, boolOracle: boolean): SqlVariable[] {
  const arrFound: SqlVariable[] = [];
  const boolKeepBinds = boolOracle && ORACLE_BLOCK.test(strSql);
  const nameAt = (intAt: number) => { NAME.lastIndex = intAt; return NAME.exec(strSql)?.[0]; };
  let intPos = 0;
  while (intPos < strSql.length) {
    const strChar = strSql[intPos];
    const strNext = strSql[intPos + 1];
    if (strChar === '-' && strNext === '-') { const intEol = strSql.indexOf('\n', intPos); intPos = intEol < 0 ? strSql.length : intEol; continue; }
    if (strChar === '/' && strNext === '*') { const intClose = strSql.indexOf('*/', intPos + 2); intPos = intClose < 0 ? strSql.length : intClose + 2; continue; }
    if (strChar === "'" || strChar === '"') {
      intPos++;
      while (intPos < strSql.length && !(strSql[intPos] === strChar && strSql[intPos + 1] !== strChar)) intPos += strSql[intPos] === strChar ? 2 : 1;
      intPos++;
      continue;
    }
    if (!boolOracle && strChar === '$') {
      DOLLAR_TAG.lastIndex = intPos;
      const strTag = DOLLAR_TAG.exec(strSql)?.[0];
      if (strTag) { const intClose = strSql.indexOf(strTag, intPos + strTag.length); intPos = intClose < 0 ? strSql.length : intClose + strTag.length; continue; }
    }
    // :name, but not ::cast, := and not a[1:n]
    if (strChar === ':' && !boolKeepBinds && strSql[intPos - 1] !== ':' && !/[\w\])]/.test(strSql[intPos - 1] ?? ' ')) {
      const strName = nameAt(intPos + 1);
      if (strName && !/^(new|old)$/i.test(strName)) {
        arrFound.push({ name: strName, raw: false, start: intPos, end: intPos + 1 + strName.length });
        intPos += 1 + strName.length;
        continue;
      }
    }
    if (boolOracle && strChar === '&') {
      const intName = strNext === '&' ? intPos + 2 : intPos + 1;
      const strName = nameAt(intName);
      if (strName) {
        // SQL*Plus: a dot ends the name and is swallowed (&schema..table)
        const intEnd = intName + strName.length + (strSql[intName + strName.length] === '.' ? 1 : 0);
        arrFound.push({ name: strName, raw: true, start: intPos, end: intEnd });
        intPos = intEnd;
        continue;
      }
    }
    intPos++;
  }
  return arrFound;
}

/** What the user typed, as SQL: a number as it is, NULL, `=expression` verbatim, a date (Oracle: TO_DATE), else a quoted text. */
export function valueSql(strText: string, boolOracle: boolean) {
  const strValue = strText.trim();
  if (strValue === '' || /^null$/i.test(strValue)) return 'NULL';
  if (strValue.startsWith('=')) return strValue.slice(1).trim();
  if (/^-?\d+(\.\d+)?$/.test(strValue)) return strValue;
  const arrDate = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?$/.exec(strValue);
  if (arrDate && boolOracle) return `TO_DATE('${arrDate[1]} ${arrDate[2] ?? '00:00:00'}', 'YYYY-MM-DD HH24:MI:SS')`;
  return `'${strText.replace(/'/g, "''")}'`;
}

/** The statement with every variable replaced. dicValues: by upper-case name, the text typed for it. */
export function substituteVariables(strSql: string, arrVariables: SqlVariable[], dicValues: Map<string, string>, boolOracle: boolean) {
  let strResult = strSql;
  for (const objVariable of [...arrVariables].sort((objA, objB) => objB.start - objA.start)) {
    const strTyped = dicValues.get(objVariable.name.toUpperCase()) ?? '';
    strResult = strResult.slice(0, objVariable.start) + (objVariable.raw ? strTyped : valueSql(strTyped, boolOracle)) + strResult.slice(objVariable.end);
  }
  return strResult;
}
