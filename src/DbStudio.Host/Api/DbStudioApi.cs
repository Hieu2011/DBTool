using System.Text.Json;
using DbStudio.Core;
using DbStudio.Host.Services;
using DbStudio.Providers;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace DbStudio.Host.Api;

internal static class DbStudioApi
{
    public static void MapDbStudioApi(this WebApplication objApp)
    {
        var objApi = objApp.MapGroup("/api");

        objApi.MapGet("/info", (ProviderRegistry objProviders) => new
        {
            version = typeof(DbStudioApi).Assembly.GetName().Version?.ToString(),
            supported = objProviders.Supported,
        });

        // ---------- connections ----------
        objApi.MapGet("/connections", (IConnectionStore objStore) =>
            objStore.List().Select(ConnectionDto.From));

        objApi.MapPost("/connections", async (ConnectionProfile objProfile, IConnectionStore objStore, MetadataCache objCache,
            SessionRegistry objSessions) =>
        {
            if (string.IsNullOrWhiteSpace(objProfile.Name)) return Results.BadRequest(new QueryError("Name is required."));
            var objSaved = objStore.Save(objProfile);
            objCache.Invalidate(objSaved.Id);
            await objSessions.CloseByConnectionAsync(objSaved.Id);
            return Results.Ok(ConnectionDto.From(objSaved));
        });

        objApi.MapDelete("/connections/{guidId:guid}", async (Guid guidId, IConnectionStore objStore, MetadataCache objCache,
            SessionRegistry objSessions, DiagramLayoutStore objLayouts, HistoryStore objHistory) =>
        {
            objCache.Invalidate(guidId);
            await objSessions.CloseByConnectionAsync(guidId);
            if (!objStore.Delete(guidId)) return Results.NotFound();
            objLayouts.RemoveConnection(guidId);
            objHistory.RemoveConnection(guidId);
            return Results.NoContent();
        });

        // ---------- self-update ----------
        objApi.MapGet("/update/config", (UpdateService objUpdates) => objUpdates.GetConfig());

        objApi.MapPut("/update/config", (UpdateConfigInput objInput, UpdateService objUpdates) =>
        {
            try { return Results.Ok(objUpdates.SaveConfig(objInput)); }
            catch (UpdateException objEx) { return Results.BadRequest(new QueryError(objEx.Message, null, objEx.Code)); }
        });

        objApi.MapPost("/update/check", async (UpdateService objUpdates, CancellationToken objCancelToken) =>
        {
            try { return Results.Ok(await objUpdates.CheckAsync(objCancelToken)); }
            catch (UpdateException objEx) { return Results.BadRequest(new QueryError(objEx.Message, null, objEx.Code)); }
        });

        // Downloads, verifies, swaps the exe and restarts. Not tied to the request: closing the dialog must not leave half an update.
        objApi.MapPost("/update/apply", async (UpdateService objUpdates) =>
        {
            try
            {
                await objUpdates.ApplyAsync(CancellationToken.None);
                return Results.NoContent();
            }
            catch (UpdateException objEx) { return Results.BadRequest(new QueryError(objEx.Message, null, objEx.Code)); }
        });

        objApi.MapGet("/update/progress", (UpdateService objUpdates) =>
            objUpdates.Progress is { } objProgress ? Results.Ok(objProgress) : Results.NoContent());

        // ---------- settings (sidebar width...) ----------
        objApi.MapGet("/settings", (SettingsStore objSettings) => objSettings.GetUi());

        // Merges: keys not sent are kept, a null value removes its key.
        objApi.MapPut("/settings", (Dictionary<string, JsonElement> dicValues, SettingsStore objSettings) =>
        {
            try
            {
                objSettings.MergeUi(dicValues);
                return Results.NoContent();
            }
            catch (ArgumentException objEx)
            {
                return Results.BadRequest(new QueryError(objEx.Message));
            }
        });

        // ---------- Redis key browser ----------
        objApi.MapGet("/connections/{guidId:guid}/redis/databases", async (Guid guidId, IConnectionStore objStore, RedisProvider objRedis,
            CancellationToken objCancelToken) =>
        {
            if (objStore.Get(guidId) is not { Kind: DbKind.Redis } objProfile) return Results.NotFound();
            try { return Results.Ok(await objRedis.ListDatabasesAsync(objProfile, objCancelToken)); }
            catch (Exception objEx) { return Results.BadRequest(objRedis.DescribeError(objEx)); }
        });

        // One SCAN page. cursor: the one the previous page returned; "0" (or none) starts over, "0" back means done.
        objApi.MapGet("/connections/{guidId:guid}/redis/keys", async (Guid guidId, [FromQuery(Name = "db")] int? intDatabase,
            [FromQuery(Name = "pattern")] string? strPattern, [FromQuery(Name = "cursor")] string? strCursor,
            IConnectionStore objStore, RedisProvider objRedis, CancellationToken objCancelToken) =>
        {
            if (objStore.Get(guidId) is not { Kind: DbKind.Redis } objProfile) return Results.NotFound();
            try { return Results.Ok(await objRedis.ScanKeysAsync(objProfile, intDatabase ?? 0, strPattern, strCursor, objCancelToken)); }
            catch (Exception objEx) { return Results.BadRequest(objRedis.DescribeError(objEx)); }
        });

        // ---------- snippets ----------
        objApi.MapGet("/snippets", (SnippetStore objSnippets) => objSnippets.List());

        // Replaces the whole list; answers with the list as stored.
        objApi.MapPut("/snippets", (List<Snippet> lstSnippets, SnippetStore objSnippets) =>
        {
            try { return Results.Ok(objSnippets.Save(lstSnippets)); }
            catch (Exception objEx) when (objEx is ArgumentException or IOException or UnauthorizedAccessException)
            {
                return Results.BadRequest(new QueryError(objEx.Message));
            }
        });

        // ---------- workspace (editor tabs of the last run) ----------
        objApi.MapGet("/workspace", (WorkspaceStore objWorkspaces) =>
            objWorkspaces.Load() is { } objSaved ? Results.Json(objSaved) : Results.NoContent());

        objApi.MapPut("/workspace", (Workspace objWorkspace, WorkspaceStore objWorkspaces) =>
        {
            try { objWorkspaces.Save(objWorkspace); return Results.NoContent(); }
            catch (Exception objEx) when (objEx is IOException or UnauthorizedAccessException)
            {
                return Results.BadRequest(new QueryError(objEx.Message));
            }
        });

        // ---------- query history ----------
        objApi.MapGet("/connections/{guidId:guid}/history", (Guid guidId, HistoryStore objHistory) => objHistory.List(guidId, 500));

        objApi.MapDelete("/connections/{guidId:guid}/history", (Guid guidId, HistoryStore objHistory) =>
        {
            objHistory.RemoveConnection(guidId);
            return Results.NoContent();
        });

        objApi.MapPost("/history", (HistoryAddRequest objRequest, IConnectionStore objStore, HistoryStore objHistory) =>
        {
            if (objStore.Get(objRequest.ConnectionId) is null) return Results.NotFound();
            objHistory.Add(objRequest);
            return Results.NoContent();
        });

        // ---------- diagram layouts ----------
        // diagram: the UI's own name for one diagram, e.g. table|schema.name.
        objApi.MapGet("/connections/{guidId:guid}/diagram-layout", (Guid guidId, [FromQuery(Name = "diagram")] string strDiagram,
            DiagramLayoutStore objLayouts) => objLayouts.Get(guidId, strDiagram));

        objApi.MapPut("/connections/{guidId:guid}/diagram-layout", (Guid guidId, [FromQuery(Name = "diagram")] string strDiagram,
            Dictionary<string, DiagramPoint> dicBoxes, IConnectionStore objStore, DiagramLayoutStore objLayouts) =>
        {
            if (objStore.Get(guidId) is null) return Results.NotFound();
            try
            {
                objLayouts.Set(guidId, strDiagram, dicBoxes);
                return Results.NoContent();
            }
            catch (ArgumentException objEx)
            {
                return Results.BadRequest(new QueryError(objEx.Message));
            }
        });

        // Test a profile from the dialog, before (or without) saving it.
        objApi.MapPost("/connections/test", async (ConnectionProfile objProfile, IConnectionStore objStore, ProviderRegistry objProviders, CancellationToken objCancelToken) =>
        {
            if (string.IsNullOrEmpty(objProfile.Password) && objStore.Get(objProfile.Id) is { } objExisting)
                objProfile.Password = objExisting.Password;
            try
            {
                using var objTimeout = CancellationTokenSource.CreateLinkedTokenSource(objCancelToken);
                objTimeout.CancelAfter(TimeSpan.FromSeconds(20));
                await objProviders.Get(objProfile.Kind).TestAsync(objProfile, objTimeout.Token);
                return Results.Ok(new { ok = true });
            }
            catch (Exception objEx)
            {
                return Results.BadRequest(Describe(objProviders, objProfile.Kind, objEx));
            }
        });

        // ---------- metadata ----------
        // schema: also load that schema, for databases read one schema at a time (Oracle).
        objApi.MapGet("/connections/{guidId:guid}/metadata", async (Guid guidId, [FromQuery(Name = "refresh")] bool? boolRefresh,
            [FromQuery(Name = "schema")] string? strSchema,
            IConnectionStore objStore, ProviderRegistry objProviders, MetadataCache objCache, CancellationToken objCancelToken) =>
        {
            if (objStore.Get(guidId) is not { } objProfile) return Results.NotFound();
            try
            {
                var objProvider = objProviders.Get(objProfile.Kind);
                if (boolRefresh == true || !objCache.TryGet(guidId, out var objMeta))
                {
                    objMeta = await objProvider.LoadMetadataAsync(objProfile, null, objCancelToken);
                    objCache.Set(guidId, objMeta);
                }

                var boolNeedSchema = strSchema is not null && objMeta.Schemas is not null &&
                                     !(objMeta.LoadedSchemas?.Contains(strSchema) ?? false);
                if (boolNeedSchema)
                {
                    var objPart = await objProvider.LoadMetadataAsync(objProfile, strSchema, objCancelToken);
                    objMeta = objCache.Update(guidId, objMeta, objCurrent => objCurrent.Merge(objPart, strSchema!));
                }
                return Results.Ok(objMeta);
            }
            catch (Exception objEx)
            {
                return Results.BadRequest(Describe(objProviders, objProfile.Kind, objEx));
            }
        });

        // Detail grids + DDL of one object, for the object viewer.
        objApi.MapGet("/connections/{guidId:guid}/object", async (Guid guidId,
            [FromQuery(Name = "schema")] string strSchema, [FromQuery(Name = "name")] string strName,
            [FromQuery(Name = "type")] string strType, [FromQuery(Name = "signature")] string? strSignature,
            [FromQuery(Name = "ddl")] bool? boolDdl, [FromQuery(Name = "section")] string? strSection,
            IConnectionStore objStore, ProviderRegistry objProviders, CancellationToken objCancelToken) =>
        {
            if (objStore.Get(guidId) is not { } objProfile) return Results.NotFound();
            try
            {
                var objObject = new DbObjectInfo(strSchema, strName, strType, strSignature);
                return Results.Ok(await objProviders.Get(objProfile.Kind)
                    .LoadObjectAsync(objProfile, objObject, boolDdl != false, strSection, objCancelToken));
            }
            catch (Exception objEx)
            {
                return Results.BadRequest(Describe(objProviders, objProfile.Kind, objEx));
            }
        });

        // ---------- routines (Execute form) ----------
        objApi.MapGet("/connections/{guidId:guid}/routine", async (Guid guidId,
            [FromQuery(Name = "schema")] string strSchema, [FromQuery(Name = "name")] string strName,
            [FromQuery(Name = "type")] string strType, [FromQuery(Name = "signature")] string? strSignature,
            IConnectionStore objStore, ProviderRegistry objProviders, CancellationToken objCancelToken) =>
        {
            if (objStore.Get(guidId) is not { } objProfile) return Results.NotFound();
            try
            {
                var objRoutine = new DbObjectInfo(strSchema, strName, strType, strSignature);
                return Results.Ok(await objProviders.Get(objProfile.Kind).LoadRoutineAsync(objProfile, objRoutine, objCancelToken));
            }
            catch (Exception objEx)
            {
                return Results.BadRequest(Describe(objProviders, objProfile.Kind, objEx));
            }
        });

        // Cancelled like a query: POST /query/{queryId}/cancel.
        objApi.MapPost("/routine/execute", async (RoutineExecuteRequest objRequest, IConnectionStore objStore,
            ProviderRegistry objProviders, QueryRegistry objQueries, HttpContext objHttp) =>
        {
            if (objStore.Get(objRequest.ConnectionId) is not { } objProfile) return Results.NotFound();

            using var objCts = objQueries.Begin(objRequest.QueryId, objHttp.RequestAborted);
            try
            {
                var intMaxRows = Math.Clamp(objRequest.MaxRows, 1, 100_000);
                return Results.Ok(await objProviders.Get(objProfile.Kind)
                    .ExecuteRoutineAsync(objProfile, objRequest.Routine, objRequest.Arguments, intMaxRows, objCts.Token));
            }
            catch (Exception) when (objCts.IsCancellationRequested)
            {
                return Results.Json(new QueryError("Execution cancelled."), statusCode: StatusCodes.Status409Conflict);
            }
            catch (Exception objEx)
            {
                return Results.BadRequest(Describe(objProviders, objProfile.Kind, objEx));
            }
            finally
            {
                objQueries.End(objRequest.QueryId);
            }
        });

        // ---------- query ----------
        objApi.MapPost("/query", async (QueryRequest objRequest, IConnectionStore objStore, ProviderRegistry objProviders,
            QueryRegistry objQueries, SessionRegistry objSessions, HttpContext objHttp) =>
        {
            if (objStore.Get(objRequest.ConnectionId) is not { } objProfile) return Results.NotFound();
            if (string.IsNullOrWhiteSpace(objRequest.Sql)) return Results.BadRequest(new QueryError("Nothing to run."));

            using var objCts = objQueries.Begin(objRequest.QueryId, objHttp.RequestAborted);
            try
            {
                var intMaxRows = Math.Clamp(objRequest.MaxRows, 1, 100_000);
                var objProvider = objProviders.Get(objProfile.Kind);
                var objResult = objRequest.SessionId is { } guidSessionId
                    ? await objSessions.ExecuteAsync(guidSessionId, objProfile, objProvider, objRequest.Sql, intMaxRows, objRequest.AutoCommit, objCts.Token,
                        boolKeepOpen: objRequest.KeepOpen, intSkipRows: objRequest.SkipRows)
                    : await objProvider.ExecuteAsync(objProfile, objRequest.Sql, intMaxRows, objCts.Token);
                return Results.Ok(objResult);
            }
            catch (Exception) when (objCts.IsCancellationRequested)
            {
                return Results.Json(new QueryError("Query cancelled."), statusCode: StatusCodes.Status409Conflict);
            }
            catch (Exception objEx)
            {
                return Results.BadRequest(Describe(objProviders, objProfile.Kind, objEx));
            }
            finally
            {
                objQueries.End(objRequest.QueryId);
            }
        });

        // The next rows of a result a session kept open (QueryResult.Cursor). 410 + code CursorClosed: it is gone, the
        // UI falls back to running the statement again.
        objApi.MapPost("/query/more", async (FetchMoreRequest objRequest, QueryRegistry objQueries, SessionRegistry objSessions, HttpContext objHttp) =>
        {
            using var objCts = objQueries.Begin(objRequest.QueryId, objHttp.RequestAborted);
            try
            {
                var objResult = await objSessions.FetchMoreAsync(objRequest.SessionId, objRequest.Cursor, Math.Clamp(objRequest.MaxRows, 1, 100_000), objCts.Token);
                return objResult is null
                    ? Results.Json(new QueryError("The result is no longer open.", null, "CursorClosed"), statusCode: StatusCodes.Status410Gone)
                    : Results.Ok(objResult);
            }
            catch (Exception) when (objCts.IsCancellationRequested)
            {
                return Results.Json(new QueryError("Query cancelled."), statusCode: StatusCodes.Status409Conflict);
            }
            catch (Exception objEx)
            {
                return Results.BadRequest(new QueryError(objEx.Message));
            }
            finally
            {
                objQueries.End(objRequest.QueryId);
            }
        });

        // Same as /query, answered as NDJSON lines so the grid fills while rows arrive:
        // {t:"columns"}, {t:"rows"}..., then {t:"done", result, streamed} or {t:"error", error}. Always 200 once it starts.
        objApi.MapPost("/query/stream", async (QueryRequest objRequest, IConnectionStore objStore, ProviderRegistry objProviders,
            QueryRegistry objQueries, SessionRegistry objSessions, HttpContext objHttp, IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions> objJsonOptions) =>
        {
            if (objStore.Get(objRequest.ConnectionId) is not { } objProfile) return Results.NotFound();
            if (string.IsNullOrWhiteSpace(objRequest.Sql)) return Results.BadRequest(new QueryError("Nothing to run."));

            var objJson = objJsonOptions.Value.SerializerOptions;
            var objBody = objHttp.Response.Body;
            objHttp.Response.ContentType = "application/x-ndjson";
            var objSink = new ChannelRowSink();
            // Ends when the sink completes; only a dropped request stops it earlier.
            var objPump = QueryStream.PumpAsync(objSink.Reader, objBody, objJson, objHttp.RequestAborted);

            object objLast;
            using var objCts = objQueries.Begin(objRequest.QueryId, objHttp.RequestAborted);
            try
            {
                var intMaxRows = Math.Clamp(objRequest.MaxRows, 1, 100_000);
                var objProvider = objProviders.Get(objProfile.Kind);
                var objResult = objRequest.SessionId is { } guidSessionId
                    ? await objSessions.ExecuteAsync(guidSessionId, objProfile, objProvider, objRequest.Sql, intMaxRows, objRequest.AutoCommit, objCts.Token, objSink,
                        objRequest.KeepOpen)
                    : await objProvider.ExecuteAsync(objProfile, objRequest.Sql, intMaxRows, objCts.Token, objSink);
                objLast = new { t = "done", result = objResult, streamed = objSink.Started };
            }
            catch (Exception) when (objCts.IsCancellationRequested)
            {
                objLast = new { t = "error", error = new QueryError("Query cancelled.") };
            }
            catch (Exception objEx)
            {
                objLast = new { t = "error", error = Describe(objProviders, objProfile.Kind, objEx) };
            }
            finally
            {
                objQueries.End(objRequest.QueryId);
                objSink.Complete();
            }

            try
            {
                await objPump;
                await QueryStream.WriteLineAsync(objBody, objLast, objJson, objHttp.RequestAborted);
            }
            catch (Exception objEx) when (objEx is OperationCanceledException or IOException)
            {
                // The UI went away: nobody is left to answer.
            }
            return Results.Empty;
        });

        // ---------- SQL files (File menu) ----------
        // Open dialog; [] when cancelled.
        objApi.MapPost("/files/open", (SqlFiles objFiles) =>
        {
            try { return Results.Ok(objFiles.Open()); }
            catch (Exception objEx) when (objEx is IOException or UnauthorizedAccessException or InvalidOperationException)
            {
                return Results.BadRequest(new QueryError(objEx.Message));
            }
        });

        // Writes back to a file opened / saved before, or asks where to save. 204 = the Save dialog was cancelled.
        objApi.MapPost("/files/save", (SqlFileSaveRequest objRequest, SqlFiles objFiles) =>
        {
            try { return objFiles.Save(objRequest) is { } objSaved ? Results.Ok(objSaved) : Results.NoContent(); }
            catch (Exception objEx) when (objEx is IOException or UnauthorizedAccessException or InvalidOperationException)
            {
                return Results.BadRequest(new QueryError(objEx.Message));
            }
        });

        // ---------- export ----------
        // The Save dialog. 204 = the user cancelled. The returned path is the only one /export will write to.
        objApi.MapPost("/export/pick", (ExportPickRequest objRequest, ExportTargets objTargets) =>
            objTargets.Pick(objRequest.FileName, objRequest.Format) is { } strPicked
                ? Results.Ok(new ExportPickResult(strPicked))
                : Results.NoContent());

        // Rows go from the database straight into the picked file: no row limit, nothing kept in memory.
        // Stopped with POST /query/{queryId}/cancel like any query.
        objApi.MapPost("/export", async (ExportRequest objRequest, IConnectionStore objStore, ProviderRegistry objProviders,
            QueryRegistry objQueries, ExportTargets objTargets, HttpContext objHttp) =>
        {
            if (objStore.Get(objRequest.ConnectionId) is not { } objProfile) return Results.NotFound();
            if (string.IsNullOrWhiteSpace(objRequest.Sql)) return Results.BadRequest(new QueryError("Nothing to export."));
            if (string.IsNullOrWhiteSpace(objRequest.Path) || !objTargets.TryTake(objRequest.Path))
                return Results.BadRequest(new QueryError("Choose where to save the file first."));

            var strPath = Path.GetFullPath(objRequest.Path);
            var strFormat = Path.GetExtension(strPath).TrimStart('.').ToLowerInvariant();
            if (strFormat is not ("csv" or "xlsx")) return Results.BadRequest(new QueryError("The file must be .csv or .xlsx."));

            var objStopwatch = System.Diagnostics.Stopwatch.StartNew();
            var boolDone = false;
            using var objCts = objQueries.Begin(objRequest.QueryId, objHttp.RequestAborted);
            try
            {
                long lngRows;
                bool boolTruncated;
                using (IExportSink objSink = strFormat == "csv" ? new CsvExportSink(strPath) : new XlsxExportSink(strPath))
                {
                    await objProviders.Get(objProfile.Kind).StreamAsync(objProfile, objRequest.Sql, objSink, objCts.Token);
                    objSink.Complete();
                    (lngRows, boolTruncated) = (objSink.Rows, objSink.Truncated);
                }
                boolDone = true;
                objTargets.MarkExported(strPath);
                return Results.Ok(new ExportResult(strPath, lngRows, boolTruncated, objStopwatch.ElapsedMilliseconds));
            }
            catch (Exception) when (objCts.IsCancellationRequested)
            {
                return Results.Json(new QueryError("Export cancelled."), statusCode: StatusCodes.Status409Conflict);
            }
            catch (Exception objEx)
            {
                return Results.BadRequest(Describe(objProviders, objProfile.Kind, objEx));
            }
            finally
            {
                objQueries.End(objRequest.QueryId);
                if (!boolDone) { try { File.Delete(strPath); } catch (IOException) { /* still locked: a partial file is left behind */ } }
            }
        });

        // Opens Explorer on a file this app exported in this run; any other path is refused.
        objApi.MapPost("/export/reveal", (ExportRevealRequest objRequest, ExportTargets objTargets) =>
        {
            string strFull;
            try { strFull = Path.GetFullPath(objRequest.Path ?? ""); }
            catch (Exception objEx) when (objEx is ArgumentException or NotSupportedException or PathTooLongException)
            {
                return Results.BadRequest(new QueryError("Not a valid path."));
            }
            if (!objTargets.WasExported(strFull) || !File.Exists(strFull)) return Results.NotFound();

            using var objProcess = System.Diagnostics.Process.Start("explorer.exe", $"/select,\"{strFull}\"");
            return Results.NoContent();
        });

        // Where the columns of a SELECT come from, for editing in the grid. The statement is not run.
        objApi.MapPost("/query/describe", async (DescribeRequest objRequest, IConnectionStore objStore, ProviderRegistry objProviders,
            HttpContext objHttp) =>
        {
            if (objStore.Get(objRequest.ConnectionId) is not { } objProfile) return Results.NotFound();
            if (string.IsNullOrWhiteSpace(objRequest.Sql)) return Results.BadRequest(new QueryError("Nothing to describe."));
            try { return Results.Ok(await objProviders.Get(objProfile.Kind).DescribeResultAsync(objProfile, objRequest.Sql, objHttp.RequestAborted)); }
            catch (Exception objEx) { return Results.BadRequest(Describe(objProviders, objProfile.Kind, objEx)); }
        });

        objApi.MapPost("/query/{guidQueryId:guid}/cancel", (Guid guidQueryId, QueryRegistry objQueries) =>
            objQueries.Cancel(guidQueryId) ? Results.Accepted() : Results.NotFound());

        // ---------- sessions (one per editor tab) ----------
        // Connect button: opens the tab's session without running anything.
        objApi.MapPost("/sessions/{guidSessionId:guid}/open", async (Guid guidSessionId, SessionOpenRequest objRequest,
            IConnectionStore objStore, ProviderRegistry objProviders, SessionRegistry objSessions, CancellationToken objCancelToken) =>
        {
            if (objStore.Get(objRequest.ConnectionId) is not { } objProfile) return Results.NotFound();
            try
            {
                using var objTimeout = CancellationTokenSource.CreateLinkedTokenSource(objCancelToken);
                objTimeout.CancelAfter(TimeSpan.FromSeconds(30));
                await objSessions.OpenAsync(guidSessionId, objProfile, objProviders.Get(objProfile.Kind), objTimeout.Token);
                return Results.NoContent();
            }
            catch (OperationCanceledException)
            {
                return Results.BadRequest(new QueryError("Connecting was cancelled or timed out."));
            }
            catch (Exception objEx)
            {
                return Results.BadRequest(Describe(objProviders, objProfile.Kind, objEx));
            }
        });

        objApi.MapPost("/sessions/{guidSessionId:guid}/commit", (Guid guidSessionId, SessionRegistry objSessions, CancellationToken objCancelToken) =>
            EndTransactionAsync(objSessions, guidSessionId, true, objCancelToken));

        objApi.MapPost("/sessions/{guidSessionId:guid}/rollback", (Guid guidSessionId, SessionRegistry objSessions, CancellationToken objCancelToken) =>
            EndTransactionAsync(objSessions, guidSessionId, false, objCancelToken));

        objApi.MapDelete("/sessions/{guidSessionId:guid}", async (Guid guidSessionId, SessionRegistry objSessions) =>
        {
            await objSessions.CloseAsync(guidSessionId);
            return Results.NoContent();
        });
    }

    private static async Task<IResult> EndTransactionAsync(SessionRegistry objSessions, Guid guidSessionId, bool boolCommit, CancellationToken objCancelToken)
    {
        try
        {
            await objSessions.EndTransactionAsync(guidSessionId, boolCommit, objCancelToken);
            return Results.NoContent();
        }
        catch (Exception objEx)
        {
            return Results.BadRequest(new QueryError(objEx.Message));
        }
    }

    private static QueryError Describe(ProviderRegistry objProviders, DbKind enmKind, Exception objEx)
    {
        try { return objProviders.Get(enmKind).DescribeError(objEx); }
        catch (NotSupportedException) { return new QueryError(objEx.Message); }
    }
}
