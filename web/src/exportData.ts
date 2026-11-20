import type { ResultColumn } from './types';

/** Grid rows as CSV or a real .xlsx workbook, written here so no library is needed. */

const NUMERIC = /^(int|integer|bigint|smallint|numeric|decimal|number|float|double|real|money|binary_(float|double))/i;
const CELL_MAX = 32767; // Excel's limit for the text of one cell

const text = (objValue: unknown): string => {
  if (objValue === null || objValue === undefined) return '';
  if (typeof objValue === 'object') return JSON.stringify(objValue);
  return String(objValue);
};

/** UTF-8 with a BOM and CRLF: what Excel needs to read Vietnamese text and multi-line cells. NULL is an empty cell. */
export function toCsv(arrColumns: ResultColumn[], arrRows: unknown[][]): Blob {
  const cell = (objValue: unknown) => {
    const strValue = text(objValue);
    return /[",\r\n]/.test(strValue) ? `"${strValue.replace(/"/g, '""')}"` : strValue;
  };
  const arrLines = [arrColumns.map(objColumn => cell(objColumn.name)).join(',')];
  for (const arrRow of arrRows) arrLines.push(arrRow.map(cell).join(','));
  return new Blob(['﻿', arrLines.join('\r\n'), '\r\n'], { type: 'text/csv;charset=utf-8' });
}

// ---------- xlsx ----------

const escapeXml = (strText: string) => strText
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '') // not allowed in XML at all
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A number Excel can hold exactly (15 digits); anything longer stays text so ids and big decimals are not rounded. */
const asNumber = (objValue: unknown): string | null => {
  if (typeof objValue === 'number') return Number.isFinite(objValue) ? String(objValue) : null;
  if (typeof objValue !== 'string' || !/^-?\d+(\.\d+)?$/.test(objValue)) return null;
  return objValue.replace(/[-.]/g, '').replace(/^0+/, '').length <= 15 ? objValue : null;
};

function sheetXml(arrColumns: ResultColumn[], arrRows: unknown[][]) {
  const arrNumeric = arrColumns.map(objColumn => NUMERIC.test(objColumn.dataType));
  const textCell = (strValue: string, strStyle = '') =>
    `<c t="inlineStr"${strStyle}><is><t xml:space="preserve">${escapeXml(strValue.slice(0, CELL_MAX))}</t></is></c>`;

  // Width from the header and the first 200 rows, in characters.
  const arrWidths = arrColumns.map((objColumn, intCol) => {
    let intChars = objColumn.name.length;
    for (let intRow = 0; intRow < Math.min(arrRows.length, 200); intRow++) intChars = Math.max(intChars, text(arrRows[intRow][intCol]).length);
    return Math.min(Math.max(intChars + 2, 8), 60);
  });

  const arrParts: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>',
    `<cols>${arrWidths.map((intWidth, intCol) => `<col min="${intCol + 1}" max="${intCol + 1}" width="${intWidth}" customWidth="1"/>`).join('')}</cols>`,
    '<sheetData>',
    `<row>${arrColumns.map(objColumn => textCell(objColumn.name, ' s="1"')).join('')}</row>`,
  ];
  for (const arrRow of arrRows) {
    let strRow = '<row>';
    for (let intCol = 0; intCol < arrRow.length; intCol++) {
      const objValue = arrRow[intCol];
      if (objValue === null || objValue === undefined) { strRow += '<c/>'; continue; }
      const strNumber = arrNumeric[intCol] ? asNumber(objValue) : null;
      strRow += strNumber !== null ? `<c><v>${strNumber}</v></c>` : textCell(text(objValue));
    }
    arrParts.push(`${strRow}</row>`);
  }
  arrParts.push('</sheetData></worksheet>');
  return arrParts.join('');
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const WORKBOOK_FILES: [string, string][] = [
  ['[Content_Types].xml', `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '</Types>'],
  ['_rels/.rels', `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>'],
  ['xl/workbook.xml', `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>'],
  ['xl/_rels/workbook.xml.rels', `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '</Relationships>'],
  // style 0 = default, style 1 = bold (header row)
  ['xl/styles.xml', `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
    + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
    + '</styleSheet>'],
];

let arrCrcTable: Uint32Array | null = null;
function crc32(arrBytes: Uint8Array) {
  if (!arrCrcTable) {
    arrCrcTable = new Uint32Array(256);
    for (let intIndex = 0; intIndex < 256; intIndex++) {
      let intValue = intIndex;
      for (let intBit = 0; intBit < 8; intBit++) intValue = intValue & 1 ? 0xEDB88320 ^ (intValue >>> 1) : intValue >>> 1;
      arrCrcTable[intIndex] = intValue >>> 0;
    }
  }
  let intCrc = 0xFFFFFFFF;
  for (let intIndex = 0; intIndex < arrBytes.length; intIndex++) intCrc = arrCrcTable[(intCrc ^ arrBytes[intIndex]) & 0xFF] ^ (intCrc >>> 8);
  return (intCrc ^ 0xFFFFFFFF) >>> 0;
}

/** Zip container with stored (uncompressed) entries: all an .xlsx needs to be valid. */
function zip(arrFiles: [string, string][]): Blob {
  const objEncoder = new TextEncoder();
  const arrChunks: Uint8Array[] = [];
  const arrCentral: Uint8Array[] = [];
  let intOffset = 0;

  for (const [strName, strContent] of arrFiles) {
    const arrName = objEncoder.encode(strName);
    const arrData = objEncoder.encode(strContent);
    const intCrc = crc32(arrData);

    const arrLocal = new Uint8Array(30 + arrName.length);
    const objLocal = new DataView(arrLocal.buffer);
    objLocal.setUint32(0, 0x04034B50, true);
    objLocal.setUint16(4, 20, true);        // version needed
    objLocal.setUint16(6, 0x0800, true);    // names are UTF-8
    objLocal.setUint16(8, 0, true);         // stored
    objLocal.setUint16(12, 0x21, true);     // 1980-01-01, the format's zero date
    objLocal.setUint32(14, intCrc, true);
    objLocal.setUint32(18, arrData.length, true);
    objLocal.setUint32(22, arrData.length, true);
    objLocal.setUint16(26, arrName.length, true);
    arrLocal.set(arrName, 30);

    const arrEntry = new Uint8Array(46 + arrName.length);
    const objEntry = new DataView(arrEntry.buffer);
    objEntry.setUint32(0, 0x02014B50, true);
    objEntry.setUint16(4, 20, true);
    objEntry.setUint16(6, 20, true);
    objEntry.setUint16(8, 0x0800, true);
    objEntry.setUint16(14, 0x21, true);
    objEntry.setUint32(16, intCrc, true);
    objEntry.setUint32(20, arrData.length, true);
    objEntry.setUint32(24, arrData.length, true);
    objEntry.setUint16(28, arrName.length, true);
    objEntry.setUint32(42, intOffset, true);
    arrEntry.set(arrName, 46);

    arrChunks.push(arrLocal, arrData);
    arrCentral.push(arrEntry);
    intOffset += arrLocal.length + arrData.length;
  }

  const intCentralSize = arrCentral.reduce((intSum, arrEntry) => intSum + arrEntry.length, 0);
  const arrEnd = new Uint8Array(22);
  const objEnd = new DataView(arrEnd.buffer);
  objEnd.setUint32(0, 0x06054B50, true);
  objEnd.setUint16(8, arrFiles.length, true);
  objEnd.setUint16(10, arrFiles.length, true);
  objEnd.setUint32(12, intCentralSize, true);
  objEnd.setUint32(16, intOffset, true);

  return new Blob([...arrChunks, ...arrCentral, arrEnd] as BlobPart[],
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/** One sheet "Data": bold frozen header, numbers as numbers, everything else as text. */
export const toXlsx = (arrColumns: ResultColumn[], arrRows: unknown[][]): Blob =>
  zip([...WORKBOOK_FILES, ['xl/worksheets/sheet1.xml', sheetXml(arrColumns, arrRows)]]);

/** Name safe on Windows, with a time stamp so repeated exports don't overwrite each other. */
export function exportFileName(strBase: string, strExtension: string) {
  const dtNow = new Date();
  const pad = (intValue: number) => String(intValue).padStart(2, '0');
  const strStamp = `${dtNow.getFullYear()}${pad(dtNow.getMonth() + 1)}${pad(dtNow.getDate())}-${pad(dtNow.getHours())}${pad(dtNow.getMinutes())}${pad(dtNow.getSeconds())}`;
  return `${strBase.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'result'}-${strStamp}.${strExtension}`;
}
