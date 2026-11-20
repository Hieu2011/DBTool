/**
 * Autocomplete for MongoDB editors (language "mongodb"): collections after `db.`, methods after a
 * collection, modifiers after a call, and inside the arguments the fields sampled from the
 * collection plus the query / update / pipeline operators.
 */
import type * as Monaco from 'monaco-editor';
import { metadataOf } from './completion';
import { getSnippets } from './snippets';
import { splitStatements } from './statements';

const DB_METHODS: [string, string][] = [
  ['getCollection', 'getCollection("${1:name}")'], ['getSiblingDB', 'getSiblingDB("${1:database}")'],
  ['getCollectionNames', 'getCollectionNames()'], ['createCollection', 'createCollection("${1:name}")'],
  ['runCommand', 'runCommand({ ${1} })'], ['adminCommand', 'adminCommand({ ${1} })'], ['stats', 'stats()'], ['getName', 'getName()'],
];

const COLLECTION_METHODS: [string, string][] = [
  ['find', 'find({ ${1} })'], ['findOne', 'findOne({ ${1} })'], ['aggregate', 'aggregate([\n  { \\$match: { ${1} } }\n])'],
  ['countDocuments', 'countDocuments({ ${1} })'], ['estimatedDocumentCount', 'estimatedDocumentCount()'],
  ['distinct', 'distinct("${1:field}", { ${2} })'],
  ['insertOne', 'insertOne({ ${1} })'], ['insertMany', 'insertMany([\n  { ${1} }\n])'],
  ['updateOne', 'updateOne({ ${1} }, { \\$set: { ${2} } })'], ['updateMany', 'updateMany({ ${1} }, { \\$set: { ${2} } })'],
  ['replaceOne', 'replaceOne({ ${1} }, { ${2} })'],
  ['deleteOne', 'deleteOne({ ${1} })'], ['deleteMany', 'deleteMany({ ${1} })'],
  ['createIndex', 'createIndex({ ${1:field}: 1 })'], ['dropIndex', 'dropIndex("${1:name}")'], ['getIndexes', 'getIndexes()'],
  ['stats', 'stats()'], ['drop', 'drop()'], ['renameCollection', 'renameCollection("${1:name}")'],
];

const MODIFIERS: [string, string][] = [
  ['sort', 'sort({ ${1:field}: 1 })'], ['limit', 'limit(${1:10})'], ['skip', 'skip(${1:0})'],
  ['project', 'project({ ${1:field}: 1 })'], ['count', 'count()'], ['hint', 'hint("${1:index}")'],
];

const OPERATORS = [
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$and', '$or', '$nor', '$not', '$exists', '$type', '$regex',
  '$elemMatch', '$all', '$size', '$expr', '$mod', '$text',
  '$set', '$unset', '$inc', '$mul', '$min', '$max', '$rename', '$push', '$pull', '$addToSet', '$pop', '$currentDate', '$setOnInsert',
  '$match', '$project', '$group', '$sort', '$limit', '$skip', '$unwind', '$lookup', '$addFields', '$count', '$facet', '$replaceRoot',
  '$sample', '$out', '$merge', '$unionWith', '$bucket', '$sortByCount',
  '$sum', '$avg', '$first', '$last', '$concat', '$cond', '$ifNull', '$dateToString', '$toString', '$toInt', '$toDate', '$arrayElemAt',
];

const HELPERS = ['ObjectId("")', 'ISODate("")', 'NumberLong()', 'NumberDecimal("")', 'true', 'false', 'null'];

/** Collection named by the statement: db.orders... or ...getCollection("orders"). */
const COLLECTION_REF = /\bgetCollection\(\s*["']([^"']+)["']\s*\)|\bdb\s*\.\s*(?!getSiblingDB\b|getCollection\b)([\w$.]+?)\s*\.\s*\w+\s*\(/;

let boolRegistered = false;

export function registerMongoCompletion(objMonaco: typeof Monaco) {
  if (boolRegistered) return;
  boolRegistered = true;

  objMonaco.languages.registerCompletionItemProvider('mongodb', {
    triggerCharacters: ['.', '$', '{', ' '],
    provideCompletionItems(objModel, objPosition) {
      const objMeta = metadataOf(objModel);
      const objWord = objModel.getWordUntilPosition(objPosition);
      const objRange = {
        startLineNumber: objPosition.lineNumber, endLineNumber: objPosition.lineNumber,
        startColumn: objWord.startColumn, endColumn: objWord.endColumn,
      };
      const objKind = objMonaco.languages.CompletionItemKind;
      const intSnippet = objMonaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
      const methodItems = (arrMethods: [string, string][], strDetail: string) => arrMethods.map(([strName, strBody], intIndex) => ({
        label: strName, kind: objKind.Method, detail: strDetail, insertText: strBody, insertTextRules: intSnippet,
        range: objRange, sortText: '1' + String(intIndex).padStart(3, '0'),
      }));

      // The statement around the cursor, and its text up to the cursor.
      const strSql = objModel.getValue();
      const intOffset = objModel.getOffsetAt(objPosition);
      const objStatement = splitStatements(strSql, 'mongo').filter(objItem => objItem.start <= intOffset).at(-1);
      const boolInside = objStatement && intOffset <= objStatement.stop && !(objStatement.stop > objStatement.end && intOffset >= objStatement.stop);
      const strStatement = objStatement && boolInside ? strSql.slice(objStatement.start, Math.max(objStatement.end, intOffset)) : '';
      const strBefore = objStatement && boolInside ? strSql.slice(objStatement.start, objModel.getOffsetAt({ lineNumber: objPosition.lineNumber, column: objWord.startColumn })) : '';

      // How deep in brackets the cursor is: 0 = on the call chain itself.
      let intDepth = 0;
      for (const strChar of strBefore.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')) {
        if ('([{'.includes(strChar)) intDepth++;
        else if (')]}'.includes(strChar)) intDepth--;
      }

      if (intDepth <= 0) {
        // `db.` -> collections and database methods
        if (/\bdb\s*\.\s*$/.test(strBefore) || /getSiblingDB\([^)]*\)\s*\.\s*$/.test(strBefore)) {
          const arrCollections = (objMeta?.tables ?? []).map(objTable => ({
            label: objTable.name, kind: objTable.type === 'VIEW' ? objKind.Interface : objKind.Struct,
            detail: `${objTable.type.toLowerCase()} ${objTable.schema}`,
            // A name the shell cannot take after a dot goes through getCollection().
            insertText: /^[A-Za-z_$][\w$]*$/.test(objTable.name) ? objTable.name : `getCollection(${JSON.stringify(objTable.name)})`,
            range: objRange, sortText: '0' + objTable.name,
          }));
          return { suggestions: [...arrCollections, ...methodItems(DB_METHODS, 'database')] };
        }
        // after a call -> modifiers; after a collection -> its methods
        if (/\)\s*\.\s*$/.test(strBefore) && !/getCollection\([^)]*\)\s*\.\s*$/.test(strBefore))
          return { suggestions: methodItems(MODIFIERS, 'modifier') };
        if (/\.\s*$/.test(strBefore)) return { suggestions: methodItems(COLLECTION_METHODS, 'collection') };

        // start of a statement
        const arrSnippets = getSnippets().filter(objSnippet => objSnippet.prefix).map(objSnippet => ({
          label: objSnippet.prefix, kind: objKind.Snippet, detail: objSnippet.name, documentation: objSnippet.body,
          insertText: objSnippet.body, insertTextRules: intSnippet, range: objRange, sortText: '2' + objSnippet.prefix,
        }));
        return {
          suggestions: [
            ...['db', 'show dbs', 'show collections', 'use '].map(strText => ({
              label: strText.trim(), kind: objKind.Keyword, insertText: strText, range: objRange, sortText: '0' + strText,
            })),
            ...arrSnippets,
          ],
        };
      }

      // inside the arguments: fields of the collection, operators, value helpers
      const arrRef = COLLECTION_REF.exec(strStatement);
      const strCollection = arrRef?.[1] ?? arrRef?.[2];
      const objTable = strCollection ? objMeta?.tables.find(objItem => objItem.name === strCollection) : undefined;
      const arrFields = (objTable?.columns ?? []).map((objColumn, intIndex) => ({
        label: objColumn.name, kind: objKind.Field, detail: objColumn.dataType,
        // A dotted path is only a valid key in quotes.
        insertText: objColumn.name.includes('.') ? JSON.stringify(objColumn.name) : objColumn.name,
        range: objRange, sortText: '1' + String(intIndex).padStart(4, '0'),
      }));
      const arrOperators = OPERATORS.map(strOperator => ({
        label: strOperator, kind: objKind.Operator, insertText: strOperator, range: objRange, sortText: '2' + strOperator,
      }));
      const arrHelpers = HELPERS.map(strHelper => ({
        label: strHelper, kind: objKind.Value, insertText: strHelper, range: objRange, sortText: '3' + strHelper,
      }));
      // Typing `$` asks for operators only.
      return { suggestions: objWord.word.startsWith('$') ? arrOperators : [...arrFields, ...arrOperators, ...arrHelpers] };
    },
  });
}
