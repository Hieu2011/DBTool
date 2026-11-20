using System.Data.Common;
using System.Diagnostics;
using System.Globalization;
using DbStudio.Core;

namespace DbStudio.Providers;

/// <summary>
/// Shared logic for relational databases that have an ADO.NET driver.
/// Subclasses only supply the connection, the metadata SQL and driver quirks.
/// </summary>
public abstract partial class AdoProviderBase : IDbProvider
{
    private const long MaxSafeJsInteger = 9_007_199_254_740_991;

    public abstract DbKind Kind { get; }

    protected abstract DbConnection CreateConnection(ConnectionProfile objProfile);

    /// <summary>Must return columns in this order: schema, table, object type, column, data type.
    /// Rows must be ordered by schema, table, column position.</summary>
    protected abstract string MetadataSql { get; }

    protected virtual string PrepareSql(string strSql) => strSql;

    protected virtual object? ReadValue(DbDataReader objReader, int intOrdinal) => objReader.GetValue(intOrdinal);

    /// <summary>True when one failed statement aborts the whole transaction (PostgreSQL).</summary>
    protected virtual bool SavepointPerStatement => false;

    public virtual QueryError DescribeError(Exception objEx) => new(objEx.Message);

    public async Task TestAsync(ConnectionProfile objProfile, CancellationToken objCancelToken)
    {
        await using var objConn = CreateConnection(objProfile);
        await objConn.OpenAsync(objCancelToken);
    }

    public async Task<IDbSession> OpenSessionAsync(ConnectionProfile objProfile, CancellationToken objCancelToken)
    {
        var objConn = CreateConnection(objProfile);
        try { await objConn.OpenAsync(objCancelToken); }
        catch { await objConn.DisposeAsync(); throw; }
        return new AdoSession(this, objProfile, objConn);
    }

    public async Task<QueryResult> ExecuteAsync(ConnectionProfile objProfile, string strSql, int intMaxRows, CancellationToken objCancelToken,
        IRowSink? objSink = null)
    {
        await using var objConn = CreateConnection(objProfile);
        await objConn.OpenAsync(objCancelToken);
        return await ExecuteAutoCommitAsync(objConn, strSql, intMaxRows, objCancelToken, objSink);
    }

    /// <summary>One statement outside any transaction. Providers override it to wrap the statement when it needs one.</summary>
    protected virtual Task<QueryResult> ExecuteAutoCommitAsync(DbConnection objConn, string strSql, int intMaxRows,
        CancellationToken objCancelToken, IRowSink? objSink = null) =>
        ExecuteOnAsync(objConn, null, strSql, intMaxRows, objCancelToken, objSink: objSink);

    /// <summary>Parameters the driver must add for SQL typed in the editor (Oracle: cursor placeholders).</summary>
    protected virtual void BindEditorParameters(DbCommand objCmd) { }

    /// <summary>Cursors the command handed back through its parameters, read as result sets.</summary>
    protected virtual Task<List<QueryResult>> ReadOutputCursorsAsync(DbCommand objCmd, int intMaxRows, CancellationToken objCancelToken) =>
        Task.FromResult(new List<QueryResult>());

    /// <summary>First result becomes the statement's result, the rest go to More. Null when the list is empty.</summary>
    protected static QueryResult? Combine(List<QueryResult> lstResults)
    {
        if (lstResults.Count == 0) return null;
        if (lstResults.Count > 1) lstResults[0].More = lstResults[1..];
        return lstResults[0];
    }

    /// <summary>objBind: binds the object's schema/name/signature to the parameters the SQL uses (catalog queries).</summary>
    private async Task<QueryResult> ExecuteOnAsync(DbConnection objConn, DbTransaction? objTransaction, string strSql, int intMaxRows,
        CancellationToken objCancelToken, DbObjectInfo? objBind = null, (string Name, string? Value)[]? arrParams = null,
        IRowSink? objSink = null)
    {
        var objStopwatch = Stopwatch.StartNew();
        var objResult = new QueryResult();

        await using var objCmd = objConn.CreateCommand();
        objCmd.Transaction = objTransaction;
        objCmd.CommandText = PrepareSql(strSql);
        objCmd.CommandTimeout = 0; // the Stop button is the timeout
        if (objBind is not null) BindObject(objCmd, objBind);
        if (arrParams is not null) BindParams(objCmd, arrParams);
        var boolEditorSql = objBind is null && arrParams is null;
        if (boolEditorSql) BindEditorParameters(objCmd);

        // Not every driver honours the token on its own; DbCommand.Cancel() works for both.
        using var objCancelReg = objCancelToken.Register(() => { try { objCmd.Cancel(); } catch { /* already finished */ } });

        DbDataReader? objReader = null;
        try
        {
            objReader = await objCmd.ExecuteReaderAsync(objCancelToken);
            await ReadRowsAsync(objReader, objResult, intMaxRows, objCancelToken, objSink);
        }
        finally
        {
            if (objReader is not null)
            {
                // Without Cancel(), disposing the reader drains every remaining row from the server.
                if (objResult.Truncated) { try { objCmd.Cancel(); } catch { } }
                try { await objReader.DisposeAsync(); }
                catch when (objResult.Truncated) { /* cancel error from the drain, expected */ }
                objResult.RecordsAffected = objReader.RecordsAffected;
            }
        }

        // A block that only hands back cursors shows them instead of its empty result.
        if (boolEditorSql && objResult.Columns.Count == 0
            && Combine(await ReadOutputCursorsAsync(objCmd, intMaxRows, objCancelToken)) is { } objCursors)
            objResult = objCursors;

        objResult.ElapsedMs = objStopwatch.ElapsedMilliseconds;
        return objResult;
    }

    public async Task StreamAsync(ConnectionProfile objProfile, string strSql, IRowSink objSink, CancellationToken objCancelToken)
    {
        await using var objConn = CreateConnection(objProfile);
        await objConn.OpenAsync(objCancelToken);

        await using var objCmd = objConn.CreateCommand();
        objCmd.CommandText = PrepareSql(strSql);
        objCmd.CommandTimeout = 0; // the Stop button is the timeout
        using var objCancelReg = objCancelToken.Register(() => { try { objCmd.Cancel(); } catch { /* already finished */ } });

        DbDataReader? objReader = null;
        var boolReadAll = false;
        try
        {
            objReader = await objCmd.ExecuteReaderAsync(objCancelToken);
            var lstColumns = new List<ResultColumn>(objReader.FieldCount);
            for (var intIndex = 0; intIndex < objReader.FieldCount; intIndex++)
                lstColumns.Add(new ResultColumn(objReader.GetName(intIndex), objReader.GetDataTypeName(intIndex)));
            objSink.Begin(lstColumns);

            var arrRow = new object?[objReader.FieldCount];
            boolReadAll = true;
            while (await objReader.ReadAsync(objCancelToken))
            {
                for (var intIndex = 0; intIndex < arrRow.Length; intIndex++)
                    arrRow[intIndex] = objReader.IsDBNull(intIndex) ? null : Normalize(ReadValue(objReader, intIndex));
                if (!objSink.Write(arrRow)) { boolReadAll = false; break; }
            }
        }
        catch
        {
            boolReadAll = false;
            throw;
        }
        finally
        {
            if (objReader is not null)
            {
                // Stopped early (sink full, error, cancel): without Cancel() the dispose drains the rest from the server.
                if (!boolReadAll) { try { objCmd.Cancel(); } catch { } }
                try { await objReader.DisposeAsync(); }
                catch when (!boolReadAll) { /* cancel error from the drain, expected */ }
            }
        }
    }

    /// <summary>Columns and up to intMaxRows rows of the reader's current result set. Sets Truncated when more remain.
    /// With a sink the rows go there (each in its own array) and objResult keeps only the columns.</summary>
    protected async Task ReadRowsAsync(DbDataReader objReader, QueryResult objResult, int intMaxRows, CancellationToken objCancelToken,
        IRowSink? objSink = null)
    {
        if (objReader.FieldCount == 0) return;
        for (var intIndex = 0; intIndex < objReader.FieldCount; intIndex++)
            objResult.Columns.Add(new ResultColumn(objReader.GetName(intIndex), objReader.GetDataTypeName(intIndex)));
        objSink?.Begin(objResult.Columns);

        var intCount = 0;
        while (await objReader.ReadAsync(objCancelToken))
        {
            if (intCount >= intMaxRows) { objResult.Truncated = true; break; }
            var arrRow = new object?[objReader.FieldCount];
            for (var intIndex = 0; intIndex < arrRow.Length; intIndex++)
                arrRow[intIndex] = objReader.IsDBNull(intIndex) ? null : Normalize(ReadValue(objReader, intIndex));
            intCount++;
            if (objSink is null) objResult.Rows.Add(arrRow);
            else objSink.Write(arrRow);
        }
    }

    public async Task<SchemaMetadata> LoadMetadataAsync(ConnectionProfile objProfile, string? strSchema, CancellationToken objCancelToken)
    {
        await using var objConn = CreateConnection(objProfile);
        await objConn.OpenAsync(objCancelToken);

        var lstTables = new List<TableMeta>();
        await using (var objCmd = objConn.CreateCommand())
        {
            objCmd.CommandText = MetadataSql;
            objCmd.CommandTimeout = 120;
            BindParams(objCmd, ("schema", strSchema));

            var dicIndex = new Dictionary<(string, string), TableMeta>();
            await using var objReader = await objCmd.ExecuteReaderAsync(objCancelToken);
            while (await objReader.ReadAsync(objCancelToken))
            {
                var objKey = (objReader.GetString(0), objReader.GetString(1));
                if (!dicIndex.TryGetValue(objKey, out var objTable))
                {
                    objTable = new TableMeta(objKey.Item1, objKey.Item2, objReader.GetString(2), []);
                    dicIndex[objKey] = objTable;
                    lstTables.Add(objTable);
                }
                var strColumn = objReader.GetString(3);
                if (!objTable.Columns.Exists(objCol => objCol.Name == strColumn)) // Oracle can list a column twice (mview + table)
                    objTable.Columns.Add(new ColumnMeta(strColumn, objReader.IsDBNull(4) ? "" : objReader.GetString(4)));
            }
        }

        // Autocomplete only needs the tables: a failure here must not cost the user that.
        List<DbObjectInfo> lstObjects = [];
        string? strObjectsError = null;
        try { lstObjects = await LoadObjectListAsync(objConn, strSchema, objCancelToken); }
        catch (DbException objEx) { strObjectsError = DescribeError(objEx).Message; }

        // A named schema is a part to merge into what the caller already has.
        var (lstSchemas, lstLoaded) = strSchema is null
            ? await LoadSchemaListAsync(objConn, objCancelToken)
            : (null, [strSchema]);

        return new SchemaMetadata(lstTables, DateTimeOffset.Now, lstObjects, strObjectsError, lstSchemas, lstLoaded);
    }

    /// <summary>Makes a value safe for JSON and for JavaScript numbers.</summary>
    protected static object? Normalize(object? objValue) => objValue switch
    {
        null or DBNull => null,
        string or bool or byte or short or int or float or double or TimeOnly or TimeSpan => objValue,
        // Readable in the grid; timestamptz arrives as UTC and is shown in local time.
        DateTime dtValue => (dtValue.Kind == DateTimeKind.Utc ? dtValue.ToLocalTime() : dtValue)
            .ToString("yyyy-MM-dd HH:mm:ss.FFFFFF", CultureInfo.InvariantCulture).TrimEnd('.'),
        DateTimeOffset dtOffset => dtOffset.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss.FFFFFF zzz", CultureInfo.InvariantCulture),
        DateOnly dtDate => dtDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        long lngValue => Math.Abs(lngValue) <= MaxSafeJsInteger ? lngValue : lngValue.ToString(CultureInfo.InvariantCulture),
        decimal decValue => decValue.ToString(CultureInfo.InvariantCulture), // keep full precision
        Guid guidValue => guidValue.ToString(),
        byte[] arrBytes => "0x" + Convert.ToHexString(arrBytes, 0, Math.Min(arrBytes.Length, 64)) + (arrBytes.Length > 64 ? $"… ({arrBytes.Length} bytes)" : ""),
        Array arrItems => string.Join(", ", arrItems.Cast<object?>().Select(objItem => Normalize(objItem)?.ToString() ?? "NULL")),
        _ => Convert.ToString(objValue, CultureInfo.InvariantCulture),
    };
}
