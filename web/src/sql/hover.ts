/**
 * Hover and signature help of the SQL editors.
 *  - Hover: a table (its columns), a column (type and table), an alias, a routine, a built-in function.
 *  - Signature help: after `name(` — routines of the loaded schemas (PostgreSQL: from the metadata;
 *    Oracle: parameters fetched once per routine) and the built-in functions listed below.
 * Reads names from the text with the same rules as the completion's regex fallback: no parser involved.
 */
import type * as Monaco from 'monaco-editor';
import type { DbObjectInfo, RoutineInfo, SchemaMetadata, TableMeta } from '../types';
import { findTable, metadataOf, tablesInQuery, unquote } from './completion';
import { derivedTables, maskSql } from './derived';
import { splitStatements } from './statements';

type RoutineLoader = (objRoutine: DbObjectInfo) => Promise<RoutineInfo>;

/** Monaco model uri -> how to fetch a routine's parameters on that editor's connection. */
const dicLoaders = new Map<string, RoutineLoader>();
/** Parameters already fetched, by loader and routine (an editor's loader lives as long as its model). */
const dicParameters = new WeakMap<RoutineLoader, Map<string, Promise<string[] | null>>>();

export function routinesFor(objModel: Monaco.editor.ITextModel, fnLoad: RoutineLoader) {
  dicLoaders.set(objModel.uri.toString(), fnLoad);
  return () => dicLoaders.delete(objModel.uri.toString());
}

const MAX_HOVER_COLUMNS = 40;
const ROUTINE_TYPES = ['FUNCTION', 'PROCEDURE'];

// name(parameters) | what it returns. Shared by both dialects unless listed in ORACLE_ONLY / PG_ONLY.
const COMMON: [string, string][] = [
  ['COUNT(expression)', 'Number of rows where the expression is not null; COUNT(*) counts every row.'],
  ['SUM(expression)', 'Total of the non-null values.'],
  ['AVG(expression)', 'Average of the non-null values.'],
  ['MIN(expression)', 'Smallest value.'],
  ['MAX(expression)', 'Largest value.'],
  ['COALESCE(value1, value2, ...)', 'The first argument that is not null.'],
  ['NULLIF(value1, value2)', 'Null when both are equal, otherwise value1.'],
  ['CAST(expression AS type)', 'Converts the expression to the type.'],
  ['UPPER(text)', 'Text in upper case.'],
  ['LOWER(text)', 'Text in lower case.'],
  ['INITCAP(text)', 'First letter of each word in upper case.'],
  ['LENGTH(text)', 'Number of characters.'],
  ['TRIM(text)', 'Text without leading and trailing spaces. Also TRIM(LEADING | TRAILING | BOTH chars FROM text).'],
  ['LTRIM(text, characters)', 'Removes the characters (default: spaces) from the start.'],
  ['RTRIM(text, characters)', 'Removes the characters (default: spaces) from the end.'],
  ['LPAD(text, length, fill)', 'Pads on the left up to the length (fill defaults to a space).'],
  ['RPAD(text, length, fill)', 'Pads on the right up to the length (fill defaults to a space).'],
  ['SUBSTR(text, start, length)', 'Part of the text from position start (1-based); length is optional.'],
  ['REPLACE(text, search, replacement)', 'Every occurrence of search replaced.'],
  ['CONCAT(value1, value2)', 'The values joined into one text.'],
  ['ROUND(number, decimals)', 'Rounded to the given decimals (default 0).'],
  ['TRUNC(value, precision)', 'Number cut to the given decimals; on Oracle also a date cut to a unit (\'DD\', \'MM\', \'YYYY\').'],
  ['CEIL(number)', 'Smallest whole number not below the argument.'],
  ['FLOOR(number)', 'Largest whole number not above the argument.'],
  ['ABS(number)', 'Absolute value.'],
  ['MOD(dividend, divisor)', 'Remainder of the division.'],
  ['POWER(base, exponent)', 'base raised to exponent.'],
  ['GREATEST(value1, value2, ...)', 'Largest of the arguments.'],
  ['LEAST(value1, value2, ...)', 'Smallest of the arguments.'],
  ['TO_CHAR(value, format)', 'Date or number as text, e.g. TO_CHAR(d, \'YYYY-MM-DD HH24:MI:SS\').'],
  ['TO_DATE(text, format)', 'Text as a date, e.g. TO_DATE(\'2026-01-31\', \'YYYY-MM-DD\').'],
  ['TO_NUMBER(text, format)', 'Text as a number.'],
  ['TO_TIMESTAMP(text, format)', 'Text as a timestamp.'],
  ['EXTRACT(field FROM source)', 'One field of a date / timestamp: YEAR, MONTH, DAY, HOUR, MINUTE, SECOND.'],
  ['ROW_NUMBER()', 'Window function: 1, 2, 3… within the partition. Needs OVER (PARTITION BY … ORDER BY …).'],
  ['RANK()', 'Window function: rank with gaps. Needs OVER (… ORDER BY …).'],
  ['DENSE_RANK()', 'Window function: rank without gaps. Needs OVER (… ORDER BY …).'],
  ['LAG(expression, offset, default)', 'Window function: the value offset rows before the current one.'],
  ['LEAD(expression, offset, default)', 'Window function: the value offset rows after the current one.'],
  ['FIRST_VALUE(expression)', 'Window function: the first value of the window frame.'],
  ['LAST_VALUE(expression)', 'Window function: the last value of the window frame.'],
];
const ORACLE_ONLY: [string, string][] = [
  ['NVL(value, replacement)', 'replacement when value is null, otherwise value.'],
  ['NVL2(value, if_not_null, if_null)', 'if_not_null when value is not null, otherwise if_null.'],
  ['DECODE(expression, search1, result1, ..., default)', 'The result of the first search equal to the expression, else default.'],
  ['INSTR(text, search, start, occurrence)', 'Position of search in text (1-based), 0 when absent.'],
  ['ADD_MONTHS(date, months)', 'The date plus a number of months.'],
  ['MONTHS_BETWEEN(date1, date2)', 'Months from date2 to date1.'],
  ['LAST_DAY(date)', 'Last day of the date\'s month.'],
  ['NEXT_DAY(date, weekday)', 'First date after the given one that falls on the weekday.'],
  ['LISTAGG(expression, delimiter)', 'Values joined into one text. Needs WITHIN GROUP (ORDER BY …).'],
  ['REGEXP_LIKE(text, pattern, flags)', 'True when the text matches the regular expression.'],
  ['REGEXP_SUBSTR(text, pattern, start, occurrence, flags)', 'The part of the text matching the regular expression.'],
  ['REGEXP_REPLACE(text, pattern, replacement, start, occurrence, flags)', 'Matches of the regular expression replaced.'],
  ['TO_CLOB(value)', 'The value as a CLOB.'],
  ['SYS_CONTEXT(namespace, parameter)', 'A value of the session context, e.g. SYS_CONTEXT(\'USERENV\', \'CURRENT_SCHEMA\').'],
];
const PG_ONLY: [string, string][] = [
  ['NOW()', 'Start time of the current transaction (timestamp with time zone).'],
  ['DATE_TRUNC(unit, source)', 'Timestamp cut to the unit: \'day\', \'month\', \'year\', \'hour\'…'],
  ['DATE_PART(field, source)', 'One field of a date / timestamp as a number.'],
  ['AGE(timestamp1, timestamp2)', 'Interval between the two (timestamp2 defaults to today).'],
  ['STRING_AGG(expression, delimiter)', 'Values joined into one text; ORDER BY may follow inside the call.'],
  ['ARRAY_AGG(expression)', 'Values collected into an array.'],
  ['JSONB_BUILD_OBJECT(key1, value1, ...)', 'A jsonb object from keys and values.'],
  ['JSONB_AGG(expression)', 'Values collected into a jsonb array.'],
  ['GENERATE_SERIES(start, stop, step)', 'One row per value from start to stop.'],
  ['POSITION(search IN text)', 'Position of search in text (1-based), 0 when absent.'],
  ['STRPOS(text, search)', 'Position of search in text (1-based), 0 when absent.'],
  ['SPLIT_PART(text, delimiter, n)', 'The n-th part of the text split at the delimiter.'],
  ['LEFT(text, n)', 'The first n characters.'],
  ['RIGHT(text, n)', 'The last n characters.'],
  ['REGEXP_REPLACE(text, pattern, replacement, flags)', 'Matches of the regular expression replaced.'],
  ['REGEXP_MATCHES(text, pattern, flags)', 'Captured groups of the matches, as text arrays.'],
  ['TO_JSONB(value)', 'The value as jsonb.'],
  ['UNNEST(array)', 'One row per element of the array.'],
];

interface Signature { label: string; parameters: string[]; doc: string }

/** "NAME(a, b AS c)" -> parameter texts as they appear in the label. */
function parametersOf(strLabel: string): string[] {
  const intOpen = strLabel.indexOf('(');
  const intClose = strLabel.lastIndexOf(')');
  if (intOpen < 0 || intClose <= intOpen) return [];
  const arrParts: string[] = [];
  let intDepth = 0;
  let intStart = intOpen + 1;
  for (let intPos = intOpen + 1; intPos <= intClose; intPos++) {
    const strChar = strLabel[intPos];
    if (strChar === '(') intDepth++;
    else if (strChar === ')' && intPos < intClose) intDepth--;
    else if ((strChar === ',' && intDepth === 0) || intPos === intClose) {
      const strPart = strLabel.slice(intStart, intPos).trim();
      if (strPart) arrParts.push(strPart);
      intStart = intPos + 1;
    }
  }
  return arrParts;
}

const toSignatures = (arrItems: [string, string][]) => {
  const dicSignatures = new Map<string, Signature>();
  for (const [strLabel, strDoc] of arrItems)
    dicSignatures.set(strLabel.slice(0, strLabel.indexOf('(')).toLowerCase(), { label: strLabel, parameters: parametersOf(strLabel), doc: strDoc });
  return dicSignatures;
};
const BUILTINS = { pgsql: toSignatures([...COMMON, ...PG_ONLY]), oracle: toSignatures([...COMMON, ...ORACLE_ONLY]) };

const dialectOf = (objModel: Monaco.editor.ITextModel) => (objModel.getLanguageId() === 'pgsql' ? 'pgsql' : 'oracle');

/** Text of the statement holding the offset (the whole editor when none does). */
function statementText(objModel: Monaco.editor.ITextModel, intOffset: number) {
  const strSql = objModel.getValue();
  const objStatement = splitStatements(strSql, dialectOf(objModel)).find(objItem => objItem.start <= intOffset && intOffset <= objItem.stop);
  return objStatement ? { sql: strSql.slice(objStatement.start, objStatement.stop), start: objStatement.start } : { sql: strSql, start: 0 };
}

function routinesNamed(objMeta: SchemaMetadata | undefined, strName: string, strSchema?: string) {
  return (objMeta?.objects ?? []).filter(objItem => ROUTINE_TYPES.includes(objItem.type)
    && objItem.name.toLowerCase() === strName && (!strSchema || objItem.schema.toLowerCase() === strSchema));
}

/** Parameters of a routine as "name MODE type" texts. PostgreSQL carries them in the metadata; Oracle fetches them once. */
async function routineSignature(objModel: Monaco.editor.ITextModel, objRoutine: DbObjectInfo): Promise<Signature> {
  const strTitle = `${objRoutine.schema}.${objRoutine.name}`;
  const strDoc = objRoutine.type.toLowerCase();
  if (objRoutine.signature != null) {
    const strLabel = `${strTitle}(${objRoutine.signature})`;
    return { label: strLabel, parameters: parametersOf(strLabel), doc: strDoc };
  }
  const fnLoad = dicLoaders.get(objModel.uri.toString());
  let arrParameters: string[] | null = null;
  if (fnLoad) {
    let dicCache = dicParameters.get(fnLoad);
    if (!dicCache) dicParameters.set(fnLoad, dicCache = new Map());
    let objPending = dicCache.get(strTitle);
    if (!objPending) {
      objPending = fnLoad(objRoutine).then(
        objInfo => objInfo.parameters.filter(objParameter => objParameter.mode !== 'RETURN')
          .map(objParameter => `${objParameter.name} ${objParameter.mode} ${objParameter.dataType}`.toLowerCase()),
        () => null);
      dicCache.set(strTitle, objPending);
    }
    arrParameters = await objPending;
  }
  return arrParameters
    ? { label: `${strTitle}(${arrParameters.join(', ')})`, parameters: arrParameters, doc: strDoc }
    : { label: `${strTitle}(…)`, parameters: [], doc: strDoc };
}

function tableMarkdown(objTable: TableMeta) {
  const arrLines = objTable.columns.slice(0, MAX_HOVER_COLUMNS).map(objColumn => `${objColumn.name}  ${objColumn.dataType}`);
  if (objTable.columns.length > MAX_HOVER_COLUMNS) arrLines.push(`… ${objTable.columns.length - MAX_HOVER_COLUMNS} more`);
  return [`**${objTable.schema}.${objTable.name}** — ${objTable.type.toLowerCase()}, ${objTable.columns.length} columns`,
    '```text\n' + arrLines.join('\n') + '\n```'];
}

/** The call the cursor is inside: its name (lower case, maybe schema-qualified) and the argument index. */
function callAt(strSql: string, intOffset: number) {
  const strMasked = maskSql(strSql.slice(0, intOffset));
  const arrStack: { name: string | null; commas: number }[] = [];
  for (let intPos = 0; intPos < strMasked.length; intPos++) {
    const strChar = strMasked[intPos];
    if (strChar === '(') {
      const arrName = /((?:"[^"]+"|[\w$#]+)(?:\s*\.\s*(?:"[^"]+"|[\w$#]+))?)\s*$/.exec(strMasked.slice(Math.max(0, intPos - 200), intPos));
      arrStack.push({ name: arrName ? arrName[1].replace(/\s+/g, '') : null, commas: 0 });
    } else if (strChar === ')') arrStack.pop();
    else if (strChar === ',' && arrStack.length > 0) arrStack[arrStack.length - 1].commas++;
  }
  const objTop = arrStack.at(-1);
  return objTop?.name ? { name: objTop.name, argument: objTop.commas } : null;
}

let boolRegistered = false;

export function registerSqlHover(objMonaco: typeof Monaco) {
  if (boolRegistered) return;
  boolRegistered = true;

  const objHover: Monaco.languages.HoverProvider = {
    async provideHover(objModel, objPosition) {
      const objWord = objModel.getWordAtPosition(objPosition);
      if (!objWord) return null;
      const objMeta = metadataOf(objModel);
      const strWord = objWord.word.toLowerCase();
      const strLine = objModel.getLineContent(objPosition.lineNumber);
      const strQualifier = /("[^"]+"|[\w$#]+)\s*\.\s*"?$/.exec(strLine.slice(0, objWord.startColumn - 1))?.[1];
      const boolCall = /^"?\s*\(/.test(strLine.slice(objWord.endColumn - 1));
      const objRange = new objMonaco.Range(objPosition.lineNumber, objWord.startColumn, objPosition.lineNumber, objWord.endColumn);
      const answer = (arrLines: string[]) => ({ range: objRange, contents: arrLines.map(strValue => ({ value: strValue })) });

      const objScope = statementText(objModel, objModel.getOffsetAt(objPosition));
      const dicTables = objMeta ? tablesInQuery(objMeta, objScope.sql) : new Map<string, TableMeta>();
      const arrDerived = derivedTables(objScope.sql);
      const columnOf = (objTable: TableMeta) => objTable.columns.find(objColumn => objColumn.name.toLowerCase() === strWord);

      if (strQualifier && objMeta) {
        const strOwner = unquote(strQualifier);
        // alias.column / table.column
        const objOwner = dicTables.get(strOwner) ?? findTable(objMeta, strOwner);
        const objColumn = objOwner && columnOf(objOwner);
        if (objOwner && objColumn) return answer([`**${objColumn.name}**  \`${objColumn.dataType}\``, `column of ${objOwner.schema}.${objOwner.name}`]);
        const objDerived = arrDerived.find(objItem => unquote(objItem.name) === strOwner);
        if (objDerived?.columns.some(strColumn => unquote(strColumn) === strWord)) return answer([`**${objWord.word}**`, `column of subquery ${objDerived.name}`]);
        // schema.table / schema.routine
        const objTable = findTable(objMeta, `${strOwner}.${strWord}`);
        if (objTable) return answer(tableMarkdown(objTable));
        const arrRoutines = routinesNamed(objMeta, strWord, strOwner);
        if (arrRoutines.length > 0) {
          const arrSignatures = await Promise.all(arrRoutines.slice(0, 5).map(objRoutine => routineSignature(objModel, objRoutine)));
          return answer(arrSignatures.map(objSignature => `\`${objSignature.label}\` — ${objSignature.doc}`));
        }
        return null;
      }

      if (objMeta && !boolCall) {
        // An alias written in this statement (the table's own name is handled just below).
        const objAliased = dicTables.get(strWord);
        if (objAliased && objAliased.name.toLowerCase() !== strWord) return answer([`alias of **${objAliased.schema}.${objAliased.name}**`, ...tableMarkdown(objAliased).slice(1)]);
        const objDerived = arrDerived.find(objItem => unquote(objItem.name) === strWord);
        if (objDerived) return answer([`**${objDerived.name}** — subquery`, '```text\n' + (objDerived.columns.join('\n') || '(columns unknown)') + '\n```']);
        const objTable = dicTables.get(strWord) ?? findTable(objMeta, strWord);
        if (objTable) return answer(tableMarkdown(objTable));
        // A column of the tables this statement uses.
        const arrOwners = [...new Set(dicTables.values())].filter(columnOf);
        if (arrOwners.length > 0) {
          return answer(arrOwners.slice(0, 6).map(objOwner => `**${columnOf(objOwner)!.name}**  \`${columnOf(objOwner)!.dataType}\` — ${objOwner.schema}.${objOwner.name}`));
        }
      }

      const arrRoutines = routinesNamed(objMeta, strWord);
      if (arrRoutines.length > 0) {
        const arrSignatures = await Promise.all(arrRoutines.slice(0, 5).map(objRoutine => routineSignature(objModel, objRoutine)));
        return answer(arrSignatures.map(objSignature => `\`${objSignature.label}\` — ${objSignature.doc}`));
      }
      const objBuiltin = BUILTINS[dialectOf(objModel)].get(strWord);
      // Only where it is called: MIN, LEFT, REPLACE… are also plain words.
      if (objBuiltin && (boolCall || objBuiltin.parameters.length === 0)) return answer([`\`${objBuiltin.label}\``, objBuiltin.doc]);
      return null;
    },
  };

  const objSignatureHelp: Monaco.languages.SignatureHelpProvider = {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [')'],
    async provideSignatureHelp(objModel, objPosition) {
      const intOffset = objModel.getOffsetAt(objPosition);
      const objScope = statementText(objModel, intOffset);
      const objCall = callAt(objScope.sql, intOffset - objScope.start);
      if (!objCall) return null;

      const arrName = objCall.name.split('.').map(unquote);
      const [strSchema, strName] = arrName.length === 2 ? arrName : [undefined, arrName[0]];
      const arrRoutines = routinesNamed(metadataOf(objModel), strName, strSchema).slice(0, 8);
      const arrSignatures = await Promise.all(arrRoutines.map(objRoutine => routineSignature(objModel, objRoutine)));
      const objBuiltin = strSchema ? undefined : BUILTINS[dialectOf(objModel)].get(strName);
      if (objBuiltin) arrSignatures.push(objBuiltin);
      if (arrSignatures.length === 0) return null;

      // The first overload that has room for the argument being typed.
      const intActive = Math.max(0, arrSignatures.findIndex(objSignature =>
        objSignature.parameters.length > objCall.argument || objSignature.parameters.at(-1) === '...'));
      return {
        value: {
          signatures: arrSignatures.map(objSignature => ({
            label: objSignature.label,
            documentation: objSignature.doc,
            parameters: objSignature.parameters.map(strParameter => ({ label: strParameter })),
          })),
          activeSignature: intActive,
          // Past the last parameter of a variadic one: keep "..." highlighted.
          activeParameter: Math.min(objCall.argument, Math.max(arrSignatures[intActive].parameters.length - 1, 0)),
        },
        dispose: () => {},
      };
    },
  };

  for (const strLanguage of ['pgsql', 'sql']) {
    objMonaco.languages.registerHoverProvider(strLanguage, objHover);
    objMonaco.languages.registerSignatureHelpProvider(strLanguage, objSignatureHelp);
  }
}
