using System.Data;
using System.Data.Common;
using System.Globalization;
using System.Text.RegularExpressions;
using DbStudio.Core;
using Oracle.ManagedDataAccess.Client;
using Oracle.ManagedDataAccess.Types;

namespace DbStudio.Providers;

// Execute form for standalone Oracle procedures and functions (not package members yet).
public sealed partial class OracleProvider
{
    // Position 0 is a function's return value. A parameterless procedure has one placeholder row without a data type.
    protected override string RoutineParametersSql => """
        SELECT position,
               NVL(argument_name, 'RETURN'),
               data_type,
               CASE WHEN position = 0 THEN 'RETURN' ELSE REPLACE(in_out, '/', '') END
        FROM all_arguments
        WHERE owner = :schema AND object_name = :name AND package_name IS NULL
          AND data_level = 0 AND data_type IS NOT NULL
        ORDER BY position
        """;

    protected override async Task<RoutineResult> ExecuteRoutineOnAsync(DbConnection objConn, DbObjectInfo objRoutine, RoutineInfo objInfo,
        IReadOnlyList<RoutineArgument> lstArguments, int intMaxRows, CancellationToken objCancelToken)
    {
        static string Quote(string strIdentifier) => "\"" + strIdentifier.Replace("\"", "\"\"") + "\"";

        await using var objCmd = (OracleCommand)objConn.CreateCommand();
        objCmd.CommandType = CommandType.StoredProcedure;
        objCmd.CommandText = $"{Quote(objRoutine.Schema)}.{Quote(objRoutine.Name)}";
        objCmd.BindByName = true;
        objCmd.CommandTimeout = 0; // the Stop button is the timeout

        // The return value has position 0, so it is added first as ODP.NET requires.
        foreach (var objParameter in objInfo.Parameters)
        {
            var enmType = MapType(objParameter.DataType);
            var objOracleParam = new OracleParameter
            {
                ParameterName = objParameter.Mode == "RETURN" ? "RETURN_VALUE" : objParameter.Name,
                OracleDbType = enmType,
                Direction = objParameter.Mode switch
                {
                    "RETURN" => ParameterDirection.ReturnValue,
                    "OUT" => ParameterDirection.Output,
                    "INOUT" => ParameterDirection.InputOutput,
                    _ => ParameterDirection.Input,
                },
            };
            if (objParameter.Mode is "IN" or "INOUT")
                objOracleParam.Value = ConvertArgument(objParameter, enmType, ArgumentFor(lstArguments, objParameter));
            if (objParameter.Mode != "IN" && enmType is OracleDbType.Varchar2 or OracleDbType.NVarchar2 or OracleDbType.Char or OracleDbType.NChar or OracleDbType.Raw)
                objOracleParam.Size = 32767; // room for the value coming back
            objCmd.Parameters.Add(objOracleParam);
        }

        using var objCancelReg = objCancelToken.Register(() => { try { objCmd.Cancel(); } catch { /* already finished */ } });
        await objCmd.ExecuteNonQueryAsync(objCancelToken); // no transaction: ODP.NET commits the call

        var lstResults = new List<ObjectSection>();
        var lstOutputs = new List<RoutineOutput>();
        foreach (OracleParameter objOracleParam in objCmd.Parameters)
        {
            if (objOracleParam.Direction == ParameterDirection.Input) continue;
            if (objOracleParam.Value is OracleRefCursor objCursor)
            {
                if (objCursor.IsNull) { lstOutputs.Add(new RoutineOutput(objOracleParam.ParameterName, null)); continue; }
                var objGrid = new QueryResult();
                await using (var objReader = objCursor.GetDataReader())
                    await ReadRowsAsync(objReader, objGrid, intMaxRows, objCancelToken);
                lstResults.Add(new ObjectSection(objOracleParam.ParameterName, objGrid));
            }
            else
            {
                var objValue = objOracleParam.Value;
                var boolNull = objValue is null or DBNull || objValue is INullable { IsNull: true };
                lstOutputs.Add(new RoutineOutput(objOracleParam.ParameterName, boolNull ? null : Convert.ToString(objValue, CultureInfo.InvariantCulture)));
            }
        }
        return new RoutineResult(lstResults, lstOutputs, 0);
    }

    // Editor: every :name in an anonymous block or CALL is bound as an OUT cursor, e.g. BEGIN proc(1, :cur); END;
    protected override void BindEditorParameters(DbCommand objCmd)
    {
        if (!CursorBlockStart().IsMatch(objCmd.CommandText)) return;

        var hsNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match objMatch in Placeholder().Matches(objCmd.CommandText))
            if (objMatch.Groups[1].Success) hsNames.Add(objMatch.Groups[1].Value);
        if (hsNames.Count == 0) return;

        var objOracleCmd = (OracleCommand)objCmd;
        objOracleCmd.BindByName = true;
        foreach (var strName in hsNames)
            objOracleCmd.Parameters.Add(new OracleParameter(strName, OracleDbType.RefCursor, ParameterDirection.Output));
    }

    protected override async Task<List<QueryResult>> ReadOutputCursorsAsync(DbCommand objCmd, int intMaxRows, CancellationToken objCancelToken)
    {
        var lstResults = new List<QueryResult>();
        foreach (OracleParameter objOracleParam in objCmd.Parameters)
        {
            if (objOracleParam.Value is not OracleRefCursor { IsNull: false } objCursor) continue;
            var objGrid = new QueryResult();
            await using (var objReader = objCursor.GetDataReader())
                await ReadRowsAsync(objReader, objGrid, intMaxRows, objCancelToken);
            lstResults.Add(objGrid);
        }
        return lstResults;
    }

    [GeneratedRegex(@"^\s*(BEGIN|DECLARE|CALL)\b", RegexOptions.IgnoreCase)]
    private static partial Regex CursorBlockStart();

    // Strings, quoted names and comments are matched first so a ':' inside them is not a placeholder.
    [GeneratedRegex("""'(?:[^']|'')*'|"[^"]*"|--[^\n]*|/\*.*?\*/|:([A-Za-z]\w*)""", RegexOptions.Singleline)]
    private static partial Regex Placeholder();

    /// <summary>ALL_ARGUMENTS.DATA_TYPE to the ODP.NET type. Unknown types go as text and Oracle converts them.</summary>
    private static OracleDbType MapType(string strDataType) => strDataType.ToUpperInvariant() switch
    {
        "VARCHAR2" or "VARCHAR" or "ROWID" or "UROWID" => OracleDbType.Varchar2,
        "NVARCHAR2" => OracleDbType.NVarchar2,
        "CHAR" => OracleDbType.Char,
        "NCHAR" => OracleDbType.NChar,
        "NUMBER" or "FLOAT" or "INTEGER" => OracleDbType.Decimal,
        "BINARY_INTEGER" or "PLS_INTEGER" => OracleDbType.Int32,
        "BINARY_FLOAT" => OracleDbType.BinaryFloat,
        "BINARY_DOUBLE" => OracleDbType.BinaryDouble,
        "DATE" => OracleDbType.Date,
        "TIMESTAMP WITH TIME ZONE" => OracleDbType.TimeStampTZ,
        "TIMESTAMP WITH LOCAL TIME ZONE" => OracleDbType.TimeStampLTZ,
        "CLOB" => OracleDbType.Clob,
        "NCLOB" => OracleDbType.NClob,
        "BLOB" => OracleDbType.Blob,
        "RAW" => OracleDbType.Raw,
        "REF CURSOR" => OracleDbType.RefCursor,
        "PL/SQL BOOLEAN" => OracleDbType.Boolean,
        var strOther when strOther.StartsWith("TIMESTAMP", StringComparison.Ordinal) => OracleDbType.TimeStamp,
        _ => OracleDbType.Varchar2,
    };

    /// <summary>Text from the form to the value ODP.NET expects. Numbers use '.', dates yyyy-MM-dd [HH:mm:ss].</summary>
    private static object ConvertArgument(RoutineParameter objParameter, OracleDbType enmType, string? strValue)
    {
        if (strValue is null) return DBNull.Value;
        try
        {
            return enmType switch
            {
                OracleDbType.Decimal => decimal.Parse(strValue, NumberStyles.Number, CultureInfo.InvariantCulture),
                OracleDbType.Int32 => int.Parse(strValue, NumberStyles.Integer, CultureInfo.InvariantCulture),
                OracleDbType.BinaryFloat => float.Parse(strValue, NumberStyles.Float, CultureInfo.InvariantCulture),
                OracleDbType.BinaryDouble => double.Parse(strValue, NumberStyles.Float, CultureInfo.InvariantCulture),
                OracleDbType.Date or OracleDbType.TimeStamp or OracleDbType.TimeStampTZ or OracleDbType.TimeStampLTZ =>
                    DateTime.Parse(strValue, CultureInfo.InvariantCulture, DateTimeStyles.None),
                OracleDbType.Boolean => bool.Parse(strValue),
                OracleDbType.Raw or OracleDbType.Blob => Convert.FromHexString(strValue),
                _ => strValue,
            };
        }
        catch (Exception objEx) when (objEx is FormatException or OverflowException)
        {
            throw new InvalidOperationException($"Parameter {objParameter.Name}: '{strValue}' is not a valid {objParameter.DataType}.");
        }
    }
}
