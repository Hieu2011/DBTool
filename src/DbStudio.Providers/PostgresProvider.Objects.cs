using System.Data.Common;
using DbStudio.Core;
using Npgsql;

namespace DbStudio.Providers;

// Object explorer for PostgreSQL. DDL is rebuilt from pg_catalog: the server has no "show create table".
public sealed partial class PostgresProvider
{
    private const string UserSchemaFilter = """
        n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
          AND n.nspname NOT LIKE 'pg_temp%'
        """;

    private const string RelationFilter = "n.nspname = @schema AND c.relname = @name";

    // Extension-owned functions (pg_trgm, postgis...) are left out: they would bury the user's own.
    protected override string ObjectsSql => $"""
        SELECT n.nspname,
               p.proname,
               CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
               pg_get_function_identity_arguments(p.oid)
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.prokind IN ('f', 'p')
          AND {UserSchemaFilter}
          AND NOT EXISTS (SELECT 1 FROM pg_depend d
                          WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
        UNION ALL
        SELECT n.nspname, c.relname, 'SEQUENCE', NULL
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'S'
          AND {UserSchemaFilter}
        ORDER BY 1, 3, 2, 4
        """;

    private const string ColumnsSql = $"""
        SELECT a.attnum AS "#",
               a.attname AS "column",
               format_type(a.atttypid, a.atttypmod) AS "type",
               NOT a.attnotnull AS "nullable",
               pg_get_expr(d.adbin, d.adrelid) AS "default",
               col_description(a.attrelid, a.attnum) AS "comment"
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE {RelationFilter} AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
        """;

    private const string IndexesSql = $"""
        SELECT i.relname AS "index",
               ix.indisunique AS "unique",
               ix.indisprimary AS "primary",
               am.amname AS "method",
               pg_size_pretty(pg_relation_size(ix.indexrelid)) AS "size",
               pg_get_indexdef(ix.indexrelid) AS "definition"
        FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_am am ON am.oid = i.relam
        JOIN pg_class c ON c.oid = ix.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE {RelationFilter}
        ORDER BY i.relname
        """;

    protected override string? CommentSql(DbObjectInfo objObject) => objObject.Type switch
    {
        "TABLE" or "VIEW" or "MATERIALIZED VIEW" or "FOREIGN TABLE" or "SEQUENCE" => $"""
            SELECT obj_description(c.oid, 'pg_class')
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE {RelationFilter}
            """,
        _ => null,
    };

    private const string ConstraintsSql = $"""
        SELECT con.conname AS "constraint",
               CASE con.contype WHEN 'p' THEN 'PRIMARY KEY' WHEN 'u' THEN 'UNIQUE' WHEN 'f' THEN 'FOREIGN KEY'
                                WHEN 'c' THEN 'CHECK' WHEN 'x' THEN 'EXCLUDE' ELSE con.contype::text END AS "type",
               pg_get_constraintdef(con.oid) AS "definition"
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE {RelationFilter} AND con.contype IN ('p', 'u', 'f', 'c', 'x')
        ORDER BY CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 ELSE 3 END, con.conname
        """;

    private const string SequenceSql = """
        SELECT data_type::text AS "type", start_value, min_value, max_value, increment_by,
               cycle, cache_size, last_value
        FROM pg_sequences
        WHERE schemaname = @schema AND sequencename = @name
        """;

    private const string TriggersSql = $"""
        SELECT t.tgname AS "trigger",
               CASE t.tgenabled WHEN 'D' THEN 'disabled' ELSE 'enabled' END AS "status",
               pg_get_triggerdef(t.oid) AS "definition"
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE {RelationFilter} AND NOT t.tgisinternal
        ORDER BY t.tgname
        """;

    // Functions whose source mentions the table name as a whole word. PostgreSQL records no dependency
    // for a function body, so this is a text search: a same-named table in another schema also matches.
    // Columns: name, arguments, schema (the tree opens the function from them).
    private static string RoutinesUsingSql(string strAlias, char chrProKind) => $"""
        SELECT p.proname AS "{strAlias}",
               pg_get_function_identity_arguments(p.oid) AS "arguments",
               n.nspname AS "schema"
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.prokind = '{chrProKind}'
          AND {UserSchemaFilter}
          AND p.prosrc ~* ('\m' || regexp_replace(@name, '\W', '\\\&', 'g') || '\M')
        ORDER BY n.nspname, p.proname
        """;

    protected override IReadOnlyList<(string Title, string Sql)> OnDemandSectionQueries(DbObjectInfo objObject) => objObject.Type switch
    {
        "TABLE" or "VIEW" or "MATERIALIZED VIEW" or "FOREIGN TABLE" =>
        [
            ("Functions", RoutinesUsingSql("function", 'f')),
            ("Procedures", RoutinesUsingSql("procedure", 'p')),
        ],
        _ => [],
    };

    // Foreign keys in both directions. "columns" belong to this table, "other_columns" to the table on the other end.
    private const string RelationsSql = $"""
        SELECT CASE WHEN con.conrelid = c.oid THEN 'out' ELSE 'in' END AS "direction",
               con.conname AS "constraint",
               ons.nspname AS "schema",
               o.relname AS "table",
               (SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
                FROM unnest(CASE WHEN con.conrelid = c.oid THEN con.conkey ELSE con.confkey END) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum) AS "columns",
               (SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
                FROM unnest(CASE WHEN con.conrelid = c.oid THEN con.confkey ELSE con.conkey END) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = o.oid AND a.attnum = k.attnum) AS "other_columns"
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_constraint con ON con.contype = 'f' AND (con.conrelid = c.oid OR con.confrelid = c.oid)
        JOIN pg_class o ON o.oid = CASE WHEN con.conrelid = c.oid THEN con.confrelid ELSE con.conrelid END
        JOIN pg_namespace ons ON ons.oid = o.relnamespace
        WHERE {RelationFilter}
        ORDER BY 1 DESC, 2
        """;

    // Guessed relations for schemas that declare no foreign keys: table A points at table B when A has every
    // primary key column of B (same names). Same schema only; partitions and catch-all key names are left out.
    private const string InferredRelationsSql = """
        WITH t AS (
            SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = @schema AND c.relname = @name),
        pk AS (
            SELECT i.indrelid AS relid, array_agg(a.attname::text ORDER BY a.attname) AS cols
            FROM pg_index i
            JOIN pg_class c ON c.oid = i.indrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE i.indisprimary AND n.nspname = @schema AND NOT c.relispartition
            GROUP BY i.indrelid),
        cols AS (
            SELECT a.attrelid AS relid, array_agg(a.attname::text) AS cols
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = @schema AND c.relkind IN ('r', 'p') AND NOT c.relispartition
              AND a.attnum > 0 AND NOT a.attisdropped
            GROUP BY a.attrelid)
        SELECT 'out' AS "direction", 'same column name' AS "constraint", @schema::text AS "schema", p.relname::text AS "table",
               array_to_string(pk.cols, ', ') AS "columns", array_to_string(pk.cols, ', ') AS "other_columns"
        FROM t
        JOIN cols tc ON tc.relid = t.oid
        JOIN pk ON pk.relid <> t.oid AND pk.cols <@ tc.cols
        JOIN pg_class p ON p.oid = pk.relid
        WHERE NOT pk.cols && ARRAY['id', 'code', 'name']
        UNION ALL
        SELECT 'in', 'same column name', @schema::text, ch.relname::text,
               array_to_string(pk.cols, ', '), array_to_string(pk.cols, ', ')
        FROM t
        JOIN pk ON pk.relid = t.oid
        JOIN cols cc ON cc.relid <> t.oid AND pk.cols <@ cc.cols
        JOIN pg_class ch ON ch.oid = cc.relid
        WHERE NOT pk.cols && ARRAY['id', 'code', 'name']
        ORDER BY 1 DESC, 4
        """;

    // PostgreSQL keeps no dependency list for a function body, so the source is searched for table names:
    // schema.table anywhere, or the bare name for tables in the routine's own schema. A column or variable
    // that is spelled like a table is a false hit; tables reached through search_path or dynamic SQL are missed.
    private const string RoutineTablesCte = """
        WITH src AS (
            SELECT p.prosrc, n.nspname
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = @schema AND p.proname = @name
              AND pg_get_function_identity_arguments(p.oid) = coalesce(@signature, '')),
        used AS (
            SELECT c.oid, tn.nspname, c.relname
            FROM src
            JOIN pg_class c ON c.relkind IN ('r', 'p') AND NOT c.relispartition
            JOIN pg_namespace tn ON tn.oid = c.relnamespace
            WHERE tn.nspname NOT IN ('pg_catalog', 'information_schema') AND tn.nspname NOT LIKE 'pg_toast%'
              AND tn.nspname NOT LIKE 'pg_temp%'
              AND (src.prosrc ~* ('\m' || regexp_replace(tn.nspname, '\W', '\\\&', 'g') || '\.'
                                       || regexp_replace(c.relname, '\W', '\\\&', 'g') || '\M')
                   OR (tn.nspname = src.nspname
                       AND src.prosrc ~* ('\m' || regexp_replace(c.relname, '\W', '\\\&', 'g') || '\M'))))

        """;

    private const string RoutineTablesSql = RoutineTablesCte + """
        SELECT u.nspname AS "schema", u.relname AS "table",
               (SELECT string_agg(a.attname, ', ' ORDER BY a.attnum)
                FROM pg_index i
                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
                WHERE i.indrelid = u.oid AND i.indisprimary) AS "primary_key"
        FROM used u
        ORDER BY 1, 2
        """;

    // Declared foreign keys between the tables of RoutineTablesSql.
    private const string RoutineRelationsSql = RoutineTablesCte + """
        SELECT f.nspname AS "schema", f.relname AS "table",
               (SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
                FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = f.oid AND a.attnum = k.attnum) AS "columns",
               t.nspname AS "ref_schema", t.relname AS "ref_table",
               (SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
                FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum) AS "ref_columns",
               con.conname AS "constraint"
        FROM pg_constraint con
        JOIN used f ON f.oid = con.conrelid
        JOIN used t ON t.oid = con.confrelid
        WHERE con.contype = 'f'
        ORDER BY 1, 2, 7
        """;

    protected override IReadOnlyList<(string Title, string Sql)> ByNameSectionQueries(DbObjectInfo objObject) => objObject.Type switch
    {
        "TABLE" => [("Relations", RelationsSql), ("InferredRelations", InferredRelationsSql)],
        "FUNCTION" or "PROCEDURE" => [("RoutineTables", RoutineTablesSql), ("RoutineRelations", RoutineRelationsSql)],
        _ => [],
    };

    // The object tree shows these by title (and each one's first two columns): keep titles in sync with ObjectTree.tsx.
    protected override IReadOnlyList<(string Title, string Sql)> SectionQueries(DbObjectInfo objObject) => objObject.Type switch
    {
        "TABLE" => [("Columns", ColumnsSql), ("Indexes", IndexesSql), ("Constraints", ConstraintsSql), ("Triggers", TriggersSql)],
        "MATERIALIZED VIEW" => [("Columns", ColumnsSql), ("Indexes", IndexesSql)],
        "VIEW" or "FOREIGN TABLE" => [("Columns", ColumnsSql)],
        "SEQUENCE" => [("Properties", SequenceSql)],
        _ => [],
    };

    protected override Task<string?> LoadDdlAsync(DbConnection objConn, DbObjectInfo objObject, CancellationToken objCancelToken)
    {
        // attgenerated (generated columns) exists from PostgreSQL 12.
        var boolGenerated = objConn is NpgsqlConnection { PostgreSqlVersion.Major: >= 12 };
        var strSql = objObject.Type switch
        {
            "TABLE" => TableDdlSql(boolGenerated),
            "VIEW" => ViewDdlSql("CREATE OR REPLACE VIEW", "v"),
            "MATERIALIZED VIEW" => ViewDdlSql("CREATE MATERIALIZED VIEW", "m"),
            "FUNCTION" or "PROCEDURE" => FunctionDdlSql,
            "SEQUENCE" => SequenceDdlSql,
            _ => null,
        };
        return strSql is null ? Task.FromResult<string?>(null) : ScalarAsync(objConn, strSql, objObject, objCancelToken);
    }

    private const string QualifiedName = "quote_ident(n.nspname) || '.' || quote_ident(c.relname)";

    // Indexes that back a constraint are already in the CREATE TABLE body.
    private const string IndexDdlFragment = """
        coalesce((
            SELECT string_agg(E'\n' || pg_get_indexdef(ix.indexrelid) || ';', '' ORDER BY ix.indexrelid::regclass::text)
            FROM pg_index ix
            WHERE ix.indrelid = c.oid
              AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = ix.indexrelid)), '')
        """;

    private static string TableDdlSql(bool boolGenerated)
    {
        var strDefault = boolGenerated
            ? """
              CASE WHEN a.attgenerated = 's' THEN ' GENERATED ALWAYS AS (' || pg_get_expr(d.adbin, d.adrelid) || ') STORED'
                   WHEN d.adbin IS NOT NULL THEN ' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid) ELSE '' END
              """
            : "CASE WHEN d.adbin IS NOT NULL THEN ' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid) ELSE '' END";

        return $"""
            SELECT 'CREATE TABLE ' || {QualifiedName} || E' (\n'
                || coalesce((
                    SELECT string_agg(
                             '    ' || quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod)
                             || CASE a.attidentity WHEN 'a' THEN ' GENERATED ALWAYS AS IDENTITY'
                                                   WHEN 'd' THEN ' GENERATED BY DEFAULT AS IDENTITY' ELSE '' END
                             || {strDefault}
                             || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END,
                             E',\n' ORDER BY a.attnum)
                    FROM pg_attribute a
                    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                    WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '')
                || coalesce((
                    SELECT string_agg(E',\n    CONSTRAINT ' || quote_ident(con.conname) || ' ' || pg_get_constraintdef(con.oid), ''
                                      ORDER BY CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 ELSE 3 END, con.conname)
                    FROM pg_constraint con
                    WHERE con.conrelid = c.oid AND con.contype IN ('p', 'u', 'f', 'c', 'x')), '')
                || E'\n)'
                || CASE WHEN c.relkind = 'p' THEN ' PARTITION BY ' || pg_get_partkeydef(c.oid) ELSE '' END
                || ';'
                || {IndexDdlFragment}
                || coalesce(E'\nCOMMENT ON TABLE ' || {QualifiedName} || ' IS '
                            || quote_literal(obj_description(c.oid, 'pg_class')) || ';', '')
                || coalesce((
                    SELECT string_agg(E'\nCOMMENT ON COLUMN ' || {QualifiedName} || '.' || quote_ident(a.attname) || ' IS '
                                      || quote_literal(col_description(a.attrelid, a.attnum)) || ';', '' ORDER BY a.attnum)
                    FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                      AND col_description(a.attrelid, a.attnum) IS NOT NULL), '')
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE {RelationFilter} AND c.relkind IN ('r', 'p')
            """;
    }

    private static string ViewDdlSql(string strCreate, string strRelKind) => $"""
        SELECT '{strCreate} ' || {QualifiedName} || E' AS\n' || pg_get_viewdef(c.oid, true)
            || {IndexDdlFragment}
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE {RelationFilter} AND c.relkind = '{strRelKind}'
        """;

    private const string FunctionDdlSql = """
        SELECT pg_get_functiondef(p.oid)
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = @schema AND p.proname = @name
          AND pg_get_function_identity_arguments(p.oid) = coalesce(@signature, '')
        """;

    private const string SequenceDdlSql = """
        SELECT format(E'CREATE SEQUENCE %I.%I\n    AS %s\n    INCREMENT BY %s\n    MINVALUE %s\n    MAXVALUE %s\n    START WITH %s\n    CACHE %s%s;',
                      schemaname, sequencename, data_type, increment_by, min_value, max_value, start_value, cache_size,
                      CASE WHEN cycle THEN E'\n    CYCLE' ELSE '' END)
        FROM pg_sequences
        WHERE schemaname = @schema AND sequencename = @name
        """;
}
