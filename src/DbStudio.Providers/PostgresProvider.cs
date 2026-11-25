using System.Data.Common;
using DbStudio.Core;
using Npgsql;

namespace DbStudio.Providers;

public sealed partial class PostgresProvider : AdoProviderBase
{
    public override DbKind Kind => DbKind.PostgreSql;

    protected override bool SavepointPerStatement => true;

    protected override DbConnection CreateConnection(ConnectionProfile objProfile)
    {
        var objBuilder = string.IsNullOrWhiteSpace(objProfile.Extra)
            ? new NpgsqlConnectionStringBuilder()
            : new NpgsqlConnectionStringBuilder(objProfile.Extra);
        objBuilder.Host = objProfile.Host;
        objBuilder.Port = objProfile.Port > 0 ? objProfile.Port : 5432;
        objBuilder.Database = objProfile.Database;
        objBuilder.Username = objProfile.Username;
        objBuilder.Password = objProfile.Password;
        objBuilder.ApplicationName ??= "DbStudio";
        return new NpgsqlConnection(objBuilder.ConnectionString);
    }

    // pg_catalog is much faster than information_schema on big databases.
    protected override string MetadataSql => """
        SELECT n.nspname,
               c.relname,
               CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
                              WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
               a.attname,
               format_type(a.atttypid, a.atttypmod)
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
          AND n.nspname NOT LIKE 'pg_temp%'
        ORDER BY n.nspname, c.relname, a.attnum
        """;

    // Statistics are useless for small tables (never analyzed, or reset): those are counted for real, which is
    // cheap under 4 MB. Bigger ones use reltuples / the live-tuple counter; 0 there means unknown.
    protected override string RowCountsSql => """
        SELECT t.nspname, t.relname,
               CASE WHEN t.small
                    THEN (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', t.nspname, t.relname), false, true, '')))[1]::text::bigint
                    ELSE NULLIF(t.estimate, 0) END
        FROM (
            SELECT n.nspname, c.relname,
                   c.relkind IN ('r', 'm') AND pg_relation_size(c.oid) <= 4194304 AND has_table_privilege(c.oid, 'SELECT') AS small,
                   GREATEST(c.reltuples::bigint, COALESCE(s.n_live_tup, 0)) AS estimate
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
            WHERE c.relkind IN ('r', 'p', 'm')
              AND n.nspname NOT IN ('pg_catalog', 'information_schema')
              AND n.nspname NOT LIKE 'pg_toast%'
              AND n.nspname NOT LIKE 'pg_temp%'
        ) t
        """;

    public override QueryError DescribeError(Exception objEx) => objEx switch
    {
        PostgresException objPgEx => new QueryError(
            objPgEx.MessageText + (objPgEx.Detail is { Length: > 0 } strDetail ? $"\n{strDetail}" : "") + (objPgEx.Hint is { Length: > 0 } strHint ? $"\nHint: {strHint}" : ""),
            objPgEx.Position > 0 ? objPgEx.Position : null,
            objPgEx.SqlState),
        _ => base.DescribeError(objEx),
    };
}
