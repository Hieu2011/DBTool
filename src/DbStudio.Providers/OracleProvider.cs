using System.Data.Common;
using System.Text.RegularExpressions;
using DbStudio.Core;
using System.Data;
using Oracle.ManagedDataAccess.Client;
using Oracle.ManagedDataAccess.Types;

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

    protected override string RowCountsSql => """
        SELECT owner, table_name, num_rows
        FROM all_tables
        WHERE owner = NVL(:schema, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'))
          AND num_rows IS NOT NULL
        """;

    protected override string SchemasSql => "SELECT username FROM all_users ORDER BY username";

    protected override string CurrentSchemaSql => "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM dual";

    /// <summary>ODP.NET rejects a trailing ';' on plain SQL but PL/SQL blocks need it.</summary>
    protected override string PrepareSql(string strSql)
    {
        var strResult = strSql.Trim();
        while (strResult.EndsWith('/')) strResult = strResult[..^1].TrimEnd(); // SQL*Plus terminator
        // SQL*Plus: EXEC proc(args) is a one-line block.
        if (ExecCall().Match(strResult) is { Success: true } objExec)
            return $"BEGIN {objExec.Groups[1].Value.TrimEnd().TrimEnd(';').TrimEnd()}; END;";
        if (!PlSqlStart().IsMatch(strResult) && strResult.EndsWith(';')) strResult = strResult[..^1].TrimEnd();
        return strResult;
    }

    /// <summary>Statements that can print: PL/SQL blocks and calls. A plain SELECT is not worth two more round trips.</summary>
    private bool CanPrint(string strSql)
    {
        var strPrepared = PrepareSql(strSql);
        return PlSqlStart().IsMatch(strPrepared) || strPrepared.StartsWith("CALL", StringComparison.OrdinalIgnoreCase);
    }

    protected override async Task BeforeEditorStatementAsync(DbConnection objConn, DbTransaction? objTransaction, string strSql,
        CancellationToken objCancelToken)
    {
        if (!CanPrint(strSql)) return;
        try
        {
            await using var objCmd = objConn.CreateCommand();
            objCmd.Transaction = objTransaction;
            objCmd.CommandText = "BEGIN DBMS_OUTPUT.ENABLE(NULL); END;";
            await objCmd.ExecuteNonQueryAsync(objCancelToken);
        }
        catch (Exception) { /* no output is better than no statement */ }
    }

    /// <summary>Empties the session's DBMS_OUTPUT buffer into the messages.</summary>
    protected override async Task ReadServerOutputAsync(DbConnection objConn, DbTransaction? objTransaction, string strSql,
        List<string> lstMessages, CancellationToken objCancelToken)
    {
        if (!CanPrint(strSql)) return;
        try
        {
            await using var objCmd = (OracleCommand)objConn.CreateCommand();
            objCmd.Transaction = (OracleTransaction?)objTransaction;
            objCmd.CommandText = """
                DECLARE
                  l_line VARCHAR2(32767);
                  l_status INTEGER;
                  l_text CLOB;
                BEGIN
                  LOOP
                    DBMS_OUTPUT.GET_LINE(l_line, l_status);
                    EXIT WHEN l_status <> 0;
                    l_text := l_text || l_line || CHR(10);
                  END LOOP;
                  :p_text := l_text;
                END;
                """;
            var objText = new OracleParameter("p_text", OracleDbType.Clob, ParameterDirection.Output);
            objCmd.Parameters.Add(objText);
            await objCmd.ExecuteNonQueryAsync(objCancelToken);
            if (objText.Value is not OracleClob { IsNull: false } objClob) return;
            lstMessages.AddRange(objClob.Value.TrimEnd('\n').Split('\n'));
        }
        catch (Exception) { /* the statement's own result is what matters */ }
    }

    private const int FetchRows = 5000;
    private const long MaxFetchBytes = 16 * 1024 * 1024;

    /// <summary>LOB / LONG values travel with their row: the default asks the server again for every such cell.</summary>
    protected override void TuneCommand(DbCommand objCmd)
    {
        if (objCmd is not OracleCommand objOracleCmd) return;
        objOracleCmd.InitialLOBFetchSize = -1;
        objOracleCmd.InitialLONGFetchSize = -1;
    }

    /// <summary>The driver fetches 128 KB per round trip, counted by declared column widths: a wide table gets a few rows
    /// each time. Ask for the rows the grid wants in as few trips as possible.</summary>
    protected override void TuneReader(DbDataReader objReader, int intMaxRows)
    {
        try
        {
            if (objReader is not OracleDataReader { RowSize: > 0 } objOracleReader) return;
            var lngRows = Math.Min((long)intMaxRows + 1, FetchRows); // one more: that is how a cut result is noticed
            var lngBytes = Math.Min(objOracleReader.RowSize * lngRows, MaxFetchBytes);
            if (lngBytes > objOracleReader.FetchSize) objOracleReader.FetchSize = lngBytes;
        }
        catch (Exception) { /* the default fetch size still works */ }
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

    [GeneratedRegex(@"^EXEC(?:UTE)?\s+(?!IMMEDIATE\b)(.+)$", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex ExecCall();
}
