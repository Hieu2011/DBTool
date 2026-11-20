/**
 * Folding for query editors: every statement that spans two or more lines folds as one group,
 * and indentation blocks inside it still fold on their own.
 * Other models (DDL viewer) return null and keep Monaco's indentation folding.
 */
import type * as Monaco from 'monaco-editor';
import { splitStatements } from './statements';

/** 1-based, inclusive lines. */
export interface Fold { start: number; end: number }

const hsModels =new WeakSet<Monaco.editor.ITextModel>();

/** Turns statement folding on for a model. */
export function foldByStatement(objModel: Monaco.editor.ITextModel) {
  hsModels.add(objModel);
}

/** Line pairs (1-based, inclusive) of the statements worth folding. */
export function statementFolds(strSql: string, strDialect: 'pgsql' | 'oracle', lineOf: (intOffset: number) => number) {
  const arrFolds: Fold[] = [];
  let intLastEnd = 0;
  for (const objStatement of splitStatements(strSql, strDialect)) {
    const strLast = strSql[objStatement.stop - 1];
    const boolTerminated = objStatement.stop > objStatement.end && (strLast === ';' || strLast === '/');
    const intStart = lineOf(objStatement.start);
    const intEnd = lineOf(boolTerminated ? objStatement.stop - 1 : objStatement.end - 1);
    // Ranges must not share a line: `select 1; select` + next line keeps only the first.
    if (intEnd > intStart && intStart > intLastEnd) {
      arrFolds.push({ start: intStart, end: intEnd });
      intLastEnd = intEnd;
    }
  }
  return arrFolds;
}

/** Indentation blocks: a line folds the deeper-indented lines under it. Blank lines never end a block. */
export function indentFolds(strSql: string, intTabSize: number) {
  const arrFolds: Fold[] = [];
  const arrOpen: { indent: number; line: number }[] = [];
  let intLastCode = 0;
  const closeTo = (intIndent: number) => {
    while (arrOpen.length && arrOpen[arrOpen.length - 1].indent >= intIndent) {
      const objOpen = arrOpen.pop()!;
      if (intLastCode > objOpen.line) arrFolds.push({ start: objOpen.line, end: intLastCode });
    }
  };

  strSql.split('\n').forEach((strLine, intIndex) => {
    if (!strLine.trim()) return;
    let intIndent = 0;
    for (const strChar of strLine) {
      if (strChar === ' ') intIndent++;
      else if (strChar === '\t') intIndent += intTabSize - (intIndent % intTabSize);
      else break;
    }
    closeTo(intIndent);
    arrOpen.push({ indent: intIndent, line: intIndex + 1 });
    intLastCode = intIndex + 1;
  });
  closeTo(0);
  return arrFolds;
}

/** Statement folds plus the indentation blocks that fit inside (or between) them. */
export function mergeFolds(arrStatements: Fold[], arrIndents: Fold[]) {
  const arrFolds = [...arrStatements];
  for (const objIndent of arrIndents) {
    const objOwner = arrStatements.find(objFold => objIndent.start >= objFold.start && objIndent.start <= objFold.end);
    let intEnd = objIndent.end;
    if (objOwner) {
      // The statement's own first line already has its fold.
      if (objIndent.start === objOwner.start) continue;
      intEnd = Math.min(intEnd, objOwner.end);
    } else {
      const objNext = arrStatements.find(objFold => objFold.start > objIndent.start);
      if (objNext) intEnd = Math.min(intEnd, objNext.start - 1);
    }
    if (intEnd > objIndent.start) arrFolds.push({ start: objIndent.start, end: intEnd });
  }
  return arrFolds.sort((objA, objB) => objA.start - objB.start || objB.end - objA.end);
}

let boolRegistered = false;

export function registerSqlFolding(objMonaco: typeof Monaco) {
  if (boolRegistered) return;
  boolRegistered = true;

  const objProvider: Monaco.languages.FoldingRangeProvider = {
    provideFoldingRanges(objModel) {
      if (!hsModels.has(objModel)) return null;
      const strSql = objModel.getValue();
      const arrStatements = statementFolds(
        strSql,
        objModel.getLanguageId() === 'pgsql' ? 'pgsql' : 'oracle',
        intOffset => objModel.getPositionAt(intOffset).lineNumber,
      );
      return mergeFolds(arrStatements, indentFolds(strSql, objModel.getOptions().tabSize));
    },
  };

  objMonaco.languages.registerFoldingRangeProvider('pgsql', objProvider);
  objMonaco.languages.registerFoldingRangeProvider('sql', objProvider);
}
