using System.Collections.Concurrent;
using System.Diagnostics;
using DbStudio.Core;
using MongoDB.Bson;
using MongoDB.Driver;

namespace DbStudio.Providers;

/// <summary>
/// MongoDB. Databases play the part of schemas (loaded one at a time), collections that of tables;
/// their "columns" are the fields seen in a sample of documents. Statements are mongo shell call
/// chains (see MongoShell); anything more is run as JavaScript by ScriptHost.
/// </summary>
public sealed partial class MongoProvider : IDbProvider
{
    private const int SampleSize = 100;
    private const int MaxSampledCollections = 300;
    private const int MaxFieldsPerCollection = 300;
    private const int MaxFieldDepth = 3;
    private static readonly TimeSpan SampleTimeout = TimeSpan.FromSeconds(3);
    private static readonly string[] SystemDatabases = ["admin", "local", "config"];

    // A MongoClient owns a connection pool and is meant to be shared. Keyed by the full URL (memory only).
    private readonly ConcurrentDictionary<string, MongoClient> _dicClients = new();

    public DbKind Kind => DbKind.MongoDb;

    private MongoClient ClientFor(ConnectionProfile objProfile)
    {
        var strHost = objProfile.Host.Trim();
        var boolSrv = strHost.StartsWith("mongodb+srv://", StringComparison.OrdinalIgnoreCase);
        strHost = strHost.Replace("mongodb+srv://", "", StringComparison.OrdinalIgnoreCase)
            .Replace("mongodb://", "", StringComparison.OrdinalIgnoreCase).TrimEnd('/');

        var strUser = string.IsNullOrEmpty(objProfile.Username)
            ? ""
            : $"{Uri.EscapeDataString(objProfile.Username)}:{Uri.EscapeDataString(objProfile.Password ?? "")}@";
        // An SRV name carries no port.
        var strAddress = boolSrv ? strHost : $"{strHost}:{(objProfile.Port > 0 ? objProfile.Port : 27017)}";
        var strOptions = (objProfile.Extra ?? "").Trim().TrimStart('?').Replace(';', '&');
        var strUrl = $"{(boolSrv ? "mongodb+srv" : "mongodb")}://{strUser}{strAddress}/{(strOptions.Length > 0 ? "?" + strOptions : "")}";

        return _dicClients.GetOrAdd(strUrl, static strKey =>
        {
            var objSettings = MongoClientSettings.FromUrl(new MongoUrl(strKey));
            objSettings.ApplicationName ??= "DbStudio";
            // The driver waits 30 s by default before saying a server is unreachable.
            if (!strKey.Contains("serverSelectionTimeout", StringComparison.OrdinalIgnoreCase))
                objSettings.ServerSelectionTimeout = TimeSpan.FromSeconds(10);
            if (!strKey.Contains("connectTimeout", StringComparison.OrdinalIgnoreCase))
                objSettings.ConnectTimeout = TimeSpan.FromSeconds(10);
            return new MongoClient(objSettings);
        });
    }

    public async Task TestAsync(ConnectionProfile objProfile, CancellationToken objCancelToken)
    {
        var objDatabase = ClientFor(objProfile).GetDatabase(string.IsNullOrWhiteSpace(objProfile.Database) ? "admin" : objProfile.Database);
        await objDatabase.RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1), cancellationToken: objCancelToken);
    }

    /// <summary>The database a statement runs in when it names none.</summary>
    private static string DefaultDatabase(ConnectionProfile objProfile) =>
        string.IsNullOrWhiteSpace(objProfile.Database) ? "test" : objProfile.Database.Trim();

    public Task<IDbSession> OpenSessionAsync(ConnectionProfile objProfile, CancellationToken objCancelToken) =>
        Task.FromResult<IDbSession>(new MongoSession(this, ClientFor(objProfile), DefaultDatabase(objProfile)));

    public async Task<QueryResult> ExecuteAsync(ConnectionProfile objProfile, string strSql, int intMaxRows, CancellationToken objCancelToken,
        IRowSink? objSink = null)
    {
        // The sink is not used: a document result is shaped (columns = the fields found) only once it is complete.
        var (objResult, _) = await RunAsync(ClientFor(objProfile), DefaultDatabase(objProfile), strSql, intMaxRows, objCancelToken);
        return objResult;
    }

    public Task<RoutineInfo> LoadRoutineAsync(ConnectionProfile objProfile, DbObjectInfo objRoutine, CancellationToken objCancelToken) =>
        throw new NotSupportedException("MongoDB has no procedures or functions to execute.");

    public Task<RoutineResult> ExecuteRoutineAsync(ConnectionProfile objProfile, DbObjectInfo objRoutine,
        IReadOnlyList<RoutineArgument> lstArguments, int intMaxRows, CancellationToken objCancelToken) =>
        throw new NotSupportedException("MongoDB has no procedures or functions to execute.");

    public QueryError DescribeError(Exception objEx) => objEx switch
    {
        MongoCommandException objCommandEx => new QueryError(objCommandEx.ErrorMessage ?? objCommandEx.Message, null,
            objCommandEx.CodeName ?? objCommandEx.Code.ToString()),
        MongoWriteException objWriteEx => new QueryError(objWriteEx.WriteError?.Message ?? objWriteEx.Message, null,
            objWriteEx.WriteError?.Code.ToString()),
        MongoBulkWriteException objBulkEx => new QueryError(objBulkEx.WriteErrors.FirstOrDefault()?.Message ?? objBulkEx.Message),
        MongoShellException { Code: { } strCode } => new QueryError(objEx.Message, null, strCode),
        MongoAuthenticationException => new QueryError("Authentication failed. Check the user, the password and authSource (Extra options)."),
        // The driver appends its whole view of the cluster: keep the sentence that says what happened.
        TimeoutException or MongoConnectionException => new QueryError(FirstSentence(objEx.Message)),
        _ => new QueryError(objEx.Message),
    };

    private static string FirstSentence(string strMessage)
    {
        var intCut = strMessage.IndexOf(" Client view of cluster state", StringComparison.Ordinal);
        return intCut > 0 ? strMessage[..intCut] : strMessage;
    }

    // ---------- metadata ----------
    public async Task<SchemaMetadata> LoadMetadataAsync(ConnectionProfile objProfile, string? strSchema, CancellationToken objCancelToken)
    {
        var objClient = ClientFor(objProfile);

        List<string>? lstDatabases = null;
        if (strSchema is null)
        {
            // listDatabases needs a privilege a user limited to one database may lack.
            try
            {
                using var objCursor = await objClient.ListDatabaseNamesAsync(objCancelToken);
                lstDatabases = await objCursor.ToListAsync(objCancelToken);
                lstDatabases.Sort(StringComparer.OrdinalIgnoreCase);
            }
            catch (MongoCommandException) when (!string.IsNullOrWhiteSpace(objProfile.Database))
            {
                lstDatabases = [objProfile.Database.Trim()];
            }
        }

        var strDatabase = strSchema
            ?? (string.IsNullOrWhiteSpace(objProfile.Database)
                ? lstDatabases!.FirstOrDefault(strName => !SystemDatabases.Contains(strName)) ?? lstDatabases!.FirstOrDefault()
                : objProfile.Database.Trim());
        if (strDatabase is null) return new SchemaMetadata([], DateTimeOffset.Now, [], null, lstDatabases ?? [], []);
        if (lstDatabases is not null && !lstDatabases.Contains(strDatabase)) lstDatabases.Insert(0, strDatabase);

        var objDatabase = objClient.GetDatabase(strDatabase);
        var lstCollections = new List<(string Name, bool View)>();
        using (var objCursor = await objDatabase.ListCollectionsAsync(cancellationToken: objCancelToken))
        {
            foreach (var objInfo in await objCursor.ToListAsync(objCancelToken))
                lstCollections.Add((objInfo["name"].AsString, objInfo.GetValue("type", "collection").AsString == "view"));
        }
        lstCollections.Sort((objLeft, objRight) => string.Compare(objLeft.Name, objRight.Name, StringComparison.OrdinalIgnoreCase));

        // Fields are a guess from a sample; a collection that cannot be sampled simply shows none.
        var arrColumns = new List<ColumnMeta>[lstCollections.Count];
        await Parallel.ForEachAsync(Enumerable.Range(0, lstCollections.Count),
            new ParallelOptions { MaxDegreeOfParallelism = 6, CancellationToken = objCancelToken },
            async (intIndex, objToken) =>
            {
                arrColumns[intIndex] = [];
                if (intIndex >= MaxSampledCollections) return;
                try
                {
                    var lstDocs = await SampleAsync(objDatabase, lstCollections[intIndex].Name, lstCollections[intIndex].View, SampleSize, objToken);
                    arrColumns[intIndex] = FieldsOf(lstDocs).Select(objField => new ColumnMeta(objField.Path, objField.Types)).ToList();
                }
                catch (Exception objEx) when (objEx is MongoException or TimeoutException) { }
            });

        var lstTables = lstCollections
            .Select((objItem, intIndex) => new TableMeta(strDatabase, objItem.Name, objItem.View ? "VIEW" : "COLLECTION", arrColumns[intIndex]))
            .ToList();
        return new SchemaMetadata(lstTables, DateTimeOffset.Now, [], null, lstDatabases, [strDatabase]);
    }

    private static async Task<List<BsonDocument>> SampleAsync(IMongoDatabase objDatabase, string strCollection, bool boolView, int intSize,
        CancellationToken objCancelToken)
    {
        var objCollection = objDatabase.GetCollection<BsonDocument>(strCollection);
        // $sample on a view runs the view's whole pipeline first: take its first documents instead.
        var objStage = boolView ? new BsonDocument("$limit", intSize) : new BsonDocument("$sample", new BsonDocument("size", intSize));
        using var objCursor = await objCollection.AggregateAsync<BsonDocument>(
            PipelineDefinition<BsonDocument, BsonDocument>.Create(new[] { objStage }),
            new AggregateOptions { MaxTime = SampleTimeout }, objCancelToken);
        return await objCursor.ToListAsync(objCancelToken);
    }

    private sealed record FieldInfo(string Path, string Types, int Count);

    /// <summary>Field paths (nested documents as a.b) in first-seen order, with the BSON types met.</summary>
    private static List<FieldInfo> FieldsOf(List<BsonDocument> lstDocs)
    {
        var lstOrder = new List<string>();
        var dicTypes = new Dictionary<string, (SortedSet<string> Types, int Count)>();

        void Visit(BsonDocument objDoc, string strPrefix, int intDepth)
        {
            foreach (var objElement in objDoc)
            {
                var strPath = strPrefix + objElement.Name;
                if (!dicTypes.TryGetValue(strPath, out var objSeen))
                {
                    if (lstOrder.Count >= MaxFieldsPerCollection) continue;
                    lstOrder.Add(strPath);
                    objSeen = ([], 0);
                }
                objSeen.Types.Add(TypeName(objElement.Value));
                dicTypes[strPath] = (objSeen.Types, objSeen.Count + 1);
                if (objElement.Value is BsonDocument objChild && intDepth < MaxFieldDepth) Visit(objChild, strPath + ".", intDepth + 1);
            }
        }

        foreach (var objDoc in lstDocs) Visit(objDoc, "", 1);
        return lstOrder.Select(strPath => new FieldInfo(strPath, string.Join(" | ", dicTypes[strPath].Types), dicTypes[strPath].Count)).ToList();
    }

    private static string TypeName(BsonValue objValue) => objValue.BsonType switch
    {
        BsonType.ObjectId => "objectId",
        BsonType.DateTime => "date",
        BsonType.Document => "object",
        _ => char.ToLowerInvariant(objValue.BsonType.ToString()[0]) + objValue.BsonType.ToString()[1..],
    };

    // ---------- object viewer ----------
    public async Task<ObjectDetail> LoadObjectAsync(ConnectionProfile objProfile, DbObjectInfo objObject, bool boolFull, string? strSection,
        CancellationToken objCancelToken)
    {
        var objDatabase = ClientFor(objProfile).GetDatabase(objObject.Schema);
        var objCollection = objDatabase.GetCollection<BsonDocument>(objObject.Name);
        var boolView = objObject.Type == "VIEW";
        var lstSections = new List<ObjectSection>();
        bool Wanted(string strTitle) => strSection is null || strSection == strTitle;

        var lstIndexes = new List<BsonDocument>();
        if (!boolView && (Wanted("Indexes") || boolFull))
        {
            using var objCursor = await objCollection.Indexes.ListAsync(objCancelToken);
            lstIndexes = await objCursor.ToListAsync(objCancelToken);
        }
        if (!boolView && Wanted("Indexes"))
        {
            var objGrid = Grid("index", "keys", "unique", "options");
            foreach (var objIndex in lstIndexes)
            {
                var objOptions = new BsonDocument(objIndex.Where(objElement => objElement.Name is not ("v" or "key" or "name" or "ns" or "unique")));
                objGrid.Rows.Add([
                    objIndex.GetValue("name", "").ToString(), ShellJson(objIndex.GetValue("key", new BsonDocument()), false),
                    objIndex.GetValue("unique", false).ToBoolean(), objOptions.ElementCount == 0 ? null : ShellJson(objOptions, false),
                ]);
            }
            lstSections.Add(new ObjectSection("Indexes", objGrid));
        }

        // Only for the viewer: the tree shows the fields the metadata already sampled.
        if ((boolFull && strSection is null) || strSection == "Fields")
        {
            var lstDocs = await SampleAsync(objDatabase, objObject.Name, boolView, SampleSize * 2, objCancelToken);
            var objGrid = Grid("field", "type", "present");
            foreach (var objField in FieldsOf(lstDocs))
                objGrid.Rows.Add([objField.Path, objField.Types, lstDocs.Count == 0 ? null : $"{objField.Count * 100 / lstDocs.Count}%"]);
            lstSections.Insert(0, new ObjectSection("Fields", objGrid));
        }

        if (!boolFull || strSection is not null) return new ObjectDetail(lstSections, null);

        string? strDdl = null, strDdlError = null;
        try { strDdl = await BuildScriptAsync(objDatabase, objObject.Name, lstIndexes, objCancelToken); }
        catch (MongoException objEx) { strDdlError = DescribeError(objEx).Message; }
        return new ObjectDetail(lstSections, strDdl, strDdlError);
    }

    private static QueryResult Grid(params string[] arrColumns)
    {
        var objGrid = new QueryResult();
        foreach (var strColumn in arrColumns) objGrid.Columns.Add(new ResultColumn(strColumn, ""));
        return objGrid;
    }

    /// <summary>The shell commands that would create the collection and its indexes again.</summary>
    private static async Task<string> BuildScriptAsync(IMongoDatabase objDatabase, string strCollection, List<BsonDocument> lstIndexes,
        CancellationToken objCancelToken)
    {
        using var objCursor = await objDatabase.ListCollectionsAsync(
            new ListCollectionsOptions { Filter = new BsonDocument("name", strCollection) }, objCancelToken);
        var objInfo = (await objCursor.ToListAsync(objCancelToken)).FirstOrDefault();
        var objOptions = objInfo?.GetValue("options", new BsonDocument()).AsBsonDocument ?? [];
        var strName = ShellJson(strCollection, false);

        var lstLines = new List<string>
        {
            objOptions.ElementCount == 0 ? $"db.createCollection({strName});" : $"db.createCollection({strName}, {ShellJson(objOptions, true)});",
        };
        foreach (var objIndex in lstIndexes.Where(objIndex => objIndex.GetValue("name", "").ToString() != "_id_"))
        {
            var objIndexOptions = new BsonDocument(objIndex.Where(objElement => objElement.Name is not ("v" or "key" or "ns")));
            lstLines.Add($"db.getCollection({strName}).createIndex({ShellJson(objIndex["key"], false)}, {ShellJson(objIndexOptions, false)});");
        }
        return string.Join("\n\n", lstLines);
    }

    /// <summary>
    /// One editor tab: remembers the database chosen with "use" and, with auto-commit off, holds a multi-document
    /// transaction (replica set or sharded cluster only). Document reads and writes join it; DDL and commands run outside.
    /// </summary>
    private sealed class MongoSession(MongoProvider objProvider, MongoClient objClient, string strInitialDatabase) : IDbSession
    {
        private const int IllegalOperation = 20; // "Transaction numbers are only allowed on a replica set member or mongos"
        private readonly ScriptHost _objHost = new(objProvider); // the tab's JavaScript variables live here
        private string _strDatabase = strInitialDatabase;
        private IClientSessionHandle? _objTx;

        public bool InTransaction => _objTx is { IsInTransaction: true };

        public async Task<QueryResult> ExecuteAsync(string strSql, int intMaxRows, bool boolAutoCommit, CancellationToken objCancelToken,
            IRowSink? objSink = null)
        {
            var objStopwatch = Stopwatch.StartNew();
            if (!boolAutoCommit && !InTransaction)
            {
                _objTx ??= await objClient.StartSessionAsync(cancellationToken: objCancelToken);
                _objTx.StartTransaction();
            }

            QueryResult objResult;
            string strDatabase;
            try
            {
                (objResult, strDatabase) = await objProvider.RunAsync(objClient, _strDatabase, strSql, intMaxRows, objCancelToken,
                    InTransaction ? _objTx : null, _objHost);
            }
            catch (Exception objEx) when (InTransaction && objEx is MongoException or OperationCanceledException or MongoShellException)
            {
                // A script reports the server's error as its own: the host remembers the original.
                var objServerError = objEx as MongoException ?? (objEx is MongoShellException ? _objHost.DatabaseError : null);
                if (objEx is MongoShellException && objServerError is null) throw; // never reached the server: the transaction is intact
                // The server aborts a transaction on any error: drop ours too, the next statement starts a new one.
                await AbortAsync();
                if (objServerError is MongoCommandException { Code: IllegalOperation })
                    throw new MongoShellException("Transactions need a replica set or a sharded cluster; this server is a standalone. " +
                        "Switch back to Auto-commit.", "TransactionsUnavailable");
                if (objEx is OperationCanceledException) throw;
                throw new MongoShellException($"{objProvider.DescribeError(objEx).Message}\nThe transaction was rolled back: MongoDB aborts it on any error.");
            }
            if (InTransaction && _objHost.DatabaseError is { } objCaught)
            {
                // The script caught the error and went on, but the server had already aborted the transaction.
                await AbortAsync();
                throw new MongoShellException($"{objProvider.DescribeError(objCaught).Message}\n" +
                    "The script caught this error, but MongoDB aborts a transaction on any error: it was rolled back.");
            }
            _strDatabase = strDatabase;
            objResult.ElapsedMs = objStopwatch.ElapsedMilliseconds;
            return objResult;
        }

        private async Task AbortAsync()
        {
            if (_objTx is null) return;
            try
            {
                if (_objTx.IsInTransaction) await _objTx.AbortTransactionAsync(CancellationToken.None);
            }
            catch (Exception objEx) when (objEx is MongoException or TimeoutException) { /* already gone on the server */ }
            _objTx.Dispose();
            _objTx = null;
        }

        public async Task CommitAsync(CancellationToken objCancelToken)
        {
            if (!InTransaction) return;
            try { await _objTx!.CommitTransactionAsync(objCancelToken); }
            finally
            {
                _objTx!.Dispose();
                _objTx = null;
            }
        }

        public Task RollbackAsync(CancellationToken objCancelToken) => AbortAsync();

        public async ValueTask DisposeAsync() => await AbortAsync();
    }
}
