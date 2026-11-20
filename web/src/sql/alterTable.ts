import type { DbKind } from '../types';
import type { QueryResult } from '../types';
import { qualifiedName, quoteIdent } from './identifiers';

export interface ColumnDef { name: string; type: string; notNull: boolean; default: string; comment: string }

/** One row of the table editor. original is missing for a column being added. */
export interface ColumnDraft extends ColumnDef { key: string; original?: ColumnDef; dropped: boolean }

const literal = (strText: string) => `'${strText.replace(/'/g, "''")}'`;

/** A name the user typed: a plain one folds like the server would, anything else is kept as typed and quoted. */
export const typedIdent = (strName: string, strKind: DbKind) => quoteIdent(catalogName(strName, strKind), strKind);

/** How the catalog will spell a name the user typed. */
export function catalogName(strName: string, strKind: DbKind) {
  const strTrimmed = strName.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_$#]*$/.test(strTrimmed)) return strTrimmed;
  return strKind === 'Oracle' ? strTrimmed.toUpperCase() : strTrimmed.toLowerCase();
}

/** The new name carries no schema: a table can't be renamed into another one. */
export const renameTableSql = (strTable: string, strKind: DbKind, strNewName: string) =>
  `ALTER TABLE ${strTable} RENAME TO ${typedIdent(strNewName, strKind)}`;

const commentSql = (strTarget: string, strComment: string, strKind: DbKind) =>
  `COMMENT ON ${strTarget} IS ${strComment === '' && strKind !== 'Oracle' ? 'NULL' : literal(strComment)}`;

export const isChanged = (objDraft: ColumnDraft) => {
  const objOld = objDraft.original;
  return !objOld || objDraft.dropped || objDraft.name.trim() !== objOld.name || objDraft.type.trim() !== objOld.type
    || objDraft.notNull !== objOld.notNull || objDraft.default.trim() !== objOld.default || objDraft.comment !== objOld.comment;
};

/** Why the drafts can't be turned into SQL yet, or null. */
export function validate(arrDrafts: ColumnDraft[]): string | null {
  const arrLive = arrDrafts.filter(objDraft => !objDraft.dropped);
  if (arrLive.length === 0) return 'A table needs at least one column.';
  if (arrLive.some(objDraft => objDraft.name.trim() === '')) return 'Every column needs a name.';
  if (arrLive.some(objDraft => objDraft.type.trim() === '')) return 'Every column needs a data type.';
  const arrNames = arrLive.map(objDraft => objDraft.name.trim().toLowerCase());
  if (new Set(arrNames).size !== arrNames.length) return 'Two columns have the same name.';
  return null;
}

/**
 * Statements (no trailing ';') that turn the table into the drafts: drops, renames, changes, adds, then comments.
 * strTable is the qualified, already quoted table name.
 */
export function buildAlterScript(strTable: string, strKind: DbKind, arrDrafts: ColumnDraft[],
  strOldComment: string, strNewComment: string): string[] {
  const boolOracle = strKind === 'Oracle';
  const arrDrops: string[] = [];
  const arrRenames: string[] = [];
  const arrChanges: string[] = [];
  const arrAdds: string[] = [];
  const arrComments: string[] = [];

  if (strNewComment !== strOldComment) arrComments.push(commentSql(`TABLE ${strTable}`, strNewComment, strKind));

  for (const objDraft of arrDrafts) {
    const objOld = objDraft.original;
    const strType = objDraft.type.trim();
    const strDefault = objDraft.default.trim();

    if (objDraft.dropped) {
      if (objOld) arrDrops.push(`ALTER TABLE ${strTable} DROP COLUMN ${quoteIdent(objOld.name, strKind)}`);
      continue;
    }

    if (!objOld) {
      const strName = typedIdent(objDraft.name, strKind);
      const strTail = `${strDefault ? ` DEFAULT ${strDefault}` : ''}${objDraft.notNull ? ' NOT NULL' : ''}`;
      arrAdds.push(boolOracle
        ? `ALTER TABLE ${strTable} ADD (${strName} ${strType}${strTail})`
        : `ALTER TABLE ${strTable} ADD COLUMN ${strName} ${strType}${strTail}`);
      if (objDraft.comment) arrComments.push(commentSql(`COLUMN ${strTable}.${strName}`, objDraft.comment, strKind));
      continue;
    }

    const boolRenamed = objDraft.name.trim() !== objOld.name;
    const strName = boolRenamed ? typedIdent(objDraft.name, strKind) : quoteIdent(objOld.name, strKind);
    if (boolRenamed) arrRenames.push(`ALTER TABLE ${strTable} RENAME COLUMN ${quoteIdent(objOld.name, strKind)} TO ${strName}`);

    const boolType = strType !== objOld.type;
    const boolDefault = strDefault !== objOld.default;
    const boolNull = objDraft.notNull !== objOld.notNull;

    if (boolOracle) {
      // One MODIFY carries only the parts that changed. DEFAULT NULL removes a default.
      if (boolType || boolDefault || boolNull) {
        const arrParts = [
          ...(boolType ? [strType] : []),
          ...(boolDefault ? [`DEFAULT ${strDefault || 'NULL'}`] : []),
          ...(boolNull ? [objDraft.notNull ? 'NOT NULL' : 'NULL'] : []),
        ];
        arrChanges.push(`ALTER TABLE ${strTable} MODIFY (${strName} ${arrParts.join(' ')})`);
      }
    } else {
      const strAlter = `ALTER TABLE ${strTable} ALTER COLUMN ${strName}`;
      if (boolType) arrChanges.push(`${strAlter} TYPE ${strType}`);
      if (boolDefault) arrChanges.push(strDefault ? `${strAlter} SET DEFAULT ${strDefault}` : `${strAlter} DROP DEFAULT`);
      if (boolNull) arrChanges.push(`${strAlter} ${objDraft.notNull ? 'SET' : 'DROP'} NOT NULL`);
    }

    if (objDraft.comment !== objOld.comment) arrComments.push(commentSql(`COLUMN ${strTable}.${strName}`, objDraft.comment, strKind));
  }

  return [...arrDrops, ...arrRenames, ...arrChanges, ...arrAdds, ...arrComments];
}

export type ConstraintType = 'PRIMARY KEY' | 'UNIQUE' | 'FOREIGN KEY' | 'CHECK';

/** A constraint being added. Name may be empty: the server then names it. */
export interface NewConstraint {
  key: string; name: string; type: ConstraintType; columns: string;
  refTable: string; refColumns: string; onDelete: '' | 'CASCADE' | 'SET NULL'; check: string;
}

export interface NewIndex { key: string; name: string; unique: boolean; columns: string }

/** "a, b" -> quoted identifiers. Known column names win over case folding; anything that is not a plain
 * name list (an expression, DESC...) is passed through as typed. */
function columnList(strText: string, strKind: DbKind, arrKnown: string[]) {
  const arrParts = strText.split(',').map(strPart => strPart.trim()).filter(strPart => strPart !== '');
  if (!arrParts.every(strPart => /^[A-Za-z_][A-Za-z0-9_$#]*$/.test(strPart))) return strText.trim();
  return arrParts.map(strPart => {
    const strKnown = arrKnown.find(strName => strName === strPart) ?? arrKnown.find(strName => strName.toLowerCase() === strPart.toLowerCase());
    return strKnown ? quoteIdent(strKnown, strKind) : typedIdent(strPart, strKind);
  }).join(', ');
}

export function validateConstraint(objItem: NewConstraint): string | null {
  if (objItem.type === 'CHECK') return objItem.check.trim() === '' ? 'A CHECK constraint needs a condition.' : null;
  if (objItem.columns.trim() === '') return `A ${objItem.type} constraint needs its columns.`;
  if (objItem.type === 'FOREIGN KEY' && objItem.refTable.trim() === '') return 'A FOREIGN KEY needs the referenced table.';
  return null;
}

export const validateIndex = (objItem: NewIndex): string | null =>
  objItem.name.trim() === '' ? 'Every index needs a name.' : objItem.columns.trim() === '' ? 'Every index needs its columns.' : null;

export const dropConstraintSql = (strTable: string, strKind: DbKind, strName: string) =>
  `ALTER TABLE ${strTable} DROP CONSTRAINT ${quoteIdent(strName, strKind)}`;

export function addConstraintSql(strTable: string, strKind: DbKind, objItem: NewConstraint, arrKnown: string[]) {
  const strHead = `ALTER TABLE ${strTable} ADD ${objItem.name.trim() ? `CONSTRAINT ${typedIdent(objItem.name, strKind)} ` : ''}`;
  if (objItem.type === 'CHECK') return `${strHead}CHECK (${objItem.check.trim()})`;

  const strColumns = columnList(objItem.columns, strKind, arrKnown);
  if (objItem.type !== 'FOREIGN KEY') return `${strHead}${objItem.type} (${strColumns})`;

  // Referenced columns are optional: without them the key points at the other table's primary key.
  const strRefColumns = objItem.refColumns.trim() ? ` (${columnList(objItem.refColumns, strKind, [])})` : '';
  return `${strHead}FOREIGN KEY (${strColumns}) REFERENCES ${objItem.refTable.trim()}${strRefColumns}`
    + (objItem.onDelete ? ` ON DELETE ${objItem.onDelete}` : '');
}

/** An index lives in its table's schema: PostgreSQL always, Oracle by this tool's convention. */
export const dropIndexSql = (strSchema: string, strKind: DbKind, strName: string) =>
  `DROP INDEX ${quoteIdent(strSchema, strKind)}.${quoteIdent(strName, strKind)}`;

export function addIndexSql(strTable: string, strSchema: string, strKind: DbKind, objItem: NewIndex, arrKnown: string[]) {
  // PostgreSQL rejects a schema on the new index's name.
  const strName = (strKind === 'Oracle' ? `${quoteIdent(strSchema, strKind)}.` : '') + typedIdent(objItem.name, strKind);
  return `CREATE ${objItem.unique ? 'UNIQUE ' : ''}INDEX ${strName} ON ${strTable} (${columnList(objItem.columns, strKind, arrKnown)})`;
}

/** True when the kept columns are no longer in their original order, or a new one sits before an existing one. */
export function isReordered(arrDrafts: ColumnDraft[]) {
  let boolSeenNew = false;
  let intLast = -1;
  for (const objDraft of arrDrafts) {
    if (objDraft.dropped) continue;
    if (!objDraft.original) { boolSeenNew = true; continue; }
    const intIndex = Number(objDraft.key.slice(4)); // key is col-<original position>
    if (boolSeenNew || intIndex < intLast) return true;
    intLast = intIndex;
  }
  return false;
}

export interface RebuildArgs {
  strSchema: string; strName: string; strKind: DbKind;
  arrDrafts: ColumnDraft[]; strNewComment: string; strNewName: string | null;
  /** Constraints / Indexes grids of the object viewer. */
  objConstraints?: QueryResult; objIndexes?: QueryResult;
}

const gridCell = (objGrid: QueryResult, arrRow: unknown[], strColumn: string) => {
  const intCol = objGrid.columns.findIndex(objColumn => objColumn.name === strColumn);
  return intCol < 0 ? null : arrRow[intCol] ?? null;
};

/**
 * Neither Oracle 11g nor PostgreSQL can move a column: the table is built again in the new order and the
 * data copied over. The script is for the user to review and run by hand, never for Apply.
 */
export function buildRebuildScript({ strSchema, strName, strKind, arrDrafts, strNewComment, strNewName, objConstraints, objIndexes }: RebuildArgs) {
  const boolOracle = strKind === 'Oracle';
  const strTable = qualifiedName(strSchema, strName, strKind);
  // Oracle 11g names stop at 30 characters, PostgreSQL at 63.
  const strTempName = boolOracle ? `${strName.slice(0, 26)}_NEW` : `${strName.slice(0, 59)}_new`;
  const strTemp = qualifiedName(strSchema, strTempName, strKind);
  const arrLive = arrDrafts.filter(objDraft => !objDraft.dropped);
  const nameOf = (objDraft: ColumnDraft) =>
    (objDraft.original && objDraft.name.trim() === objDraft.original.name ? quoteIdent(objDraft.original.name, strKind) : typedIdent(objDraft.name, strKind));
  const arrCopied = arrLive.filter(objDraft => objDraft.original);
  const columnNames = (strColumns: string) => strColumns.split(',').map(strColumn => quoteIdent(strColumn.trim(), strKind)).join(', ');

  const arrLines: string[] = [
    `-- Rebuilds ${strTable} to change its column order. REVIEW EVERY LINE BEFORE RUNNING.`,
    '-- NOT recreated: triggers, grants, foreign keys of other tables that point here, identity columns,',
    `-- sequences owned by a column, partitioning, storage options${boolOracle ? ', FOREIGN KEY / CHECK constraints, function-based indexes' : ''}.`,
    '-- Constraint and index definitions below still use the old column names: fix them if you renamed a column.',
    boolOracle
      ? '-- Oracle commits every DDL statement. DROP TABLE fails while other tables reference this one; a dropped table can come back with FLASHBACK TABLE ... TO BEFORE DROP.'
      : '-- One transaction: run the whole script with Run all. If a statement fails, run ROLLBACK; and nothing is changed.',
    '',
  ];
  if (!boolOracle) arrLines.push('BEGIN;', '');

  arrLines.push(`CREATE TABLE ${strTemp} (`);
  arrLines.push(arrLive.map(objDraft =>
    `  ${nameOf(objDraft)} ${objDraft.type.trim()}${objDraft.default.trim() ? ` DEFAULT ${objDraft.default.trim()}` : ''}${objDraft.notNull ? ' NOT NULL' : ''}`).join(',\n'));
  arrLines.push(');', '');

  if (arrCopied.length > 0) {
    arrLines.push(`INSERT INTO ${strTemp} (${arrCopied.map(nameOf).join(', ')})`);
    arrLines.push(`SELECT ${arrCopied.map(objDraft => quoteIdent(objDraft.original!.name, strKind)).join(', ')} FROM ${strTable};`, '');
  }

  arrLines.push(`DROP TABLE ${strTable};`);
  arrLines.push(`ALTER TABLE ${strTemp} RENAME TO ${quoteIdent(strName, strKind)};`, '');

  // Indexes first: on Oracle a key added afterwards reuses a matching index instead of colliding with it.
  const arrConstraintNames = (objConstraints?.rows ?? []).map(arrRow => String(arrRow[0] ?? ''));
  if (objIndexes) {
    for (const arrRow of objIndexes.rows) {
      const strIndex = String(arrRow[0] ?? '');
      if (arrConstraintNames.includes(strIndex) || gridCell(objIndexes, arrRow, 'primary') === true) continue; // comes back with its constraint
      if (!boolOracle) { arrLines.push(`${String(gridCell(objIndexes, arrRow, 'definition') ?? '')};`); continue; }
      const strColumns = String(gridCell(objIndexes, arrRow, 'columns') ?? '');
      const strIndexType = String(gridCell(objIndexes, arrRow, 'type') ?? '');
      if (strIndexType !== 'NORMAL' || strColumns === '' || strColumns.includes('SYS_NC')) {
        arrLines.push(`-- TODO recreate by hand: index ${strIndex} (${strIndexType})`);
        continue;
      }
      arrLines.push(`CREATE ${gridCell(objIndexes, arrRow, 'unique') === 'UNIQUE' ? 'UNIQUE ' : ''}INDEX ${qualifiedName(strSchema, strIndex, strKind)}`
        + ` ON ${strTable} (${columnNames(strColumns)});`);
    }
  }

  if (objConstraints) {
    for (const arrRow of objConstraints.rows) {
      const strConstraint = String(arrRow[0] ?? '');
      const strType = String(gridCell(objConstraints, arrRow, 'type') ?? '');
      const strHead = `ALTER TABLE ${strTable} ADD CONSTRAINT ${quoteIdent(strConstraint, strKind)}`;
      if (!boolOracle) { arrLines.push(`${strHead} ${String(gridCell(objConstraints, arrRow, 'definition') ?? '')};`); continue; }
      const strColumns = String(gridCell(objConstraints, arrRow, 'columns') ?? '');
      if ((strType === 'PRIMARY KEY' || strType === 'UNIQUE') && strColumns !== '')
        arrLines.push(`${strHead} ${strType} (${columnNames(strColumns)});`);
      else arrLines.push(`-- TODO recreate by hand: ${strType} ${strConstraint} (${strColumns})`);
    }
  }

  if (strNewComment) arrLines.push(`${commentSql(`TABLE ${strTable}`, strNewComment, strKind)};`);
  for (const objDraft of arrLive)
    if (objDraft.comment) arrLines.push(`${commentSql(`COLUMN ${strTable}.${nameOf(objDraft)}`, objDraft.comment, strKind)};`);

  if (strNewName) arrLines.push('', `${renameTableSql(strTable, strKind, strNewName)};`);
  if (!boolOracle) arrLines.push('', 'COMMIT;');
  return arrLines.join('\n');
}
