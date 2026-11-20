using System.Data.Common;
using System.Text.RegularExpressions;
using DbStudio.Core;
using Oracle.ManagedDataAccess.Client;

namespace DbStudio.Providers;

public sealed partial class OracleProvider : AdoProviderBase
{
    public override DbKind Kind => DbKind.Oracle;

    protected override DbConnection CreateConnection(ConnectionProfile objProfile)
    {
        var objBuilder = string.IsNullOrWhiteSpace(objProfile.Extra)
            ? new OracleConnectionStringBuilder()
            : new OracleConnectionStringBuilder(objProfile.Extra);
        objBuilder.DataSource = $"{objProfile.Host}:{(objProfile.Port > 0 ? objProfile.Port : 1521)}/{objProfile.Database}"; // EZConnect: host:port/service
        objBuilder.UserID = objProfile.Username;
        objBuilder.Password = objProfile.Password;
        return new OracleConnection(objBuilder.ConnectionString);
    }

    // One schema per load (:schema, null = current): ALL_TAB_COLUMNS over every owner is slow on large instances.
    // The object tree asks for another schema when the user opens it.
    protected override string MetadataSql => """
        SELECT c.owner, c.table_name, o.object_type, c.column_name, c.data_type
        FROM all_tab_columns c
        JOIN all_objects o
          ON o.owner = c.owner AND o.object_name = c.table_name
         AND o.object_type IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW')
        WHERE c.owner = NVL(:schema, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'))
        ORDER BY c.owner, c.table_name, c.column_id
        """;

    protected override string SchemasSql => "SELECT username FROM all_users ORDER BY username";

    protected override string CurrentSchemaSql => "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM dual";

    /// <summary>ODP.NET rejects a trailing ';' on plain SQL but PL/SQL blocks need it.</summary>
    protected override string PrepareSql(string strSql)
    {
        var strResult = strSql.Trim();
        while (strResult.EndsWith('/')) strResult = strResult[..^1].TrimEnd(); // SQL*Plus terminator
        if (!PlSqlStart().IsMatch(strResult) && strResult.EndsWith(';')) strResult = strResult[..^1].TrimEnd();
        return strResult;
    }

    /// <summary>NUMBER can exceed .NET decimal (e.g. 1E+40); fall back to Oracle's own type.</summary>
    protected override object? ReadValue(DbDataReader objReader, int intOrdinal)
    {
        try { return objReader.GetValue(intOrdinal); }
        catch (Exception objEx) when (objEx is InvalidCastException or OverflowException)
        {
            return objReader.GetProviderSpecificValue(intOrdinal)?.ToString();
        }
    }

    public override QueryError DescribeError(Exception objEx) => objEx switch
    {
        OracleException objOraEx => new QueryError(objOraEx.Message, null, $"ORA-{objOraEx.Number:D5}"),
        _ => base.DescribeError(objEx),
    };

    [GeneratedRegex(@"^(BEGIN|DECLARE|CREATE\s+(OR\s+REPLACE\s+)?(EDITIONABLE\s+|NONEDITIONABLE\s+)?(PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE))\b",
        RegexOptions.IgnoreCase)]
    private static partial Regex PlSqlStart();
}
