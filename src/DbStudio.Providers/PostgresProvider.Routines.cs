using System.Data.Common;
using System.Text.RegularExpressions;
using DbStudio.Core;

namespace DbStudio.Providers;

// Execute form for PostgreSQL functions and procedures.
public sealed partial class PostgresProvider
{
    // proargtypes only lists input arguments; proallargtypes (when set) lists them all. 't' = RETURNS TABLE column.
    protected override string PrimaryKeySql => """
        SELECT a.attname
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) ON true
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE i.indisprimary AND n.nspname = @schema AND c.relname = @name AND c.relkind IN ('r', 'p')
        ORDER BY k.ord
        """;

    protected override string RoutineParametersSql => """
        SELECT a.ord,
               coalesce(nullif(p.proargnames[a.ord::int], ''), '$' || a.ord),
               format_type(a.typ, NULL),
               CASE coalesce(p.proargmodes[a.ord::int], 'i') WHEN 'o' THEN 'OUT' WHEN 'b' THEN 'INOUT' ELSE 'IN' END
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN LATERAL unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) WITH ORDINALITY AS a(typ, ord)
        WHERE n.nspname = @schema AND p.proname = @name
          AND pg_get_function_identity_arguments(p.oid) = coalesce(@signature, '')
          AND coalesce(p.proargmodes[a.ord::int], 'i') <> 't'
        ORDER BY a.ord
        """;

    private static string Quote(string strIdentifier) => "\"" + strIdentifier.Replace("\"", "\"\"") + "\"";

    // format_type gives "character" for bpchar, and a cast to bare "character" means char(1): it would cut the value.
    private static string CastType(string strDataType) =>
        strDataType.StartsWith("character", StringComparison.Ordinal) && !strDataType.StartsWith("character varying", StringComparison.Ordinal)
            ? "bpchar" + strDataType["character".Length..]
            : strDataType;

    private static readonly Regex SelectCall = new(@"^\s*select\b[^;]*\(", RegexOptions.IgnoreCase | RegexOptions.Singleline);

    // One row more than the limit tells "there is more" without cancelling: a cancel
    // would abort the transaction and undo what the function wrote.
    private async Task<QueryResult> FetchCursorAsync(DbConnection objConn, DbTransaction objTransaction, string strCursor,
        int intMaxRows, CancellationToken objCancelToken)
    {
        var objGrid = await RunAsync(objConn, objTransaction, $"FETCH {intMaxRows + 1} FROM {Quote(strCursor)}",
            intMaxRows + 1, objCancelToken);
        if (objGrid.Rows.Count > intMaxRows)
        {
            objGrid.Rows.RemoveAt(objGrid.Rows.Count - 1);
            objGrid.Truncated = true;
        }
        return objGrid;
    }

    // Auto-commit closes a refcursor as soon as the SELECT ends, so a SELECT that returns
    // only refcursors is run in a short transaction and answered with the cursors' rows.
    protected override async Task<QueryResult> ExecuteAutoCommitAsync(DbConnection objConn, string strSql, int intMaxRows,
        CancellationToken objCancelToken, IRowSink? objSink = null, CursorSlot? objKeep = null)
    {
        if (!SelectCall.IsMatch(strSql)) return await base.ExecuteAutoCommitAsync(objConn, strSql, intMaxRows, objCancelToken, objSink, objKeep);

        DbTransaction objTransaction;
        try { objTransaction = await objConn.BeginTransactionAsync(objCancelToken); }
        catch (InvalidOperationException)
        {
            // The user opened a transaction in SQL (BEGIN): leave it alone, the cursor lives in it.
            return await base.ExecuteAutoCommitAsync(objConn, strSql, intMaxRows, objCancelToken, objSink, objKeep);
        }

        // Not streamed: the rows may be cursor names that are swapped for the cursors' data below.
        var boolKept = false;
        try
        {
            var objResult = await RunKeepingAsync(objConn, objTransaction, strSql, intMaxRows, objCancelToken, objKeep);
            if (objKeep is { Reader: not null })
            {
                // Cut and left open: the transaction lives as long as the result does.
                objKeep.Transaction = objTransaction;
                boolKept = true;
                return objResult;
            }
            if (objResult.Columns.Count > 0 && objResult.Columns.All(objColumn => objColumn.DataType == "refcursor") && !objResult.Truncated)
            {
                var lstGrids = new List<QueryResult>();
                foreach (var strCursor in objResult.Rows.SelectMany(arrRow => arrRow).OfType<string>())
                    lstGrids.Add(await FetchCursorAsync(objConn, objTransaction, strCursor, intMaxRows, objCancelToken));
                if (Combine(lstGrids) is { } objCursors)
                {
                    objCursors.ElapsedMs += objResult.ElapsedMs;
                    objResult = objCursors;
                }
            }
            // After a truncated read the transaction is aborted and this ends as a rollback, same as a cancelled statement.
            await objTransaction.CommitAsync(objCancelToken);
            return objResult;
        }
        finally
        {
            if (!boolKept) await objTransaction.DisposeAsync();
        }
    }

    protected override async Task<RoutineResult> ExecuteRoutineOnAsync(DbConnection objConn, DbObjectInfo objRoutine, RoutineInfo objInfo,
        IReadOnlyList<RoutineArgument> lstArguments, int intMaxRows, CancellationToken objCancelToken)
    {
        var boolProcedure = objRoutine.Type == "PROCEDURE";
        var lstParams = new List<(string Name, string? Value)>();
        var lstCallArgs = new List<string>();
        foreach (var objParameter in objInfo.Parameters)
        {
            if (objParameter.Mode == "OUT")
            {
                if (boolProcedure) lstCallArgs.Add("NULL"); // CALL lists OUT arguments (PostgreSQL 14+); a function call doesn't
                continue;
            }
            // Values travel as text parameters and the server casts them to the declared type.
            if (ArgumentFor(lstArguments, objParameter) is { } strValue)
            {
                var strParam = $"p{objParameter.Position}";
                lstParams.Add((strParam, strValue));
                lstCallArgs.Add($"@{strParam}::{CastType(objParameter.DataType)}");
            }
            else lstCallArgs.Add($"NULL::{CastType(objParameter.DataType)}");
        }

        var strCall = $"{Quote(objRoutine.Schema)}.{Quote(objRoutine.Name)}({string.Join(", ", lstCallArgs)})";
        var strSql = boolProcedure ? $"CALL {strCall}" : $"SELECT * FROM {strCall}";

        // A refcursor only lives inside the transaction that opened it.
        await using var objTransaction = await objConn.BeginTransactionAsync(objCancelToken);
        var objMain = await RunAsync(objConn, objTransaction, strSql, intMaxRows, objCancelToken, [.. lstParams]);

        var lstResults = new List<ObjectSection>();
        var lstOutputs = new List<RoutineOutput>();
        var lstCursorColumns = Enumerable.Range(0, objMain.Columns.Count)
            .Where(intIndex => objMain.Columns[intIndex].DataType == "refcursor").ToList();

        if (lstCursorColumns.Count == 0)
        {
            var boolVoid = objMain.Columns.Count == 1 && objMain.Columns[0].DataType == "void";
            if (objMain.Columns.Count > 0 && !boolVoid) lstResults.Add(new ObjectSection("Result", objMain));
        }
        else
        {
            foreach (var arrRow in objMain.Rows)
            {
                for (var intIndex = 0; intIndex < arrRow.Length; intIndex++)
                {
                    if (!lstCursorColumns.Contains(intIndex))
                    {
                        lstOutputs.Add(new RoutineOutput(objMain.Columns[intIndex].Name, arrRow[intIndex]?.ToString()));
                        continue;
                    }
                    if (arrRow[intIndex] is not string strCursor) continue;

                    lstResults.Add(new ObjectSection(strCursor,
                        await FetchCursorAsync(objConn, objTransaction, strCursor, intMaxRows, objCancelToken)));
                }
            }
            if (lstResults.Count == 1) lstResults[0] = lstResults[0] with { Title = "Result" };
        }

        await objTransaction.CommitAsync(objCancelToken);
        return new RoutineResult(lstResults, lstOutputs, 0);
    }
}
