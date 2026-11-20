/** Import into a MongoDB collection: reads the file and writes insertMany() statements in shell syntax. */
import { parseImportFile } from './importData';
import { mongoCollection } from './sql/dialect';

/** rows: a CSV / Excel sheet, still to be mapped to fields. documents: a JSON file, one text per document. */
export interface DocumentFile { rows?: (string | null)[][]; documents?: string[] }

export const FIELD_TYPES = ['auto', 'string', 'number', 'boolean', 'date', 'objectId'] as const;
export type FieldType = typeof FIELD_TYPES[number];

const BATCH_DOCUMENTS = 500;
const BATCH_CHARS = 1_000_000;
const INT32_MAX = 2_147_483_647;
const NUMBER_TEXT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/;
const DATE_TEXT = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?)(\.\d{1,3})?\d*(Z|[-+]\d{2}:?\d{2})?)?$/;

/** A JSON array of documents, or one document per line (mongoexport). CSV / Excel go through the table importer's readers. */
export async function parseDocumentFile(objFile: File): Promise<DocumentFile> {
  if (!/\.(json|jsonl|ndjson)$/i.test(objFile.name)) return { rows: (await parseImportFile(objFile)).rows };

  const strText = (await objFile.text()).replace(/^﻿/, '').trim();
  const isDocument = (objValue: unknown) => typeof objValue === 'object' && objValue !== null && !Array.isArray(objValue);
  if (strText.startsWith('[')) {
    const arrItems: unknown = JSON.parse(strText);
    if (!Array.isArray(arrItems) || !arrItems.every(isDocument)) throw new Error('The JSON array must hold documents: [{ … }, { … }].');
    return { documents: arrItems.map(objItem => JSON.stringify(objItem)) };
  }
  // One document per line is kept as written: long integers keep every digit.
  const arrLines = strText.split('\n').map(strLine => strLine.trim()).filter(Boolean);
  try {
    arrLines.forEach((strLine, intLine) => {
      if (!isDocument(JSON.parse(strLine))) throw new Error(`Line ${intLine + 1} is not a document.`);
    });
    return { documents: arrLines };
  } catch (objLineError) {
    // A single document spread over several lines.
    let objWhole: unknown;
    try { objWhole = JSON.parse(strText); } catch { throw new Error(`Expected a JSON array of documents, or one document per line. ${(objLineError as Error).message}`); }
    if (!isDocument(objWhole)) throw new Error('The file must hold documents.');
    return { documents: [JSON.stringify(objWhole)] };
  }
}

/** A cell as a shell literal of that type; null when the text does not fit the type. */
export function shellValue(strCell: string, strType: FieldType): string | null {
  const strText = strCell.trim();
  switch (strType) {
    case 'string':
      return JSON.stringify(strCell);
    case 'number': {
      if (!NUMBER_TEXT.test(strText)) return null;
      // Whole numbers past int32 would lose digits as doubles.
      if (/^-?\d+$/.test(strText) && Math.abs(Number(strText)) > INT32_MAX) return strText.replace('-', '').length <= 18 ? `NumberLong("${strText}")` : null;
      return strText;
    }
    case 'boolean':
      return /^(true|1|yes|y)$/i.test(strText) ? 'true' : /^(false|0|no|n)$/i.test(strText) ? 'false' : null;
    case 'date': {
      const arrDate = DATE_TEXT.exec(strText);
      if (!arrDate) return null;
      const [, strDate, strTime, strFraction, strZone] = arrDate;
      const strClock = !strTime ? '00:00:00' : strTime.length === 5 ? `${strTime}:00` : strTime;
      return `ISODate("${strDate}T${strClock}${strFraction ?? ''}${strZone ?? 'Z'}")`;
    }
    case 'objectId':
      return /^[0-9a-f]{24}$/i.test(strText) ? `ObjectId("${strText.toLowerCase()}")` : null;
    default: {
      // auto: only texts that are unmistakably a number or a boolean; "007" and long digit strings stay text.
      if (NUMBER_TEXT.test(strText) && !/[eE]/.test(strText) && strText.replace(/[-.]/g, '').length <= 15) return shellValue(strText, 'number');
      if (strText === 'true' || strText === 'false') return strText;
      return JSON.stringify(strCell);
    }
  }
}

/** insertMany() statements of at most 500 documents (and about 1 MB) each. */
export function buildInsertMany(strDatabase: string, strCollection: string, arrDocuments: string[]) {
  const arrStatements: { text: string; rows: number }[] = [];
  const strTarget = mongoCollection(strDatabase, strCollection);
  let arrBatch: string[] = [];
  let intChars = 0;
  const flush = () => {
    if (arrBatch.length > 0) arrStatements.push({ text: `${strTarget}.insertMany([\n${arrBatch.join(',\n')}\n])`, rows: arrBatch.length });
    arrBatch = [];
    intChars = 0;
  };
  for (const strDocument of arrDocuments) {
    if (arrBatch.length >= BATCH_DOCUMENTS || (arrBatch.length > 0 && intChars + strDocument.length > BATCH_CHARS)) flush();
    arrBatch.push(strDocument);
    intChars += strDocument.length;
  }
  flush();
  return arrStatements;
}
