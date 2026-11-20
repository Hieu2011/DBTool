using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using DbStudio.Core;
using MongoDB.Bson;
using MongoDB.Bson.IO;
using MongoDB.Driver;

namespace DbStudio.Providers;

public sealed partial class MongoProvider
{
    private const long MaxSafeJsInteger = 9_007_199_254_740_991;
    private const int MaxCellJsonLength = 20_000;
    private const string Supported =
        "find, findOne, aggregate, countDocuments, estimatedDocumentCount, distinct, insertOne, insertMany, updateOne, updateMany, " +
        "replaceOne, deleteOne, deleteMany, createIndex, dropIndex, getIndexes, stats, drop, renameCollection";

    private static readonly JsonWriterSettings FallbackJson = new() { OutputMode = JsonOutputMode.Shell };
    // Keeps Vietnamese and other non-ASCII text readable instead of escaped.
    private static readonly JsonSerializerOptions RelaxedText = new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    /// <summary>A value in mongo shell notation (ObjectId("..."), ISODate("..."), NumberLong(1)): what MongoShell reads back.</summary>
    /// boolScript: for the script engine, where the text is evaluated as JavaScript (longs keep every digit, exotic types stay opaque).
    private static string ShellJson(BsonValue objValue, bool boolIndent, bool boolScript = false)
    {
        var objText = new StringBuilder();
        WriteShell(objText, objValue, boolIndent, 0, boolScript);
        return objText.ToString();
    }

    // Written by hand: the driver's shell writer prints doubles with 17 digits (10.7 -> 10.699999999999999).
    private static void WriteShell(StringBuilder objText, BsonValue objValue, bool boolIndent, int intLevel, bool boolScript = false)
    {
        void NewLine(int intDepth)
        {
            if (boolIndent) objText.Append('\n').Append(' ', intDepth * 2);
        }

        switch (objValue)
        {
            case BsonDocument objDoc:
                if (objDoc.ElementCount == 0) { objText.Append("{}"); break; }
                objText.Append(boolIndent ? "{" : "{ ");
                for (var intIndex = 0; intIndex < objDoc.ElementCount; intIndex++)
                {
                    if (intIndex > 0) objText.Append(boolIndent ? "," : ", ");
                    NewLine(intLevel + 1);
                    objText.Append(JsonSerializer.Serialize(objDoc.GetElement(intIndex).Name, RelaxedText)).Append(": ");
                    WriteShell(objText, objDoc[intIndex], boolIndent, intLevel + 1, boolScript);
                }
                NewLine(intLevel);
                objText.Append(boolIndent ? "}" : " }");
                break;
            case BsonArray arrItems:
                if (arrItems.Count == 0) { objText.Append("[]"); break; }
                // Arrays of plain values stay on one line.
                var boolNested = boolIndent && arrItems.Any(objItem => objItem is BsonDocument or BsonArray);
                objText.Append('[');
                for (var intIndex = 0; intIndex < arrItems.Count; intIndex++)
                {
                    if (intIndex > 0) objText.Append(boolNested ? "," : ", ");
                    if (boolNested) NewLine(intLevel + 1);
                    WriteShell(objText, arrItems[intIndex], boolNested, intLevel + 1, boolScript);
                }
                if (boolNested) NewLine(intLevel);
                objText.Append(']');
                break;
            case BsonString objString: objText.Append(JsonSerializer.Serialize(objString.Value, RelaxedText)); break;
            case BsonInt32 objInt: objText.Append(objInt.Value.ToString(CultureInfo.InvariantCulture)); break;
            case BsonInt64 objLong:
                var strQuote = boolScript ? "\"" : "";
                objText.Append("NumberLong(").Append(strQuote).Append(objLong.Value.ToString(CultureInfo.InvariantCulture)).Append(strQuote).Append(')');
                break;
            case BsonDouble objDouble when double.IsFinite(objDouble.Value):
                var strNumber = objDouble.Value.ToString("R", CultureInfo.InvariantCulture);
                // 5 would read back as an int32.
                objText.Append(strNumber.Contains('.') || strNumber.Contains('E') ? strNumber : strNumber + ".0");
                break;
            case BsonDecimal128 objDecimal: objText.Append("NumberDecimal(\"").Append(objDecimal.Value.ToString()).Append("\")"); break;
            case BsonBoolean objBool: objText.Append(objBool.Value ? "true" : "false"); break;
            case BsonNull: objText.Append("null"); break;
            case BsonObjectId objId: objText.Append("ObjectId(\"").Append(objId.Value.ToString()).Append("\")"); break;
            case BsonDateTime objDate when objDate.IsValidDateTime:
                objText.Append("ISODate(\"")
                    .Append(objDate.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture)).Append("\")");
                break;
            case BsonDouble objDouble when boolScript:
                objText.Append(double.IsNaN(objDouble.Value) ? "NaN" : objDouble.Value > 0 ? "Infinity" : "-Infinity");
                break;
            case not null when boolScript: // JavaScript has no such type: the script carries it around as its shell text
                objText.Append("__raw(").Append(JsonSerializer.Serialize(objValue.ToJson(FallbackJson))).Append(')');
                break;
            default: objText.Append(objValue.ToJson(FallbackJson)); break; // binary, regex, timestamp, NaN...
        }
    }

    /// <summary>Runs one shell statement. Returns the result and the database later statements of the tab run in.</summary>
    /// objTx: the tab's open transaction; reads and writes of documents join it, everything else runs outside.
    /// objHost: the tab's script engine (variables live in it); none = a fresh one when the statement needs JavaScript.
    private async Task<(QueryResult Result, string Database)> RunAsync(MongoClient objClient, string strDatabase, string strText, int intMaxRows,
        CancellationToken objCancelToken, IClientSessionHandle? objTx = null, ScriptHost? objHost = null)
    {
        var objStopwatch = Stopwatch.StartNew();
        QueryResult objResult;
        var strNext = strDatabase;
        try
        {
            // A plain call chain runs directly. These failures all happen before anything is sent to the server.
            var objCommand = MongoShell.Parse(strText);
            objResult = await RunCommandAsync(objClient, strDatabase, objCommand, intMaxRows, objTx, objCancelToken);
            if (objCommand.Shell == "use") strNext = objCommand.ShellArg!;
        }
        catch (MongoShellException objEx) when (objEx.Code == MongoShellException.Script)
        {
            objResult = await (objHost ?? new ScriptHost(this)).RunAsync(objClient, strDatabase, strText, intMaxRows, objTx, objCancelToken);
        }
        objResult.ElapsedMs = objStopwatch.ElapsedMilliseconds;
        return (objResult, strNext);
    }

    private async Task<QueryResult> RunCommandAsync(MongoClient objClient, string strDatabase, MongoCommand objCommand, int intMaxRows,
        IClientSessionHandle? objTx, CancellationToken objCancelToken)
    {
        switch (objCommand.Shell)
        {
            case "use":
                return Rows(["database"], [[objCommand.ShellArg]]);
            case "dbs":
            {
                using var objCursor = await objClient.ListDatabasesAsync(objCancelToken);
                var lstDatabases = await objCursor.ToListAsync(objCancelToken);
                return Rows(["database", "sizeOnDisk"], lstDatabases.Select(objItem => new object?[]
                    { objItem["name"].AsString, Cell(objItem.GetValue("sizeOnDisk", BsonNull.Value)) }));
            }
            case "collections":
                return await CollectionNamesAsync(objClient.GetDatabase(strDatabase), objCancelToken);
        }

        var objDatabase = objClient.GetDatabase(objCommand.Database ?? strDatabase);
        return objCommand.Collection is null
            ? await RunDatabaseMethodAsync(objDatabase, objCommand, objCancelToken)
            : await RunCollectionMethodAsync(objDatabase, objCommand, intMaxRows, objTx, objCancelToken);
    }

    private static async Task<QueryResult> CollectionNamesAsync(IMongoDatabase objDatabase, CancellationToken objCancelToken)
    {
        using var objCursor = await objDatabase.ListCollectionsAsync(cancellationToken: objCancelToken);
        var lstCollections = await objCursor.ToListAsync(objCancelToken);
        var lstSorted = lstCollections.OrderBy(objItem => objItem["name"].AsString, StringComparer.OrdinalIgnoreCase).ToList();
        return WithRaw(
            Rows(["collection", "type"], lstSorted.Select(objItem => new object?[] { objItem["name"].AsString, objItem.GetValue("type", "collection").AsString })),
            new BsonArray(lstSorted.Select(objItem => objItem["name"])));
    }

    private static async Task<QueryResult> RunDatabaseMethodAsync(IMongoDatabase objDatabase, MongoCommand objCommand, CancellationToken objCancelToken)
    {
        var objCall = objCommand.Main;
        NoModifiers(objCommand);
        switch (objCall.Name)
        {
            case "getCollectionNames":
                return await CollectionNamesAsync(objDatabase, objCancelToken);
            case "getName":
                return WithRaw(Rows(["database"], [[objDatabase.DatabaseNamespace.DatabaseName]]), objDatabase.DatabaseNamespace.DatabaseName);
            case "stats":
                return Documents([await objDatabase.RunCommandAsync<BsonDocument>(new BsonDocument("dbStats", 1), cancellationToken: objCancelToken)], false);
            case "createCollection":
            {
                var objCreate = new BsonDocument("create", Text(objCall, 0));
                if (objCall.Document(1) is { } objOptions) objCreate.AddRange(objOptions);
                return Documents([await objDatabase.RunCommandAsync<BsonDocument>(objCreate, cancellationToken: objCancelToken)], false);
            }
            case "runCommand" or "adminCommand":
            {
                var objTarget = objCall.Name == "adminCommand" ? objDatabase.Client.GetDatabase("admin") : objDatabase;
                var objReply = await objTarget.RunCommandAsync<BsonDocument>(Required(objCall, 0), cancellationToken: objCancelToken);
                // A command that answers with a cursor (listIndexes, aggregate...) shows its first batch as rows.
                var boolBatch = objReply.TryGetValue("cursor", out var objCursor) && objCursor is BsonDocument objCursorDoc
                    && objCursorDoc.TryGetValue("firstBatch", out var objBatch) && objBatch is BsonArray;
                return boolBatch
                    ? Documents(objReply["cursor"]["firstBatch"].AsBsonArray.OfType<BsonDocument>().ToList(), false)
                    : Documents([objReply], false);
            }
            default:
                throw new MongoShellException(
                    $"db.{objCall.Name}() is not supported. On db: getCollectionNames, createCollection, runCommand, adminCommand, stats, getName, " +
                    "getSiblingDB, getCollection.", MongoShellException.Script);
        }
    }

    private static async Task<QueryResult> RunCollectionMethodAsync(IMongoDatabase objDatabase, MongoCommand objCommand, int intMaxRows,
        IClientSessionHandle? objTx, CancellationToken objCancelToken)
    {
        var strCollection = objCommand.Collection!;
        var objCollection = objDatabase.GetCollection<BsonDocument>(strCollection);
        var objCall = objCommand.Main;

        switch (objCall.Name)
        {
            case "find" or "findOne" or "aggregate":
            {
                // .count() after find() counts instead of reading.
                if (objCall.Name == "find" && objCommand.Calls.Skip(1).Any(objItem => objItem.Name is "count" or "countDocuments"))
                {
                    return Count(await CountAsync(objCollection, objCall.Document(0) ?? [], objTx, objCancelToken));
                }
                var (lstDocs, boolTruncated) = await ReadAsync(await OpenCursorAsync(objCollection, objCommand, intMaxRows + 1, objTx, objCancelToken),
                    intMaxRows, objCancelToken);
                return Documents(lstDocs, boolTruncated);
            }
            case "countDocuments" or "count":
                NoModifiers(objCommand);
                return Count(await CountAsync(objCollection, objCall.Document(0) ?? [], objTx, objCancelToken));
            case "estimatedDocumentCount":
                NoModifiers(objCommand);
                return Count(await objCollection.EstimatedDocumentCountAsync(cancellationToken: objCancelToken));
            case "distinct":
            {
                NoModifiers(objCommand);
                var strField = Text(objCall, 0);
                FilterDefinition<BsonDocument> objFilter = objCall.Document(1) ?? [];
                using var objCursor = objTx is null
                    ? await objCollection.DistinctAsync<BsonValue>(strField, objFilter, cancellationToken: objCancelToken)
                    : await objCollection.DistinctAsync<BsonValue>(objTx, strField, objFilter, cancellationToken: objCancelToken);
                var lstValues = await objCursor.ToListAsync(objCancelToken);
                var objGrid = Rows([strField], lstValues.Take(intMaxRows).Select(objValue => new object?[] { Cell(objValue) }));
                objGrid.Truncated = lstValues.Count > intMaxRows;
                return WithRaw(objGrid, new BsonArray(lstValues.Take(intMaxRows)));
            }
            case "insertOne":
            {
                NoModifiers(objCommand);
                var objDoc = Required(objCall, 0);
                if (objTx is null) await objCollection.InsertOneAsync(objDoc, cancellationToken: objCancelToken);
                else await objCollection.InsertOneAsync(objTx, objDoc, cancellationToken: objCancelToken);
                return Written(1, ("insertedId", objDoc.GetValue("_id", BsonNull.Value)));
            }
            case "insertMany":
            {
                NoModifiers(objCommand);
                if (objCall.Arg(0) is not BsonArray arrDocs || arrDocs.Count == 0 || arrDocs.Any(objItem => objItem is not BsonDocument))
                    throw new MongoShellException("insertMany() needs an array of documents: insertMany([{ ... }, { ... }]).");
                var lstDocs = arrDocs.Cast<BsonDocument>().ToList();
                if (objTx is null) await objCollection.InsertManyAsync(lstDocs, cancellationToken: objCancelToken);
                else await objCollection.InsertManyAsync(objTx, lstDocs, cancellationToken: objCancelToken);
                return Written(lstDocs.Count, ("insertedCount", lstDocs.Count));
            }
            case "updateOne" or "updateMany":
            {
                NoModifiers(objCommand);
                var objFilter = Required(objCall, 0);
                UpdateDefinition<BsonDocument> objUpdate = objCall.Arg(1) switch
                {
                    BsonDocument objDoc => objDoc,
                    BsonArray arrPipeline when arrPipeline.All(objStage => objStage is BsonDocument) =>
                        Builders<BsonDocument>.Update.Pipeline(PipelineDefinition<BsonDocument, BsonDocument>.Create(arrPipeline.Cast<BsonDocument>())),
                    _ => throw new MongoShellException($"{objCall.Name}() needs an update: {{ $set: {{ ... }} }} or a pipeline [ ... ]."),
                };
                var objOptions = new UpdateOptions { IsUpsert = objCall.Document(2)?.GetValue("upsert", false).ToBoolean() ?? false };
                var objDone = (objCall.Name == "updateOne", objTx) switch
                {
                    (true, null) => await objCollection.UpdateOneAsync(objFilter, objUpdate, objOptions, objCancelToken),
                    (true, _) => await objCollection.UpdateOneAsync(objTx, objFilter, objUpdate, objOptions, objCancelToken),
                    (false, null) => await objCollection.UpdateManyAsync(objFilter, objUpdate, objOptions, objCancelToken),
                    (false, _) => await objCollection.UpdateManyAsync(objTx, objFilter, objUpdate, objOptions, objCancelToken),
                };
                return Written(objDone.ModifiedCount + (objDone.UpsertedId is null ? 0 : 1), ("matchedCount", objDone.MatchedCount),
                    ("modifiedCount", objDone.ModifiedCount), ("upsertedId", objDone.UpsertedId ?? BsonNull.Value));
            }
            case "replaceOne":
            {
                NoModifiers(objCommand);
                var objOptions = new ReplaceOptions { IsUpsert = objCall.Document(2)?.GetValue("upsert", false).ToBoolean() ?? false };
                var objDone = objTx is null
                    ? await objCollection.ReplaceOneAsync(Required(objCall, 0), Required(objCall, 1), objOptions, objCancelToken)
                    : await objCollection.ReplaceOneAsync(objTx, Required(objCall, 0), Required(objCall, 1), objOptions, objCancelToken);
                return Written(objDone.ModifiedCount + (objDone.UpsertedId is null ? 0 : 1), ("matchedCount", objDone.MatchedCount),
                    ("modifiedCount", objDone.ModifiedCount), ("upsertedId", objDone.UpsertedId ?? BsonNull.Value));
            }
            case "deleteOne" or "deleteMany":
            {
                NoModifiers(objCommand);
                // No filter must never mean "everything" by accident.
                if (objCall.Args.Count == 0)
                    throw new MongoShellException($"{objCall.Name}() needs a filter. To delete every document write {objCall.Name}({{}}).");
                var objDone = (objCall.Name == "deleteOne", objTx) switch
                {
                    (true, null) => await objCollection.DeleteOneAsync(Required(objCall, 0), objCancelToken),
                    (true, _) => await objCollection.DeleteOneAsync(objTx, Required(objCall, 0), cancellationToken: objCancelToken),
                    (false, null) => await objCollection.DeleteManyAsync(Required(objCall, 0), objCancelToken),
                    (false, _) => await objCollection.DeleteManyAsync(objTx, Required(objCall, 0), cancellationToken: objCancelToken),
                };
                return Written(objDone.DeletedCount, ("deletedCount", objDone.DeletedCount));
            }
            case "getIndexes":
            {
                NoModifiers(objCommand);
                using var objCursor = await objCollection.Indexes.ListAsync(objCancelToken);
                return Documents(await objCursor.ToListAsync(objCancelToken), false);
            }
            case "createIndex":
            {
                NoModifiers(objCommand);
                var objKeys = Required(objCall, 0);
                var objIndex = new BsonDocument { { "key", objKeys } };
                if (objCall.Document(1) is { } objOptions) objIndex.AddRange(objOptions);
                if (!objIndex.Contains("name"))
                    objIndex["name"] = string.Join('_', objKeys.Select(objElement => $"{objElement.Name}_{objElement.Value}"));
                var objCreate = new BsonDocument { { "createIndexes", strCollection }, { "indexes", new BsonArray { objIndex } } };
                return Documents([await objDatabase.RunCommandAsync<BsonDocument>(objCreate, cancellationToken: objCancelToken)], false);
            }
            case "dropIndex":
            {
                NoModifiers(objCommand);
                var objIndex = objCall.Arg(0) ?? throw new MongoShellException("dropIndex() needs the index name or its keys.");
                var objDrop = new BsonDocument { { "dropIndexes", strCollection }, { "index", objIndex } };
                return Documents([await objDatabase.RunCommandAsync<BsonDocument>(objDrop, cancellationToken: objCancelToken)], false);
            }
            case "stats":
                NoModifiers(objCommand);
                return Documents([await objDatabase.RunCommandAsync<BsonDocument>(new BsonDocument("collStats", strCollection),
                    cancellationToken: objCancelToken)], false);
            case "drop":
                NoModifiers(objCommand);
                await objDatabase.DropCollectionAsync(strCollection, objCancelToken);
                return WithRaw(Rows(["dropped"], [[strCollection]]), true);
            case "renameCollection":
                NoModifiers(objCommand);
                await objDatabase.RenameCollectionAsync(strCollection, Text(objCall, 0), cancellationToken: objCancelToken);
                return WithRaw(Rows(["renamedTo"], [[Text(objCall, 0)]]), new BsonDocument("ok", 1));
            default:
                throw new MongoShellException($"{objCall.Name}() is not supported. On a collection: {Supported}.", MongoShellException.Script);
        }
    }

    /// <summary>find / findOne / aggregate with their modifiers, reading at most intLimit documents.</summary>
    private static async Task<IAsyncCursor<BsonDocument>> OpenCursorAsync(IMongoCollection<BsonDocument> objCollection, MongoCommand objCommand,
        int? intLimit, IClientSessionHandle? objTx, CancellationToken objCancelToken)
    {
        var objCall = objCommand.Main;
        if (objCall.Name == "aggregate")
        {
            if (objCall.Arg(0) is not BsonArray arrStages || arrStages.Any(objStage => objStage is not BsonDocument))
                throw new MongoShellException("aggregate() needs a pipeline: aggregate([{ $match: { ... } }, ...]).");
            foreach (var objModifier in objCommand.Calls.Skip(1))
                if (objModifier.Name is not ("toArray" or "pretty"))
                    throw new MongoShellException($".{objModifier.Name}() cannot follow aggregate(): add a stage to the pipeline instead.", MongoShellException.Script);
            var lstStages = arrStages.Cast<BsonDocument>().ToList();
            // Never append $limit after $out / $merge: they must stay last, and they return nothing anyway.
            var boolWrites = lstStages.Count > 0 && lstStages[^1].GetElement(0).Name is "$out" or "$merge";
            if (intLimit is { } intMax && !boolWrites) lstStages.Add(new BsonDocument("$limit", intMax));
            var objOptions = new AggregateOptions { AllowDiskUse = objCall.Document(1)?.GetValue("allowDiskUse", false).ToBoolean() };
            var objPipeline = PipelineDefinition<BsonDocument, BsonDocument>.Create(lstStages);
            return objTx is null
                ? await objCollection.AggregateAsync(objPipeline, objOptions, objCancelToken)
                : await objCollection.AggregateAsync(objTx, objPipeline, objOptions, objCancelToken);
        }

        var objFind = new FindOptions<BsonDocument, BsonDocument> { Projection = objCall.Document(1) };
        int? intUserLimit = objCall.Name == "findOne" ? 1 : null;
        foreach (var objModifier in objCommand.Calls.Skip(1))
        {
            switch (objModifier.Name)
            {
                case "sort": objFind.Sort = Required(objModifier, 0); break;
                case "project" or "projection": objFind.Projection = Required(objModifier, 0); break;
                case "skip": objFind.Skip = Number(objModifier); break;
                case "limit": intUserLimit = Math.Min(intUserLimit ?? int.MaxValue, Number(objModifier)); break;
                case "hint": objFind.Hint = objModifier.Arg(0) is BsonString objName ? objName.Value : Required(objModifier, 0); break;
                case "toArray" or "pretty": break;
                default:
                    throw new MongoShellException($".{objModifier.Name}() is not supported after {objCall.Name}(). Use sort, limit, skip, project, hint, count.",
                        MongoShellException.Script);
            }
        }
        // limit(0) means no limit in the shell.
        if (intUserLimit == 0) intUserLimit = null;
        objFind.Limit = (intUserLimit, intLimit) switch
        {
            (null, null) => null,
            ({ } intUser, null) => intUser,
            (null, { } intMax) => intMax,
            ({ } intUser, { } intMax) => Math.Min(intUser, intMax),
        };
        FilterDefinition<BsonDocument> objFilter = objCall.Document(0) ?? [];
        return objTx is null
            ? await objCollection.FindAsync(objFilter, objFind, objCancelToken)
            : await objCollection.FindAsync(objTx, objFilter, objFind, objCancelToken);
    }

    private static Task<long> CountAsync(IMongoCollection<BsonDocument> objCollection, BsonDocument objFilter, IClientSessionHandle? objTx,
        CancellationToken objCancelToken) =>
        objTx is null
            ? objCollection.CountDocumentsAsync(objFilter, cancellationToken: objCancelToken)
            : objCollection.CountDocumentsAsync(objTx, objFilter, cancellationToken: objCancelToken);

    private static async Task<(List<BsonDocument> Docs, bool Truncated)> ReadAsync(IAsyncCursor<BsonDocument> objCursor, int intMaxRows,
        CancellationToken objCancelToken)
    {
        using (objCursor)
        {
            var lstDocs = new List<BsonDocument>();
            while (await objCursor.MoveNextAsync(objCancelToken))
            {
                foreach (var objDoc in objCursor.Current)
                {
                    if (lstDocs.Count >= intMaxRows) return (lstDocs, true);
                    lstDocs.Add(objDoc);
                }
            }
            return (lstDocs, false);
        }
    }

    // ---------- export ----------
    public async Task StreamAsync(ConnectionProfile objProfile, string strSql, IRowSink objSink, CancellationToken objCancelToken)
    {
        var objCommand = MongoShell.Parse(strSql);
        if (objCommand.Collection is null || objCommand.Main.Name is not ("find" or "aggregate"))
            throw new MongoShellException("Only find() and aggregate() can be exported.");

        var objDatabase = ClientFor(objProfile).GetDatabase(objCommand.Database ?? DefaultDatabase(objProfile));
        using var objCursor = await OpenCursorAsync(objDatabase.GetCollection<BsonDocument>(objCommand.Collection), objCommand, null, null, objCancelToken);

        // The file needs its header first: the columns are the fields of the first batch. Fields that only
        // appear in later documents are left out.
        List<string>? lstColumns = null;
        var arrRow = Array.Empty<object?>();
        while (await objCursor.MoveNextAsync(objCancelToken))
        {
            var lstBatch = objCursor.Current.ToList();
            if (lstColumns is null)
            {
                lstColumns = ColumnsOf(lstBatch).Select(objColumn => objColumn.Name).ToList();
                objSink.Begin(ColumnsOf(lstBatch));
                arrRow = new object?[lstColumns.Count];
            }
            foreach (var objDoc in lstBatch)
            {
                for (var intIndex = 0; intIndex < arrRow.Length; intIndex++)
                    arrRow[intIndex] = objDoc.TryGetValue(lstColumns[intIndex], out var objValue) ? Cell(objValue) : null;
                if (!objSink.Write(arrRow)) return;
            }
        }
        if (lstColumns is null) objSink.Begin([]);
    }

    // ---------- shaping results ----------
    private static void NoModifiers(MongoCommand objCommand)
    {
        if (objCommand.Calls.Count > 1)
            throw new MongoShellException($".{objCommand.Calls[1].Name}() cannot follow {objCommand.Main.Name}().", MongoShellException.Script);
    }

    private static BsonDocument Required(MongoCall objCall, int intIndex) =>
        objCall.Document(intIndex) ?? throw new MongoShellException($"{objCall.Name}() needs a document as argument {intIndex + 1}.");

    private static string Text(MongoCall objCall, int intIndex) =>
        objCall.Arg(intIndex) is BsonString objText && objText.Value.Length > 0
            ? objText.Value
            : throw new MongoShellException($"{objCall.Name}() needs a name in quotes as argument {intIndex + 1}.");

    private static int Number(MongoCall objCall) =>
        objCall.Arg(0) is { IsNumeric: true } objNumber && objNumber.ToInt64() is >= 0 and <= int.MaxValue
            ? objNumber.ToInt32()
            : throw new MongoShellException($"{objCall.Name}() needs a whole number.");

    private static QueryResult Rows(string[] arrColumns, IEnumerable<object?[]> lstRows)
    {
        var objResult = new QueryResult();
        foreach (var strColumn in arrColumns) objResult.Columns.Add(new ResultColumn(strColumn, ""));
        objResult.Rows.AddRange(lstRows);
        return objResult;
    }

    /// <summary>The answer of a write: one row with its counters, and RecordsAffected for the status bar.</summary>
    private static QueryResult Written(long lngAffected, params (string Name, BsonValue Value)[] arrFields)
    {
        var objResult = Rows(arrFields.Select(objField => objField.Name).ToArray(), [arrFields.Select(objField => Cell(objField.Value)).ToArray()]);
        objResult.RecordsAffected = (int)Math.Min(lngAffected, int.MaxValue);
        var objRaw = new BsonDocument("acknowledged", true);
        foreach (var objField in arrFields) objRaw[objField.Name] = objField.Value;
        return WithRaw(objResult, objRaw);
    }

    /// <summary>Fields of the documents, in first-seen order; the type is that of the first value met.</summary>
    private static List<ResultColumn> ColumnsOf(List<BsonDocument> lstDocs)
    {
        var lstColumns = new List<ResultColumn>();
        var hsSeen = new HashSet<string>();
        foreach (var objDoc in lstDocs)
            foreach (var objElement in objDoc)
                if (hsSeen.Add(objElement.Name)) lstColumns.Add(new ResultColumn(objElement.Name, TypeName(objElement.Value)));
        return lstColumns;
    }

    /// <summary>Documents as a grid (one column per top-level field) plus each document as JSON for the JSON view.</summary>
    private static QueryResult Documents(List<BsonDocument> lstDocs, bool boolTruncated)
    {
        var objResult = new QueryResult { Truncated = boolTruncated, Documents = new List<string>(lstDocs.Count) };
        objResult.Columns.AddRange(ColumnsOf(lstDocs));
        // An empty result still needs a column, or the UI reads it as "statement finished".
        if (objResult.Columns.Count == 0) objResult.Columns.Add(new ResultColumn("_id", ""));
        foreach (var objDoc in lstDocs)
        {
            var arrRow = new object?[objResult.Columns.Count];
            for (var intIndex = 0; intIndex < arrRow.Length; intIndex++)
                arrRow[intIndex] = objDoc.TryGetValue(objResult.Columns[intIndex].Name, out var objValue) ? Cell(objValue) : null;
            objResult.Rows.Add(arrRow);
            objResult.Documents.Add(ShellJson(objDoc, true));
        }
        return WithRaw(objResult, new BsonArray(lstDocs));
    }

    /// <summary>A BSON value as something JSON and JavaScript numbers can carry.</summary>
    private static object? Cell(BsonValue objValue)
    {
        switch (objValue.BsonType)
        {
            case BsonType.Null or BsonType.Undefined: return null;
            case BsonType.String: return objValue.AsString;
            case BsonType.Boolean: return objValue.AsBoolean;
            case BsonType.Int32: return objValue.AsInt32;
            case BsonType.Int64:
                return Math.Abs(objValue.AsInt64) <= MaxSafeJsInteger ? objValue.AsInt64 : objValue.AsInt64.ToString(CultureInfo.InvariantCulture);
            case BsonType.Double:
                return double.IsFinite(objValue.AsDouble) ? objValue.AsDouble : objValue.AsDouble.ToString(CultureInfo.InvariantCulture);
            case BsonType.Decimal128: return objValue.AsDecimal128.ToString();
            case BsonType.ObjectId: return objValue.AsObjectId.ToString();
            // Stored in UTC; shown that way, as the shell does.
            case BsonType.DateTime:
                return objValue.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
            default:
                var strJson = ShellJson(objValue, false);
                return strJson.Length > MaxCellJsonLength ? strJson[..MaxCellJsonLength] + "…" : strJson;
        }
    }

    private static object? Cell(long lngValue) => Cell(new BsonInt64(lngValue));

    private static QueryResult Count(long lngCount) => WithRaw(Rows(["count"], [[Cell(lngCount)]]), new BsonInt64(lngCount));
}
