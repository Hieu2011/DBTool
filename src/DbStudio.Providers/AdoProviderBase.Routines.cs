using System.Data.Common;
using System.Diagnostics;
using System.Globalization;
using DbStudio.Core;

namespace DbStudio.Providers;

// Execute form: parameters of a procedure / function, and running it.
public abstract partial class AdoProviderBase
{
    /// <summary>Columns in order: position, name, data type, mode (IN / OUT / INOUT / RETURN), ordered by position.
    /// Uses the parameters schema, name, signature. Null = the provider can't run routines.</summary>
    protected virtual string? RoutineParametersSql => null;

    /// <summary>Calls the routine on an open connection. The provider owns transaction handling and commits.</summary>
    protected virtual Task<RoutineResult> ExecuteRoutineOnAsync(DbConnection objConn, DbObjectInfo objRoutine, RoutineInfo objInfo,
        IReadOnlyList<RoutineArgument> lstArguments, int intMaxRows, CancellationToken objCancelToken) =>
        throw new NotSupportedException($"Running a procedure or function is not supported for {Kind} yet.");

    public async Task<RoutineInfo> LoadRoutineAsync(ConnectionProfile objProfile, DbObjectInfo objRoutine, CancellationToken objCancelToken)
    {
        await using var objConn = CreateConnection(objProfile);
        await objConn.OpenAsync(objCancelToken);
        return await LoadRoutineOnAsync(objConn, objRoutine, objCancelToken);
    }

    public async Task<RoutineResult> ExecuteRoutineAsync(ConnectionProfile objProfile, DbObjectInfo objRoutine,
        IReadOnlyList<RoutineArgument> lstArguments, int intMaxRows, CancellationToken objCancelToken)
    {
        var objStopwatch = Stopwatch.StartNew();
        await using var objConn = CreateConnection(objProfile);
        await objConn.OpenAsync(objCancelToken);

        // Parameter types come from the catalog, never from the client.
        var objInfo = await LoadRoutineOnAsync(objConn, objRoutine, objCancelToken);
        var objResult = await ExecuteRoutineOnAsync(objConn, objRoutine, objInfo, lstArguments, intMaxRows, objCancelToken);
        return objResult with { ElapsedMs = objStopwatch.ElapsedMilliseconds };
    }

    /// <summary>Runs SQL with named string parameters on an open connection (catalog and routine calls).</summary>
    protected Task<QueryResult> RunAsync(DbConnection objConn, DbTransaction? objTransaction, string strSql, int intMaxRows,
        CancellationToken objCancelToken, params (string Name, string? Value)[] arrParams) =>
        ExecuteOnAsync(objConn, objTransaction, strSql, intMaxRows, objCancelToken, null, arrParams);

    /// <summary>The argument the user gave for a parameter, or null when there is none (treated as SQL NULL).</summary>
    protected static string? ArgumentFor(IReadOnlyList<RoutineArgument> lstArguments, RoutineParameter objParameter) =>
        lstArguments.FirstOrDefault(objItem => objItem.Position == objParameter.Position)?.Value;

    private async Task<RoutineInfo> LoadRoutineOnAsync(DbConnection objConn, DbObjectInfo objRoutine, CancellationToken objCancelToken)
    {
        if (RoutineParametersSql is not { } strSql)
            throw new NotSupportedException($"Running a procedure or function is not supported for {Kind} yet.");

        var objGrid = await ExecuteOnAsync(objConn, null, strSql, MaxSectionRows, objCancelToken, objRoutine);
        var lstParameters = objGrid.Rows
            .Select(arrRow => new RoutineParameter(
                Name: Convert.ToString(arrRow[1], CultureInfo.InvariantCulture) ?? "",
                DataType: Convert.ToString(arrRow[2], CultureInfo.InvariantCulture) ?? "",
                Mode: Convert.ToString(arrRow[3], CultureInfo.InvariantCulture) ?? "IN",
                Position: Convert.ToInt32(arrRow[0], CultureInfo.InvariantCulture)))
            .ToList();
        return new RoutineInfo(lstParameters);
    }
}
