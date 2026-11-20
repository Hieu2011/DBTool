using System.Data.Common;
using System.Text;
using System.Text.RegularExpressions;
using DbStudio.Core;
using Oracle.ManagedDataAccess.Client;

namespace DbStudio.Providers;

// Object explorer for Oracle. Every statement here must run on 11g.
public sealed partial class OracleProvider
{
    protected override string ParamMarker => ":";

    /// <summary>ODP.NET binds by position unless told otherwise. Catalog LONG columns (data_default) are fetched whole.</summary>
    protected override void ConfigureParameterCommand(DbCommand objCmd)
    {
        var objOracleCmd = (OracleCommand)objCmd;
        objOracleCmd.BindByName = true;
        objOracleCmd.InitialLONGFetchSize = -1;
    }

    // Same scope as MetadataSql: one schema per load.
    protected override string ObjectsSql => """
        SELECT owner, object_name, object_type, NULL
        FROM all_objects
        WHERE owner = NVL(:schema, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'))
          AND object_type IN ('FUNCTION', 'PROCEDURE', 'PACKAGE', 'SEQUENCE', 'TRIGGER', 'TYPE', 'SYNONYM')
        ORDER BY owner, object_type, object_name
        """;

    // data_default is a LONG: select it as is, no function or ORDER BY may touch it.
    private const string ColumnsSql = """
        SELECT c.column_id AS "#",
               c.column_name AS "column",
               c.data_type ||
                 CASE WHEN c.data_type IN ('VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR')
                        THEN '(' || c.char_length || CASE c.char_used WHEN 'C' THEN ' CHAR' ELSE '' END || ')'
                      WHEN c.data_type = 'RAW' THEN '(' || c.data_length || ')'
                      WHEN c.data_type = 'NUMBER' AND c.data_precision IS NOT NULL
                        THEN '(' || c.data_precision || CASE WHEN c.data_scale > 0 THEN ',' || c.data_scale ELSE '' END || ')'
                      ELSE '' END AS "type",
               c.nullable AS "nullable",
               c.data_default AS "default",
               cm.comments AS "comment"
        FROM all_tab_columns c
        LEFT JOIN all_col_comments cm
          ON cm.owner = c.owner AND cm.table_name = c.table_name AND cm.column_name = c.column_name
        WHERE c.owner = :schema AND c.table_name = :name
        ORDER BY c.column_id
        """;

    protected override string? CommentSql(DbObjectInfo objObject) => objObject.Type switch
    {
        "TABLE" or "VIEW" => "SELECT comments FROM all_tab_comments WHERE owner = :schema AND table_name = :name",
        "MATERIALIZED VIEW" => "SELECT comments FROM all_mview_comments WHERE owner = :schema AND mview_name = :name",
        _ => null,
    };

    private const string IndexesSql = """
        SELECT i.index_name AS "index",
               i.uniqueness AS "unique",
               i.index_type AS "type",
               i.status AS "status",
               (SELECT LISTAGG(ic.column_name, ', ') WITHIN GROUP (ORDER BY ic.column_position)
                FROM all_ind_columns ic
                WHERE ic.index_owner = i.owner AND ic.index_name = i.index_name) AS "columns"
        FROM all_indexes i
        WHERE i.table_owner = :schema AND i.table_name = :name
        ORDER BY i.index_name
        """;

    // System-named CHECKs are the NOT NULL constraints: already shown in Columns. search_condition is a LONG.
    private const string ConstraintsSql = """
        SELECT con.constraint_name AS "constraint",
               DECODE(con.constraint_type, 'P', 'PRIMARY KEY', 'U', 'UNIQUE', 'R', 'FOREIGN KEY', 'C', 'CHECK',
                      con.constraint_type) AS "type",
               (SELECT LISTAGG(cc.column_name, ', ') WITHIN GROUP (ORDER BY cc.position)
                FROM all_cons_columns cc
                WHERE cc.owner = con.owner AND cc.constraint_name = con.constraint_name) AS "columns",
               con.r_owner || NVL2(con.r_constraint_name, '.', '') || con.r_constraint_name AS "references",
               con.status AS "status"
        FROM all_constraints con
        WHERE con.owner = :schema AND con.table_name = :name
          AND NOT (con.constraint_type = 'C' AND con.generated = 'GENERATED NAME')
        ORDER BY con.constraint_type, con.constraint_name
        """;

    private const string TriggersSql = """
        SELECT trigger_name AS "trigger", trigger_type AS "type", triggering_event AS "event", status AS "status"
        FROM all_triggers
        WHERE table_owner = :schema AND table_name = :name
        ORDER BY trigger_name
        """;

    private const string SequenceSql = """
        SELECT min_value, max_value, increment_by, cycle_flag, order_flag, cache_size, last_number
        FROM all_sequences
        WHERE sequence_owner = :schema AND sequence_name = :name
        """;

    private const string ErrorsSql = """
        SELECT type AS "part", line AS "line", position AS "position", text AS "error"
        FROM all_errors
        WHERE owner = :schema AND name = :name
        ORDER BY type, sequence
        """;

    // Procedures and functions of a package, in declaration order (overloads repeat the name).
    private const string MembersSql = """
        SELECT procedure_name AS "member", subprogram_id AS "#"
        FROM all_procedures
        WHERE owner = :schema AND object_name = :name AND procedure_name IS NOT NULL
        ORDER BY subprogram_id
        """;

    // Standalone procedure/function. Position 0 is a function's return value; a parameterless
    // procedure has one placeholder row without a data type.
    private const string ParametersSql = """
        SELECT NVL(argument_name, '(return)') AS "parameter",
               in_out || ' ' || data_type AS "type",
               position AS "#"
        FROM all_arguments
        WHERE owner = :schema AND object_name = :name AND package_name IS NULL
          AND data_level = 0 AND data_type IS NOT NULL
        ORDER BY position
        """;

    private const string SynonymSql = """
        SELECT table_owner AS "target owner", table_name AS "target", db_link AS "db link"
        FROM all_synonyms
        WHERE owner = :schema AND synonym_name = :name
        """;

    // Code that uses a table or view, from the dependency catalog. Columns: name, owner (the tree opens
    // the object from them). A reference made through a synonym is recorded against the synonym and is missed.
    private static string DependentsSql(string strAlias, string strDependentType) => $"""
        SELECT d.name AS "{strAlias}", d.owner AS "owner"
        FROM all_dependencies d
        WHERE d.referenced_owner = :schema AND d.referenced_name = :name
          AND d.referenced_type IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW')
          AND d.type = '{strDependentType}'
        ORDER BY d.owner, d.name
        """;

    protected override IReadOnlyList<(string Title, string Sql)> OnDemandSectionQueries(DbObjectInfo objObject) => objObject.Type switch
    {
        "TABLE" or "VIEW" or "MATERIALIZED VIEW" =>
        [
            ("Procedures", DependentsSql("procedure", "PROCEDURE")),
            ("Functions", DependentsSql("function", "FUNCTION")),
            ("Packages", DependentsSql("package", "PACKAGE BODY")),
        ],
        _ => [],
    };

    // Foreign keys in both directions. "columns" belong to this table, "other_columns" to the table on the other end.
    private const string RelationsSql = """
        SELECT 'out' AS "direction", con.constraint_name AS "constraint", r.owner AS "schema", r.table_name AS "table",
               (SELECT LISTAGG(cc.column_name, ', ') WITHIN GROUP (ORDER BY cc.position)
                FROM all_cons_columns cc
                WHERE cc.owner = con.owner AND cc.constraint_name = con.constraint_name) AS "columns",
               (SELECT LISTAGG(rc.column_name, ', ') WITHIN GROUP (ORDER BY rc.position)
                FROM all_cons_columns rc
                WHERE rc.owner = r.owner AND rc.constraint_name = r.constraint_name) AS "other_columns"
        FROM all_constraints con
        JOIN all_constraints r ON r.owner = con.r_owner AND r.constraint_name = con.r_constraint_name
        WHERE con.constraint_type = 'R' AND con.owner = :schema AND con.table_name = :name
        UNION ALL
        SELECT 'in', con.constraint_name, con.owner, con.table_name,
               (SELECT LISTAGG(rc.column_name, ', ') WITHIN GROUP (ORDER BY rc.position)
                FROM all_cons_columns rc
                WHERE rc.owner = r.owner AND rc.constraint_name = r.constraint_name),
               (SELECT LISTAGG(cc.column_name, ', ') WITHIN GROUP (ORDER BY cc.position)
                FROM all_cons_columns cc
                WHERE cc.owner = con.owner AND cc.constraint_name = con.constraint_name)
        FROM all_constraints r
        JOIN all_constraints con
          ON con.r_owner = r.owner AND con.r_constraint_name = r.constraint_name AND con.constraint_type = 'R'
        WHERE r.constraint_type IN ('P', 'U') AND r.owner = :schema AND r.table_name = :name
        ORDER BY 1 DESC, 2
        """;

    // Guessed relations for schemas that declare no foreign keys: table A points at table B when A has every
    // primary key column of B (same names). Same schema only; catch-all key names are left out.
    private const string InferredRelationsSql = """
        WITH pk AS (
            SELECT con.owner, con.table_name, cc.column_name,
                   COUNT(*) OVER (PARTITION BY con.table_name) AS cnt
            FROM all_constraints con
            JOIN all_cons_columns cc ON cc.owner = con.owner AND cc.constraint_name = con.constraint_name
            WHERE con.owner = :schema AND con.constraint_type = 'P')
        SELECT 'out' AS "direction", 'same column name' AS "constraint", pk.owner AS "schema", pk.table_name AS "table",
               LISTAGG(pk.column_name, ', ') WITHIN GROUP (ORDER BY pk.column_name) AS "columns",
               LISTAGG(pk.column_name, ', ') WITHIN GROUP (ORDER BY pk.column_name) AS "other_columns"
        FROM pk
        JOIN all_tab_columns tc
          ON tc.owner = pk.owner AND tc.table_name = :name AND tc.column_name = pk.column_name
        WHERE pk.table_name <> :name AND pk.column_name NOT IN ('ID', 'CODE', 'NAME')
        GROUP BY pk.owner, pk.table_name, pk.cnt
        HAVING COUNT(*) = pk.cnt
        UNION ALL
        SELECT 'in', 'same column name', c.owner, c.table_name,
               LISTAGG(pk.column_name, ', ') WITHIN GROUP (ORDER BY pk.column_name),
               LISTAGG(pk.column_name, ', ') WITHIN GROUP (ORDER BY pk.column_name)
        FROM pk
        JOIN all_tab_columns c
          ON c.owner = pk.owner AND c.column_name = pk.column_name AND c.table_name <> :name
        JOIN all_tables t ON t.owner = c.owner AND t.table_name = c.table_name
        WHERE pk.table_name = :name AND pk.column_name NOT IN ('ID', 'CODE', 'NAME')
        GROUP BY c.owner, c.table_name, pk.cnt
        HAVING COUNT(*) = pk.cnt
        ORDER BY 1 DESC, 4
        """;

    // Tables a procedure / function / package depends on. Tables reached through a synonym or dynamic SQL are not listed.
    private const string RoutineTablesCte = """
        WITH used AS (
            SELECT DISTINCT d.referenced_owner AS owner, d.referenced_name AS table_name
            FROM all_dependencies d
            WHERE d.owner = :schema AND d.name = :name
              AND d.type IN ('PROCEDURE', 'FUNCTION', 'PACKAGE', 'PACKAGE BODY')
              AND d.referenced_type = 'TABLE')

        """;

    private const string RoutineTablesSql = RoutineTablesCte + """
        SELECT u.owner AS "schema", u.table_name AS "table",
               (SELECT LISTAGG(cc.column_name, ', ') WITHIN GROUP (ORDER BY cc.position)
                FROM all_constraints con
                JOIN all_cons_columns cc ON cc.owner = con.owner AND cc.constraint_name = con.constraint_name
                WHERE con.owner = u.owner AND con.table_name = u.table_name AND con.constraint_type = 'P') AS "primary_key"
        FROM used u
        ORDER BY 1, 2
        """;

    // Declared foreign keys between the tables of RoutineTablesSql.
    private const string RoutineRelationsSql = RoutineTablesCte + """
        SELECT con.owner AS "schema", con.table_name AS "table",
               (SELECT LISTAGG(cc.column_name, ', ') WITHIN GROUP (ORDER BY cc.position)
                FROM all_cons_columns cc
                WHERE cc.owner = con.owner AND cc.constraint_name = con.constraint_name) AS "columns",
               r.owner AS "ref_schema", r.table_name AS "ref_table",
               (SELECT LISTAGG(rc.column_name, ', ') WITHIN GROUP (ORDER BY rc.position)
                FROM all_cons_columns rc
                WHERE rc.owner = r.owner AND rc.constraint_name = r.constraint_name) AS "ref_columns",
               con.constraint_name AS "constraint"
        FROM all_constraints con
        JOIN used f ON f.owner = con.owner AND f.table_name = con.table_name
        JOIN all_constraints r ON r.owner = con.r_owner AND r.constraint_name = con.r_constraint_name
        JOIN used t ON t.owner = r.owner AND t.table_name = r.table_name
        WHERE con.constraint_type = 'R'
        ORDER BY 1, 2, 7
        """;

    protected override IReadOnlyList<(string Title, string Sql)> ByNameSectionQueries(DbObjectInfo objObject) => objObject.Type switch
    {
        "TABLE" => [("Relations", RelationsSql), ("InferredRelations", InferredRelationsSql)],
        "FUNCTION" or "PROCEDURE" or "PACKAGE" => [("RoutineTables", RoutineTablesSql), ("RoutineRelations", RoutineRelationsSql)],
        _ => [],
    };

    // The object tree shows these by title (and each one's first two columns): keep titles in sync with ObjectTree.tsx.
    protected override IReadOnlyList<(string Title, string Sql)> SectionQueries(DbObjectInfo objObject) => objObject.Type switch
    {
        "TABLE" => [("Columns", ColumnsSql), ("Indexes", IndexesSql), ("Constraints", ConstraintsSql), ("Triggers", TriggersSql)],
        "MATERIALIZED VIEW" => [("Columns", ColumnsSql), ("Indexes", IndexesSql)],
        "VIEW" => [("Columns", ColumnsSql)],
        "SEQUENCE" => [("Properties", SequenceSql)],
        "SYNONYM" => [("Target", SynonymSql)],
        "PACKAGE" => [("Members", MembersSql), ("Errors", ErrorsSql)],
        "FUNCTION" or "PROCEDURE" => [("Parameters", ParametersSql), ("Errors", ErrorsSql)],
        "TRIGGER" or "TYPE" => [("Errors", ErrorsSql)],
        _ => [],
    };

    protected override async Task<string?> LoadDdlAsync(DbConnection objConn, DbObjectInfo objObject, CancellationToken objCancelToken)
    {
        // Readable output: statement terminators, no storage clauses. Cosmetic, so a failure is ignored.
        try
        {
            await using var objCmd = objConn.CreateCommand();
            objCmd.CommandText = """
                BEGIN
                  DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SQLTERMINATOR', TRUE);
                  DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SEGMENT_ATTRIBUTES', FALSE);
                END;
                """;
            await objCmd.ExecuteNonQueryAsync(objCancelToken);
        }
        catch (DbException) { }

        try
        {
            var strDdl = await ScalarAsync(objConn, "SELECT DBMS_METADATA.GET_DDL(:ddltype, :name, :schema) FROM dual",
                objObject, objCancelToken, ("ddltype", objObject.Type.Replace(' ', '_')));
            return strDdl?.Trim();
        }
        catch (DbException)
        {
            // Another schema's object without SELECT_CATALOG_ROLE: ORA-31603. The catalog views may still show the code.
            if (await LoadSourceAsync(objConn, objObject, objCancelToken) is { } strSource) return strSource;
            throw;
        }
    }

    /// <summary>Code read from ALL_SOURCE / ALL_VIEWS; null when this type has none there or nothing is visible.</summary>
    private async Task<string?> LoadSourceAsync(DbConnection objConn, DbObjectInfo objObject, CancellationToken objCancelToken)
    {
        try
        {
            if (objObject.Type == "TABLE") return await BuildTableDdlAsync(objConn, objObject, objCancelToken);
            if (objObject.Type == "VIEW")
            {
                var strQuery = await ScalarAsync(objConn, "SELECT text FROM all_views WHERE owner = :schema AND view_name = :name",
                    objObject, objCancelToken);
                return strQuery is null
                    ? null
                    : $"CREATE OR REPLACE VIEW {QuoteName(objObject.Schema)}.{QuoteName(objObject.Name)} AS\n{strQuery.Trim()};";
            }

            string[] arrTypes = objObject.Type switch
            {
                "PACKAGE" => ["PACKAGE", "PACKAGE BODY"],
                "TYPE" => ["TYPE", "TYPE BODY"],
                "PROCEDURE" or "FUNCTION" or "TRIGGER" => [objObject.Type],
                _ => [],
            };
            var lstParts = new List<string>();
            foreach (var strType in arrTypes)
            {
                var lstLines = await ColumnAsync(objConn,
                    "SELECT text FROM all_source WHERE owner = :schema AND name = :name AND type = :srctype ORDER BY line",
                    objObject, objCancelToken, ("srctype", strType));
                if (lstLines.Count > 0) lstParts.Add("CREATE OR REPLACE " + string.Concat(lstLines).TrimEnd() + "\n/");
            }
            return lstParts.Count == 0 ? null : string.Join("\n\n", lstParts);
        }
        catch (DbException)
        {
            return null; // the GET_DDL error is the one worth showing
        }
    }

    // search_condition is a LONG: select it as is.
    private const string DdlConstraintsSql = """
        SELECT con.constraint_name,
               con.constraint_type,
               (SELECT LISTAGG(cc.column_name, ',') WITHIN GROUP (ORDER BY cc.position)
                FROM all_cons_columns cc
                WHERE cc.owner = con.owner AND cc.constraint_name = con.constraint_name) AS cols,
               rc.owner AS ref_owner,
               rc.table_name AS ref_table,
               (SELECT LISTAGG(rcc.column_name, ',') WITHIN GROUP (ORDER BY rcc.position)
                FROM all_cons_columns rcc
                WHERE rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name) AS ref_cols,
               con.delete_rule,
               con.search_condition
        FROM all_constraints con
        LEFT JOIN all_constraints rc ON rc.owner = con.r_owner AND rc.constraint_name = con.r_constraint_name
        WHERE con.owner = :schema AND con.table_name = :name
          AND con.constraint_type IN ('P', 'U', 'R', 'C')
          AND NOT (con.constraint_type = 'C' AND con.generated = 'GENERATED NAME')
        ORDER BY DECODE(con.constraint_type, 'P', 1, 'U', 2, 'R', 3, 4), con.constraint_name
        """;

    // Indexes that back a primary key / unique constraint come with the constraint.
    private const string DdlIndexesSql = """
        SELECT i.owner,
               i.index_name,
               i.uniqueness,
               i.index_type
        FROM all_indexes i
        WHERE i.table_owner = :schema AND i.table_name = :name
          AND i.index_type <> 'LOB'
          AND NOT EXISTS (SELECT 1 FROM all_constraints c
                          WHERE c.owner = i.table_owner AND c.table_name = i.table_name
                            AND c.constraint_type IN ('P', 'U') AND c.index_name = i.index_name)
        ORDER BY i.index_name
        """;

    private const string DdlIndexColumnsSql = """
        SELECT index_owner, index_name, column_position, column_name, descend
        FROM all_ind_columns
        WHERE table_owner = :schema AND table_name = :name
        ORDER BY index_owner, index_name, column_position
        """;

    // Function-based (and DESC) columns: all_ind_columns only has a SYS_NC name for them. column_expression is a LONG.
    private const string DdlIndexExpressionsSql = """
        SELECT index_owner, index_name, column_position, column_expression
        FROM all_ind_expressions
        WHERE table_owner = :schema AND table_name = :name
        """;

    /// <summary>CREATE TABLE put together from the catalog views, for tables DBMS_METADATA refuses. Null = no columns visible.</summary>
    private async Task<string?> BuildTableDdlAsync(DbConnection objConn, DbObjectInfo objObject, CancellationToken objCancelToken)
    {
        // ColumnsSql: #, column, type, nullable, default, comment.
        var lstColumns = await RowsAsync(objConn, ColumnsSql, objObject, objCancelToken);
        if (lstColumns.Count == 0) return null;

        var strTable = $"{Ident(objObject.Schema)}.{Ident(objObject.Name)}";
        var lstLines = new List<string>();
        foreach (var arrColumn in lstColumns)
        {
            var strLine = $"  {Ident(arrColumn[1]!)} {arrColumn[2]}";
            if (!string.IsNullOrWhiteSpace(arrColumn[4])) strLine += $" DEFAULT {arrColumn[4]!.Trim()}";
            if (arrColumn[3] == "N") strLine += " NOT NULL";
            lstLines.Add(strLine);
        }

        foreach (var arrCon in await RowsAsync(objConn, DdlConstraintsSql, objObject, objCancelToken))
        {
            var strBody = arrCon[1] switch
            {
                "P" => $"PRIMARY KEY ({IdentList(arrCon[2])})",
                "U" => $"UNIQUE ({IdentList(arrCon[2])})",
                "R" => $"FOREIGN KEY ({IdentList(arrCon[2])}) REFERENCES {Ident(arrCon[3] ?? "?")}.{Ident(arrCon[4] ?? "?")} ({IdentList(arrCon[5])})"
                       + (arrCon[6] is "CASCADE" or "SET NULL" ? $" ON DELETE {arrCon[6]}" : ""),
                _ => $"CHECK ({arrCon[7]?.Trim()})",
            };
            lstLines.Add($"  CONSTRAINT {Ident(arrCon[0]!)} {strBody}");
        }

        var objDdl = new StringBuilder();
        objDdl.Append("-- Built from the data dictionary (DBMS_METADATA cannot read this table): no storage, partitioning or grants.\n");
        objDdl.Append($"CREATE TABLE {strTable} (\n").AppendJoin(",\n", lstLines).Append("\n);\n");

        var lstIndexes = await RowsAsync(objConn, DdlIndexesSql, objObject, objCancelToken);
        if (lstIndexes.Count > 0) objDdl.Append('\n');
        var lstIndexColumns = lstIndexes.Count > 0 ? await RowsAsync(objConn, DdlIndexColumnsSql, objObject, objCancelToken) : [];
        var dicExpressions = new Dictionary<(string?, string?, string?), string>();
        if (lstIndexes.Any(arrIndex => arrIndex[3]!.StartsWith("FUNCTION-BASED", StringComparison.Ordinal)))
        {
            // Not readable: those indexes are listed by name only.
            try
            {
                foreach (var arrExpr in await RowsAsync(objConn, DdlIndexExpressionsSql, objObject, objCancelToken))
                    if (!string.IsNullOrWhiteSpace(arrExpr[3])) dicExpressions[(arrExpr[0], arrExpr[1], arrExpr[2])] = arrExpr[3]!.Trim();
            }
            catch (DbException) { }
        }

        foreach (var arrIndex in lstIndexes)
        {
            var strName = $"{Ident(arrIndex[0]!)}.{Ident(arrIndex[1]!)}";
            var strType = arrIndex[3]!;
            var boolFunction = strType.StartsWith("FUNCTION-BASED ", StringComparison.Ordinal);
            var strBase = boolFunction ? strType["FUNCTION-BASED ".Length..] : strType;

            // Expression of the column, else its name; null = a hidden SYS_NC column whose expression is unknown.
            var lstKeys = lstIndexColumns
                .Where(arrColumn => arrColumn[0] == arrIndex[0] && arrColumn[1] == arrIndex[1])
                .Select(arrColumn =>
                {
                    var strKey = dicExpressions.TryGetValue((arrColumn[0], arrColumn[1], arrColumn[2]), out var strExpression)
                        ? strExpression
                        : boolFunction && arrColumn[3]!.StartsWith("SYS_N", StringComparison.Ordinal) ? null : Ident(arrColumn[3]!);
                    return strKey is null ? null : strKey + (arrColumn[4] == "DESC" ? " DESC" : "");
                })
                .ToList();

            // Domain, cluster... indexes need clauses the catalog views do not give.
            if (strBase is not ("NORMAL" or "BITMAP" or "NORMAL/REV") || lstKeys.Count == 0 || lstKeys.Contains(null))
            {
                objDdl.Append($"-- index {strName} ({strType}): definition not shown\n");
                continue;
            }
            var strKind = strBase == "BITMAP" ? "BITMAP " : arrIndex[2] == "UNIQUE" ? "UNIQUE " : "";
            var strReverse = strBase == "NORMAL/REV" ? " REVERSE" : "";
            objDdl.Append($"CREATE {strKind}INDEX {strName} ON {strTable} ({string.Join(", ", lstKeys)}){strReverse};\n");
        }

        var lstComments = new List<string>();
        if (await ScalarAsync(objConn, CommentSql(objObject)!, objObject, objCancelToken) is { Length: > 0 } strComment)
            lstComments.Add($"COMMENT ON TABLE {strTable} IS {Literal(strComment)};");
        foreach (var arrColumn in lstColumns)
            if (!string.IsNullOrEmpty(arrColumn[5]))
                lstComments.Add($"COMMENT ON COLUMN {strTable}.{Ident(arrColumn[1]!)} IS {Literal(arrColumn[5]!)};");
        if (lstComments.Count > 0) objDdl.Append('\n').AppendJoin("\n", lstComments).Append('\n');

        return objDdl.ToString().TrimEnd();
    }

    private static readonly Regex PlainIdent = new("^[A-Z][A-Z0-9_$#]*$", RegexOptions.Compiled);

    /// <summary>Quoted only when the name needs it.</summary>
    private static string Ident(string strName) => PlainIdent.IsMatch(strName) ? strName : QuoteName(strName);

    /// <summary>"A,B DESC" -> "A, B DESC".</summary>
    private static string IdentList(string? strNames) => string.Join(", ", (strNames ?? "").Split(',').Select(strItem =>
        strItem.EndsWith(" DESC", StringComparison.Ordinal) ? Ident(strItem[..^5]) + " DESC" : Ident(strItem)));

    private static string Literal(string strText) => "'" + strText.Replace("'", "''") + "'";

    private static string QuoteName(string strName) => '"' + strName.Replace("\"", "\"\"") + '"';
}
