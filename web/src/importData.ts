import type { DbKind } from './types';
import { quoteIdent } from './sql/identifiers';

/** Reads CSV / .xlsx files into rows of text and turns them into INSERT statements. No library: the browser unzips. */

/** null = empty cell. The first row is whatever the file has first (usually the header). */
export interface ImportedSheet { rows: (string | null)[][] }

// ---------- CSV ----------

/** Quoted fields, doubled quotes, line breaks inside quotes; the delimiter is the one the first line uses most. */
export function parseCsv(strText: string): ImportedSheet {
  const strSource = strText.charCodeAt(0) === 0xFEFF ? strText.slice(1) : strText;
  const strFirstLine = strSource.slice(0, strSource.search(/\r|\n|$/));
  const chrDelimiter = [',', ';', '\t'].map(chrItem => [chrItem, strFirstLine.split(chrItem).length] as const)
    .sort((arrA, arrB) => arrB[1] - arrA[1])[0][0];

  const arrRows: (string | null)[][] = [];
  let arrRow: (string | null)[] = [];
  let strField = '';
  let boolQuoted = false;   // inside "..."
  let boolWasQuoted = false; // "" is an empty string, an unquoted empty field is NULL
  const endField = () => { arrRow.push(strField === '' && !boolWasQuoted ? null : strField); strField = ''; boolWasQuoted = false; };
  const endRow = () => { endField(); if (arrRow.length > 1 || arrRow[0] !== null) arrRows.push(arrRow); arrRow = []; };

  for (let intIndex = 0; intIndex < strSource.length; intIndex++) {
    const chrItem = strSource[intIndex];
    if (boolQuoted) {
      if (chrItem !== '"') strField += chrItem;
      else if (strSource[intIndex + 1] === '"') { strField += '"'; intIndex++; }
      else boolQuoted = false;
    } else if (chrItem === '"' && strField === '') { boolQuoted = true; boolWasQuoted = true; }
    else if (chrItem === chrDelimiter) endField();
    else if (chrItem === '\n') endRow();
    else if (chrItem === '\r') { if (strSource[intIndex + 1] === '\n') intIndex++; endRow(); }
    else strField += chrItem;
  }
  if (strField !== '' || arrRow.length > 0 || boolWasQuoted) endRow();
  return { rows: arrRows };
}

// ---------- xlsx ----------

async function inflate(arrData: Uint8Array): Promise<Uint8Array> {
  const objStream = new Blob([arrData as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(objStream).arrayBuffer());
}

/** Text of the named parts of a zip file, read through its central directory. */
async function unzip(arrBytes: Uint8Array, fnWanted: (strName: string) => boolean): Promise<Map<string, string>> {
  const objView = new DataView(arrBytes.buffer, arrBytes.byteOffset, arrBytes.byteLength);
  let intEnd = arrBytes.length - 22;
  while (intEnd >= 0 && objView.getUint32(intEnd, true) !== 0x06054B50) intEnd--;
  if (intEnd < 0) throw new Error('This is not an .xlsx file (no zip directory).');

  const objDecoder = new TextDecoder();
  const dicFiles = new Map<string, string>();
  let intOffset = objView.getUint32(intEnd + 16, true);
  for (let intEntry = objView.getUint16(intEnd + 10, true); intEntry > 0; intEntry--) {
    if (objView.getUint32(intOffset, true) !== 0x02014B50) throw new Error('The .xlsx file is damaged.');
    const intMethod = objView.getUint16(intOffset + 10, true);
    const intCompressed = objView.getUint32(intOffset + 20, true);
    const intNameLength = objView.getUint16(intOffset + 28, true);
    const intLocal = objView.getUint32(intOffset + 42, true);
    const strName = objDecoder.decode(arrBytes.subarray(intOffset + 46, intOffset + 46 + intNameLength));
    intOffset += 46 + intNameLength + objView.getUint16(intOffset + 30, true) + objView.getUint16(intOffset + 32, true);
    if (!fnWanted(strName)) continue;

    const intDataStart = intLocal + 30 + objView.getUint16(intLocal + 26, true) + objView.getUint16(intLocal + 28, true);
    const arrData = arrBytes.subarray(intDataStart, intDataStart + intCompressed);
    if (intMethod !== 0 && intMethod !== 8) throw new Error('The .xlsx file uses a compression this tool cannot read.');
    dicFiles.set(strName, objDecoder.decode(intMethod === 8 ? await inflate(arrData) : arrData));
  }
  return dicFiles;
}

const pad = (intValue: number, intLength = 2) => String(intValue).padStart(intLength, '0');

/** Excel day number (1900 system) -> yyyy-MM-dd[ HH:mm:ss]. */
function serialToDate(decSerial: number) {
  const lngMillis = Math.round((decSerial - 25569) * 86400 * 1000); // 25569 = 1970-01-01
  const dtValue = new Date(lngMillis);
  const strDate = `${dtValue.getUTCFullYear()}-${pad(dtValue.getUTCMonth() + 1)}-${pad(dtValue.getUTCDate())}`;
  return lngMillis % 86400000 === 0
    ? strDate
    : `${strDate} ${pad(dtValue.getUTCHours())}:${pad(dtValue.getUTCMinutes())}:${pad(dtValue.getUTCSeconds())}`;
}

const columnIndex = (strRef: string) => {
  let intIndex = 0;
  for (const chrItem of strRef) {
    const intCode = chrItem.charCodeAt(0);
    if (intCode < 65 || intCode > 90) break; // letters, then the row number
    intIndex = intIndex * 26 + intCode - 64;
  }
  return intIndex - 1;
};

/** First sheet of the workbook. Dates come out as yyyy-MM-dd HH:mm:ss, everything else as Excel stores it. */
export async function parseXlsx(arrBytes: Uint8Array): Promise<ImportedSheet> {
  const dicFiles = await unzip(arrBytes, strName =>
    /^xl\/(workbook\.xml|sharedStrings\.xml|styles\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml)$/.test(strName));
  const parse = (strXml: string) => new DOMParser().parseFromString(strXml, 'application/xml');
  const textOf = (objNode: Element) => [...objNode.getElementsByTagName('t')].map(objText => objText.textContent ?? '').join('');

  // sheet 1 by workbook order, not by file name
  let strSheetPath = 'xl/worksheets/sheet1.xml';
  const strWorkbook = dicFiles.get('xl/workbook.xml');
  const strRels = dicFiles.get('xl/_rels/workbook.xml.rels');
  if (strWorkbook && strRels) {
    const strRelId = parse(strWorkbook).getElementsByTagName('sheet')[0]?.getAttribute('r:id');
    const objRel = [...parse(strRels).getElementsByTagName('Relationship')].find(objItem => objItem.getAttribute('Id') === strRelId);
    const strTarget = objRel?.getAttribute('Target');
    if (strTarget) strSheetPath = strTarget.startsWith('/') ? strTarget.slice(1) : `xl/${strTarget}`;
  }
  const strSheet = dicFiles.get(strSheetPath);
  if (!strSheet) throw new Error('The workbook has no readable sheet.');

  const arrShared = dicFiles.has('xl/sharedStrings.xml')
    ? [...parse(dicFiles.get('xl/sharedStrings.xml')!).getElementsByTagName('si')].map(textOf)
    : [];

  // Which cell styles are dates: built-in formats 14-22 / 45-47, or a custom format with date letters.
  const arrDateStyles: boolean[] = [];
  if (dicFiles.has('xl/styles.xml')) {
    const objStyles = parse(dicFiles.get('xl/styles.xml')!);
    const dicFormats = new Map([...objStyles.getElementsByTagName('numFmt')]
      .map(objFormat => [objFormat.getAttribute('numFmtId') ?? '', objFormat.getAttribute('formatCode') ?? ''] as const));
    const objCellXfs = objStyles.getElementsByTagName('cellXfs')[0];
    for (const objXf of objCellXfs ? [...objCellXfs.getElementsByTagName('xf')] : []) {
      const strId = objXf.getAttribute('numFmtId') ?? '0';
      const intId = Number(strId);
      const strCode = (dicFormats.get(strId) ?? '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''); // literals and colours are not date letters
      arrDateStyles.push((intId >= 14 && intId <= 22) || (intId >= 45 && intId <= 47) || /[dmyhs]/i.test(strCode));
    }
  }

  const arrRows: (string | null)[][] = [];
  for (const objRow of parse(strSheet).getElementsByTagName('row')) {
    const arrRow: (string | null)[] = [];
    let intNext = 0;
    for (const objCell of objRow.getElementsByTagName('c')) {
      const strRef = objCell.getAttribute('r');
      const intCol = strRef ? columnIndex(strRef) : intNext; // cells may be listed without a reference, in order
      intNext = intCol + 1;
      const strType = objCell.getAttribute('t');
      const strRaw = objCell.getElementsByTagName('v')[0]?.textContent ?? null;
      let strValue: string | null;
      if (strType === 'inlineStr') strValue = textOf(objCell);
      else if (strRaw === null) strValue = null;
      else if (strType === 's') strValue = arrShared[Number(strRaw)] ?? '';
      else if (strType === 'b') strValue = strRaw === '1' ? 'true' : 'false';
      else if (strType === 'str' || strType === 'e') strValue = strRaw;
      else if (arrDateStyles[Number(objCell.getAttribute('s') ?? '0')] && Number.isFinite(Number(strRaw))) strValue = serialToDate(Number(strRaw));
      else strValue = /e/i.test(strRaw) ? String(Number(strRaw)) : strRaw; // 1E+20 -> a plain number
      while (arrRow.length < intCol) arrRow.push(null);
      arrRow[intCol] = strValue === '' ? null : strValue;
    }
    if (arrRow.some(strCell => strCell !== null)) arrRows.push(arrRow);
  }
  return { rows: arrRows };
}

export async function parseImportFile(objFile: File): Promise<ImportedSheet> {
  if (/\.xlsx$/i.test(objFile.name)) return parseXlsx(new Uint8Array(await objFile.arrayBuffer()));
  if (/\.xls$/i.test(objFile.name)) throw new Error('Old .xls files are not supported: save the workbook as .xlsx or CSV first.');
  return parseCsv(await objFile.text());
}

// ---------- INSERT statements ----------

export interface TargetColumn { name: string; type: string }

const NUMERIC = /^(int|integer|bigint|smallint|numeric|decimal|number|float|double|real|money|binary_(float|double))/i;
const DATE_TEXT = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2})(\.\d{1,9})?)?$/;

/** One value as a SQL literal for a column of that type. Empty cells are NULL. */
export function sqlLiteral(strValue: string | null, strType: string, strKind: DbKind): string {
  if (strValue === null || strValue === '') return 'NULL';
  // An unquoted number never depends on the session's decimal separator.
  if (NUMERIC.test(strType) && /^-?\d+(\.\d+)?$/.test(strValue)) return strValue;

  // eslint-disable-next-line no-control-regex
  const strQuoted = `'${strValue.replace(/\u0000/g, '').replace(/'/g, "''")}'`;
  if (strKind !== 'Oracle') return strQuoted; // PostgreSQL casts the text to the column's type

  // A plain literal passes through the database character set and can lose letters an N column would keep.
  // eslint-disable-next-line no-control-regex
  if (/^n(var)?char|^nclob/i.test(strType) && /[^\x00-\x7f]/.test(strValue)) {
    const strEscaped = [...strValue.replace(/\u0000/g, '')].map(strChar => {
      const intCode = strChar.charCodeAt(0);
      if (strChar === "'") return "''";
      if (strChar !== '\\' && intCode < 0x80) return strChar;
      // UTF-16 units, so letters outside the BMP go as their surrogate pair.
      return [...Array(strChar.length).keys()].map(intAt => `\\${strChar.charCodeAt(intAt).toString(16).toUpperCase().padStart(4, '0')}`).join('');
    }).join('');
    return `UNISTR('${strEscaped}')`;
  }

  // Oracle would read a date through NLS_DATE_FORMAT: spell the format out instead.
  const arrDate = DATE_TEXT.exec(strValue);
  if (!arrDate || !/^(DATE|TIMESTAMP)/i.test(strType)) return strQuoted;
  const [, strDate, strTime, strFraction] = arrDate;
  if (/^DATE/i.test(strType)) return `TO_DATE('${strDate} ${strTime ?? '00:00:00'}', 'YYYY-MM-DD HH24:MI:SS')`;
  return strFraction
    ? `TO_TIMESTAMP('${strDate} ${strTime}${strFraction}', 'YYYY-MM-DD HH24:MI:SS.FF')`
    : `TO_TIMESTAMP('${strDate} ${strTime ?? '00:00:00'}', 'YYYY-MM-DD HH24:MI:SS')`;
}

/** Keeps the last row of each key (the file's later line wins). Rows with an empty key column are all kept. */
export function dedupeByKey(arrRows: (string | null)[][], arrKeyColumns: number[]) {
  const dicLast = new Map<string, number>();
  arrRows.forEach((arrRow, intRow) => {
    const arrKey = arrKeyColumns.map(intCol => arrRow[intCol] ?? null);
    if (arrKey.every(strPart => strPart !== null && strPart !== '')) dicLast.set(JSON.stringify(arrKey), intRow);
  });
  const arrKept = arrRows.filter((arrRow, intRow) => {
    const arrKey = arrKeyColumns.map(intCol => arrRow[intCol] ?? null);
    return arrKey.some(strPart => strPart === null || strPart === '') || dicLast.get(JSON.stringify(arrKey)) === intRow;
  });
  return { rows: arrKept, dropped: arrRows.length - arrKept.length };
}

/**
 * Statements that add each row or, when a row with the same key exists, update its other columns.
 * PostgreSQL: INSERT ... ON CONFLICT (needs a primary key / unique index on exactly the key columns).
 * Oracle 11g: one MERGE per row, grouped in PL/SQL blocks; a per-row MERGE has no UNION, so no literal typing trouble.
 * arrKeys are names from arrColumns. The rows must hold each key once (dedupeByKey).
 */
export function buildUpserts(strTable: string, strKind: DbKind, arrColumns: TargetColumn[], arrMapping: number[],
  arrRows: (string | null)[][], arrKeys: string[]): { sql: string; rows: number }[] {
  const boolOracle = strKind === 'Oracle';
  const name = (objColumn: TargetColumn) => quoteIdent(objColumn.name, strKind);
  const arrKeyIndexes = arrColumns.map((objColumn, intIndex) => (arrKeys.includes(objColumn.name) ? intIndex : -1)).filter(intIndex => intIndex >= 0);
  const arrOtherIndexes = arrColumns.map((_, intIndex) => intIndex).filter(intIndex => !arrKeyIndexes.includes(intIndex));
  const strColumns = arrColumns.map(name).join(', ');
  const literals = (arrRow: (string | null)[]) =>
    arrColumns.map((objColumn, intIndex) => sqlLiteral(arrRow[arrMapping[intIndex]] ?? null, objColumn.type, strKind));

  const arrStatements: { sql: string; rows: number }[] = [];
  const intBatch = boolOracle ? 25 : 200;
  for (let intStart = 0; intStart < arrRows.length; intStart += intBatch) {
    const arrChunk = arrRows.slice(intStart, intStart + intBatch);
    if (!boolOracle) {
      const strAction = arrOtherIndexes.length === 0
        ? 'DO NOTHING'
        : `DO UPDATE SET ${arrOtherIndexes.map(intIndex => `${name(arrColumns[intIndex])} = EXCLUDED.${name(arrColumns[intIndex])}`).join(', ')}`;
      arrStatements.push({
        sql: `INSERT INTO ${strTable} (${strColumns}) VALUES\n${arrChunk.map(arrRow => `  (${literals(arrRow).join(', ')})`).join(',\n')}\n`
          + `ON CONFLICT (${arrKeyIndexes.map(intIndex => name(arrColumns[intIndex])).join(', ')}) ${strAction}`,
        rows: arrChunk.length,
      });
      continue;
    }

    const arrMerges = arrChunk.map(arrRow => {
      const arrValues = literals(arrRow);
      // A key can't be updated by its own MERGE (ORA-38104): only the other columns are set.
      const strMatched = arrOtherIndexes.length === 0
        ? ''
        : ` WHEN MATCHED THEN UPDATE SET ${arrOtherIndexes.map(intIndex => `d.${name(arrColumns[intIndex])} = ${arrValues[intIndex]}`).join(', ')}`;
      return `  MERGE INTO ${strTable} d USING dual ON (${arrKeyIndexes.map(intIndex => `d.${name(arrColumns[intIndex])} = ${arrValues[intIndex]}`).join(' AND ')})`
        + `${strMatched} WHEN NOT MATCHED THEN INSERT (${strColumns}) VALUES (${arrValues.join(', ')});`;
    });
    arrStatements.push({ sql: `BEGIN\n${arrMerges.join('\n')}\nEND;`, rows: arrChunk.length });
  }
  return arrStatements;
}

/**
 * INSERT statements (no trailing ';') for the rows, several rows per statement.
 * arrMapping[i] is the index of the file column that feeds arrColumns[i]; arrColumns holds only mapped columns.
 */
export function buildInserts(strTable: string, strKind: DbKind, arrColumns: TargetColumn[], arrMapping: number[],
  arrRows: (string | null)[][]): { sql: string; rows: number }[] {
  const boolOracle = strKind === 'Oracle';
  const intBatch = boolOracle ? 50 : 200; // Oracle 11g has no multi-row VALUES: INSERT ALL gets slow to parse when long
  const strColumns = arrColumns.map(objColumn => quoteIdent(objColumn.name, strKind)).join(', ');
  const valuesOf = (arrRow: (string | null)[]) =>
    `(${arrColumns.map((objColumn, intIndex) => sqlLiteral(arrRow[arrMapping[intIndex]] ?? null, objColumn.type, strKind)).join(', ')})`;

  const arrStatements: { sql: string; rows: number }[] = [];
  for (let intStart = 0; intStart < arrRows.length; intStart += intBatch) {
    const arrChunk = arrRows.slice(intStart, intStart + intBatch);
    const strSql = boolOracle && arrChunk.length > 1
      ? `INSERT ALL\n${arrChunk.map(arrRow => `  INTO ${strTable} (${strColumns}) VALUES ${valuesOf(arrRow)}`).join('\n')}\nSELECT 1 FROM dual`
      : `INSERT INTO ${strTable} (${strColumns}) VALUES\n${arrChunk.map(arrRow => `  ${valuesOf(arrRow)}`).join(',\n')}`;
    arrStatements.push({ sql: strSql, rows: arrChunk.length });
  }
  return arrStatements;
}
