using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using DbStudio.Core;
using StackExchange.Redis;

namespace DbStudio.Providers;

/// <summary>A command line the Redis console cannot read or must not run.</summary>
public sealed class RedisConsoleException(string strMessage) : Exception(strMessage);

/// <summary>One logical database of the server and how many keys it holds.</summary>
public sealed record RedisDatabaseInfo(int Index, long Keys);

public sealed record RedisKeyInfo(string Key, string Type);

/// <summary>One step of a SCAN. Cursor "0" means the scan is complete.</summary>
public sealed record RedisKeyPage(string Cursor, List<RedisKeyInfo> Keys);

/// <summary>
/// Redis. Statements are command lines as typed in redis-cli (one per line). The logical databases
/// play the part of schemas ("db0", "db1"...); keys are browsed with SCAN through the methods below,
/// not through the metadata, because a server can hold millions of them.
/// </summary>
public sealed class RedisProvider : IDbProvider
{
    private const int MaxValueRows = 5000;
    private const int MaxCellLength = 200_000;
    private const int ScanCount = 1000;
    private const int ScanPageKeys = 500;
    private const int ScanMaxRounds = 30;

    // One connection carries every command: these would block it, or need a connection of their own.
    private static readonly HashSet<string> Refused = new(StringComparer.OrdinalIgnoreCase)
    {
        "SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE", "MONITOR", "SYNC", "PSYNC", "MULTI", "EXEC", "DISCARD", "WATCH", "UNWATCH",
        "BLPOP", "BRPOP", "BRPOPLPUSH", "BLMOVE", "BLMPOP", "BZPOPMIN", "BZPOPMAX", "BZMPOP", "WAIT", "WAITAOF",
        "QUIT", "SHUTDOWN", "AUTH", "HELLO", "RESET",
    };

    private static readonly JsonSerializerOptions RelaxedText = new() { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    // A multiplexer is one shared connection, meant to live as long as the app. Keyed by the full configuration (memory only).
    private readonly ConcurrentDictionary<string, Lazy<Task<ConnectionMultiplexer>>> _dicConnections = new();

    public DbKind Kind => DbKind.Redis;

    private static int DefaultDatabase(ConnectionProfile objProfile) =>
        int.TryParse(objProfile.Database?.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var intIndex) ? intIndex : 0;

    private async Task<ConnectionMultiplexer> ConnectAsync(ConnectionProfile objProfile, CancellationToken objCancelToken)
    {
        var strAddress = $"{objProfile.Host.Trim()}:{(objProfile.Port > 0 ? objProfile.Port : 6379)}";
        var strExtra = (objProfile.Extra ?? "").Trim().Trim(',').Replace(';', ',');
        var objOptions = ConfigurationOptions.Parse(strExtra.Length > 0 ? $"{strAddress},{strExtra}" : strAddress);
        if (!string.IsNullOrEmpty(objProfile.Username)) objOptions.User = objProfile.Username;
        if (!string.IsNullOrEmpty(objProfile.Password)) objOptions.Password = objProfile.Password;
        objOptions.ClientName ??= "DbStudio";
        objOptions.AllowAdmin = true; // the console is the user's own redis-cli: INFO, CONFIG, FLUSHDB...
        objOptions.AbortOnConnectFail = true; // a wrong host must fail now, not on the first command
        // RESP3 reshapes replies (pairs become nested arrays, INFO gets a "txt:" prefix): keep the classic shapes the grids expect.
        objOptions.Protocol = RedisProtocol.Resp2;

        var strKey = objOptions.ToString(includePassword: true);
        var objLazy = _dicConnections.GetOrAdd(strKey, _ => new Lazy<Task<ConnectionMultiplexer>>(() => ConnectionMultiplexer.ConnectAsync(objOptions)));
        try
        {
            return await objLazy.Value.WaitAsync(objCancelToken);
        }
        catch when (objLazy.Value.IsFaulted)
        {
            // Do not keep a failed attempt: the next call tries again.
            _dicConnections.TryRemove(new KeyValuePair<string, Lazy<Task<ConnectionMultiplexer>>>(strKey, objLazy));
            throw;
        }
    }

    /// <summary>The master nodes of a cluster in a stable order; empty for a single server.</summary>
    private static List<IServer> ClusterMasters(ConnectionMultiplexer objMux) =>
        objMux.GetServers()
            .Where(objServer => objServer.ServerType == ServerType.Cluster && objServer.IsConnected && !objServer.IsReplica)
            .OrderBy(objServer => objServer.EndPoint.ToString(), StringComparer.Ordinal)
            .ToList();

    private static bool IsCluster(ConnectionMultiplexer objMux) =>
        objMux.GetServers().Any(objServer => objServer.ServerType == ServerType.Cluster);

    public async Task TestAsync(ConnectionProfile objProfile, CancellationToken objCancelToken)
    {
        var objMux = await ConnectAsync(objProfile, objCancelToken);
        await objMux.GetDatabase(DefaultDatabase(objProfile)).PingAsync().WaitAsync(objCancelToken);
    }

    public async Task<IDbSession> OpenSessionAsync(ConnectionProfile objProfile, CancellationToken objCancelToken) =>
        new RedisSession(await ConnectAsync(objProfile, objCancelToken), DefaultDatabase(objProfile));

    public async Task<QueryResult> ExecuteAsync(ConnectionProfile objProfile, string strSql, int intMaxRows, CancellationToken objCancelToken,
        IRowSink? objSink = null)
    {
        var objMux = await ConnectAsync(objProfile, objCancelToken);
        var (objResult, _) = await RunAsync(objMux, DefaultDatabase(objProfile), strSql, intMaxRows, objCancelToken);
        return objResult;
    }

    public async Task StreamAsync(ConnectionProfile objProfile, string strSql, IRowSink objSink, CancellationToken objCancelToken)
    {
        // A Redis reply arrives whole: there is nothing to stream, only to hand over.
        var objResult = await ExecuteAsync(objProfile, strSql, int.MaxValue, objCancelToken);
        objSink.Begin(objResult.Columns);
        foreach (var arrRow in objResult.Rows)
            if (!objSink.Write(arrRow)) return;
    }

    public Task<RoutineInfo> LoadRoutineAsync(ConnectionProfile objProfile, DbObjectInfo objRoutine, CancellationToken objCancelToken) =>
        throw new NotSupportedException("Redis has no procedures or functions to execute.");

    public Task<RoutineResult> ExecuteRoutineAsync(ConnectionProfile objProfile, DbObjectInfo objRoutine,
        IReadOnlyList<RoutineArgument> lstArguments, int intMaxRows, CancellationToken objCancelToken) =>
        throw new NotSupportedException("Redis has no procedures or functions to execute.");

    public QueryError DescribeError(Exception objEx) => objEx switch
    {
        RedisServerException => new QueryError(objEx.Message),
        // The client appends pages of diagnostics: keep the sentence that says what happened.
        RedisConnectionException or RedisTimeoutException => new QueryError(FirstSentence(objEx.Message)),
        _ => new QueryError(objEx.Message),
    };

    private static string FirstSentence(string strMessage)
    {
        var intCut = strMessage.IndexOfAny([',', ';', '\n']);
        // "It was not possible to connect to the redis server(s). ..." keeps its first sentence.
        var intDot = strMessage.IndexOf(". ", StringComparison.Ordinal);
        if (intDot > 0 && (intCut < 0 || intDot < intCut)) intCut = intDot + 1;
        return intCut > 20 ? strMessage[..intCut] : strMessage;
    }

    // ---------- metadata: only the list of databases ----------
    public async Task<SchemaMetadata> LoadMetadataAsync(ConnectionProfile objProfile, string? strSchema, CancellationToken objCancelToken)
    {
        if (strSchema is not null) return new SchemaMetadata([], DateTimeOffset.Now, [], null, null, [strSchema]);
        var lstDatabases = await ListDatabasesAsync(objProfile, objCancelToken);
        return new SchemaMetadata([], DateTimeOffset.Now, [], null,
            lstDatabases.Select(objItem => $"db{objItem.Index}").ToList(), [$"db{DefaultDatabase(objProfile)}"]);
    }

    /// <summary>Every logical database with its key count (0 for the empty ones).</summary>
    public async Task<List<RedisDatabaseInfo>> ListDatabasesAsync(ConnectionProfile objProfile, CancellationToken objCancelToken)
    {
        var objMux = await ConnectAsync(objProfile, objCancelToken);
        // A cluster has one database, spread over its masters.
        if (ClusterMasters(objMux) is { Count: > 0 } lstMasters)
        {
            var arrSizes = await Task.WhenAll(lstMasters.Select(objServer => objServer.DatabaseSizeAsync())).WaitAsync(objCancelToken);
            return [new RedisDatabaseInfo(0, arrSizes.Sum())];
        }
        var objDb = objMux.GetDatabase(DefaultDatabase(objProfile));

        var dicKeys = new Dictionary<int, long>();
        var strInfo = (string?)await objDb.ExecuteAsync("INFO", "keyspace").WaitAsync(objCancelToken) ?? "";
        foreach (var strLine in strInfo.Split('\n', StringSplitOptions.TrimEntries))
        {
            // db0:keys=12,expires=0,avg_ttl=0
            if (!strLine.StartsWith("db", StringComparison.Ordinal)) continue;
            var intColon = strLine.IndexOf(':');
            var intKeys = strLine.IndexOf("keys=", StringComparison.Ordinal);
            if (intColon < 0 || intKeys < 0 || !int.TryParse(strLine[2..intColon], out var intIndex)) continue;
            var strCount = strLine[(intKeys + 5)..].Split(',')[0];
            if (long.TryParse(strCount, out var lngCount)) dicKeys[intIndex] = lngCount;
        }

        // CONFIG is switched off on many managed servers: then only the databases that hold keys are known.
        var intCount = 0;
        try
        {
            var arrReply = (RedisResult[]?)await objDb.ExecuteAsync("CONFIG", "GET", "databases").WaitAsync(objCancelToken);
            if (arrReply is { Length: >= 2 }) int.TryParse((string?)arrReply[1], out intCount);
        }
        catch (RedisException) { }

        var intLast = Math.Max(Math.Max(intCount - 1, dicKeys.Count > 0 ? dicKeys.Keys.Max() : 0), DefaultDatabase(objProfile));
        return Enumerable.Range(0, intLast + 1)
            .Where(intIndex => intCount > 0 || dicKeys.ContainsKey(intIndex) || intIndex == DefaultDatabase(objProfile))
            .Select(intIndex => new RedisDatabaseInfo(intIndex, dicKeys.GetValueOrDefault(intIndex)))
            .ToList();
    }

    /// <summary>The next keys matching the pattern, with their types. SCAN only: KEYS would block a big server.</summary>
    public async Task<RedisKeyPage> ScanKeysAsync(ConnectionProfile objProfile, int intDatabase, string? strPattern, string? strCursor,
        CancellationToken objCancelToken)
    {
        var objMux = await ConnectAsync(objProfile, objCancelToken);
        var objDb = objMux.GetDatabase(intDatabase);
        strPattern = string.IsNullOrWhiteSpace(strPattern) ? "*" : strPattern.Trim();
        strCursor = string.IsNullOrWhiteSpace(strCursor) ? "0" : strCursor;

        // Cluster: every master is scanned in turn; the cursor is then "node:cursor".
        var lstMasters = ClusterMasters(objMux);
        var intNode = 0;
        if (lstMasters.Count > 0 && strCursor.Split(':') is [var strNode, var strInner] && int.TryParse(strNode, out intNode)) strCursor = strInner;
        if (intNode < 0 || intNode >= Math.Max(lstMasters.Count, 1)) (intNode, strCursor) = (0, "0");

        // One SCAN step can return nothing while the scan is not over: go on until a page is filled.
        var lstKeys = new List<string>();
        var boolDone = false;
        for (var intRound = 0; intRound < ScanMaxRounds && lstKeys.Count < ScanPageKeys && !boolDone; intRound++)
        {
            object[] arrScan = [strCursor, "MATCH", strPattern, "COUNT", ScanCount];
            var objScan = lstMasters.Count > 0 ? lstMasters[intNode].ExecuteAsync("SCAN", arrScan) : objDb.ExecuteAsync("SCAN", arrScan);
            var arrReply = (RedisResult[]?)await objScan.WaitAsync(objCancelToken);
            if (arrReply is not { Length: 2 }) break;
            strCursor = (string?)arrReply[0] ?? "0";
            lstKeys.AddRange(((RedisResult[]?)arrReply[1] ?? []).Select(objKey => (string?)objKey ?? ""));
            if (strCursor != "0") continue;
            if (intNode + 1 < lstMasters.Count) intNode++; // this node is done: go on with the next
            else boolDone = true;
        }
        if (lstMasters.Count > 0) strCursor = boolDone ? "0" : $"{intNode}:{strCursor}";

        // As a key, so a cluster sends each TYPE to the node that holds it.
        var arrTypes = await Task.WhenAll(lstKeys.Select(strKey => objDb.ExecuteAsync("TYPE", (RedisKey)strKey))).WaitAsync(objCancelToken);
        var lstPage = lstKeys.Select((strKey, intIndex) => new RedisKeyInfo(strKey, ((string?)arrTypes[intIndex] ?? "none").ToUpperInvariant()))
            .Where(objKey => objKey.Type != "NONE") // expired between SCAN and TYPE
            .DistinctBy(objKey => objKey.Key)       // SCAN may return a key twice
            .ToList();
        return new RedisKeyPage(strCursor!, lstPage);
    }

    // ---------- key viewer ----------
    public async Task<ObjectDetail> LoadObjectAsync(ConnectionProfile objProfile, DbObjectInfo objObject, bool boolFull, string? strSection,
        CancellationToken objCancelToken)
    {
        if (!objObject.Schema.StartsWith("db", StringComparison.Ordinal) || !int.TryParse(objObject.Schema[2..], out var intDatabase))
            throw new RedisConsoleException($"\"{objObject.Schema}\" is not a Redis database.");
        var objDb = (await ConnectAsync(objProfile, objCancelToken)).GetDatabase(intDatabase);
        var strKey = objObject.Name;

        // The key goes as a RedisKey so a cluster routes every command to the node that holds it.
        async Task<RedisResult> Run(string strCommand, params object[] arrArgs) =>
            await objDb.ExecuteAsync(strCommand, arrArgs.Select(objArg => ReferenceEquals(objArg, strKey) ? (RedisKey)strKey : objArg).ToArray())
                .WaitAsync(objCancelToken);

        var strType = ((string?)await Run("TYPE", strKey) ?? "none").ToLowerInvariant();
        if (strType == "none") throw new RedisConsoleException("The key no longer exists (deleted or expired).");

        var objValue = new QueryResult();
        string strRead, strLength;
        switch (strType)
        {
            case "string":
                Columns(objValue, "value");
                objValue.Rows.Add([Clip((string?)await Run("GET", strKey))]);
                (strRead, strLength) = ($"GET {Quote(strKey)}", "STRLEN");
                break;
            case "hash":
            {
                Columns(objValue, "field", "value");
                var strCursor = "0";
                do
                {
                    var arrReply = (RedisResult[])(await Run("HSCAN", strKey, strCursor, "COUNT", ScanCount))!;
                    strCursor = (string?)arrReply[0] ?? "0";
                    var arrPairs = (RedisResult[]?)arrReply[1] ?? [];
                    for (var intIndex = 0; intIndex + 1 < arrPairs.Length && objValue.Rows.Count < MaxValueRows; intIndex += 2)
                        objValue.Rows.Add([(string?)arrPairs[intIndex], Clip((string?)arrPairs[intIndex + 1])]);
                } while (strCursor != "0" && objValue.Rows.Count < MaxValueRows);
                objValue.Truncated = strCursor != "0";
                (strRead, strLength) = ($"HGETALL {Quote(strKey)}", "HLEN");
                break;
            }
            case "list":
            {
                Columns(objValue, "index", "value");
                var arrItems = (RedisResult[]?)await Run("LRANGE", strKey, 0, MaxValueRows) ?? [];
                foreach (var objItem in arrItems.Take(MaxValueRows)) objValue.Rows.Add([objValue.Rows.Count, Clip((string?)objItem)]);
                objValue.Truncated = arrItems.Length > MaxValueRows;
                (strRead, strLength) = ($"LRANGE {Quote(strKey)} 0 -1", "LLEN");
                break;
            }
            case "set":
            {
                Columns(objValue, "member");
                var strCursor = "0";
                do
                {
                    var arrReply = (RedisResult[])(await Run("SSCAN", strKey, strCursor, "COUNT", ScanCount))!;
                    strCursor = (string?)arrReply[0] ?? "0";
                    foreach (var objMember in ((RedisResult[]?)arrReply[1] ?? []).TakeWhile(_ => objValue.Rows.Count < MaxValueRows))
                        objValue.Rows.Add([Clip((string?)objMember)]);
                } while (strCursor != "0" && objValue.Rows.Count < MaxValueRows);
                objValue.Truncated = strCursor != "0";
                (strRead, strLength) = ($"SMEMBERS {Quote(strKey)}", "SCARD");
                break;
            }
            case "zset":
            {
                Columns(objValue, "member", "score");
                var arrItems = (RedisResult[]?)await Run("ZRANGE", strKey, 0, MaxValueRows, "WITHSCORES") ?? [];
                for (var intIndex = 0; intIndex + 1 < arrItems.Length && objValue.Rows.Count < MaxValueRows; intIndex += 2)
                    objValue.Rows.Add([Clip((string?)arrItems[intIndex]), (string?)arrItems[intIndex + 1]]);
                objValue.Truncated = arrItems.Length / 2 > MaxValueRows;
                (strRead, strLength) = ($"ZRANGE {Quote(strKey)} 0 -1 WITHSCORES", "ZCARD");
                break;
            }
            case "stream":
            {
                Columns(objValue, "id", "fields");
                var arrEntries = (RedisResult[]?)await Run("XRANGE", strKey, "-", "+", "COUNT", MaxValueRows + 1) ?? [];
                foreach (var objEntry in arrEntries.Take(MaxValueRows))
                {
                    var arrEntry = (RedisResult[])objEntry!;
                    objValue.Rows.Add([(string?)arrEntry[0], Clip(Format(arrEntry[1]))]);
                }
                objValue.Truncated = arrEntries.Length > MaxValueRows;
                (strRead, strLength) = ($"XRANGE {Quote(strKey)} - +", "XLEN");
                break;
            }
            default:
                // A module type (JSON, time series...): no generic way to read it.
                Columns(objValue, "value");
                objValue.Rows.Add([$"Type \"{strType}\" has no built-in viewer. Read it with its own commands in the console."]);
                (strRead, strLength) = ($"TYPE {Quote(strKey)}", "");
                break;
        }

        var objProperties = new QueryResult();
        Columns(objProperties, "property", "value");
        objProperties.Rows.Add(["type", strType]);
        var lngTtl = (long)await Run("TTL", strKey);
        objProperties.Rows.Add(["ttl", lngTtl < 0 ? "no expiry" : $"{lngTtl} s"]);
        // Extras: a server may refuse them (ACL, old version) without making the key unreadable.
        async Task Extra(string strLabel, string strCommand, params object[] arrArgs)
        {
            try { objProperties.Rows.Add([strLabel, Value(await Run(strCommand, arrArgs))?.ToString()]); }
            catch (RedisException) { }
        }
        if (strLength.Length > 0) await Extra("length", strLength, strKey);
        await Extra("encoding", "OBJECT", "ENCODING", strKey);
        await Extra("memory (bytes)", "MEMORY", "USAGE", strKey);

        var lstSections = new List<ObjectSection> { new("Value", objValue), new("Properties", objProperties) };
        if (strSection is not null) lstSections = lstSections.Where(objSection => objSection.Title == strSection).ToList();
        if (!boolFull || strSection is not null) return new ObjectDetail(lstSections, null);

        // In place of DDL: the console commands that read this key.
        var strCommands = string.Join('\n', $"SELECT {intDatabase}", $"TYPE {Quote(strKey)}", $"TTL {Quote(strKey)}", strRead);
        return new ObjectDetail(lstSections, strCommands);
    }

    private static void Columns(QueryResult objResult, params string[] arrNames)
    {
        foreach (var strName in arrNames) objResult.Columns.Add(new ResultColumn(strName, ""));
    }

    private static string? Clip(string? strValue) =>
        strValue is { Length: > MaxCellLength } ? strValue[..MaxCellLength] + "…" : strValue;

    /// <summary>A key or value as the console reads it back: quoted only when it has to be.</summary>
    private static string Quote(string strText)
    {
        if (strText.Length > 0 && strText.All(chrAt => !char.IsWhiteSpace(chrAt) && chrAt is not ('"' or '\'' or '\\') && !char.IsControl(chrAt)))
            return strText;
        var objQuoted = new StringBuilder("\"");
        foreach (var chrAt in strText)
        {
            objQuoted.Append(chrAt switch
            {
                '"' => "\\\"", '\\' => "\\\\", '\n' => "\\n", '\r' => "\\r", '\t' => "\\t",
                _ => chrAt.ToString(),
            });
        }
        return objQuoted.Append('"').ToString();
    }

    // ---------- console ----------
    /// <summary>Runs one command line. Returns the result and the database later lines of the tab run in (SELECT changes it).</summary>
    private static async Task<(QueryResult Result, int Database)> RunAsync(ConnectionMultiplexer objMux, int intDatabase, string strLine, int intMaxRows,
        CancellationToken objCancelToken)
    {
        var objStopwatch = Stopwatch.StartNew();
        var lstWords = SplitCommand(strLine);
        if (lstWords.Count == 0) throw new RedisConsoleException("Nothing to run.");
        var strCommand = lstWords[0].ToUpperInvariant();
        var arrArgs = lstWords.Skip(1).Cast<object>().ToArray();

        if (Refused.Contains(strCommand))
            throw new RedisConsoleException($"{strCommand} is not available here: it blocks, or needs a connection of its own. Use redis-cli for it.");
        if (strCommand is "XREAD" or "XREADGROUP" && lstWords.Exists(strWord => strWord.Equals("BLOCK", StringComparison.OrdinalIgnoreCase)))
            throw new RedisConsoleException($"{strCommand} with BLOCK is not available here: it would block the shared connection.");

        QueryResult objResult;
        if (strCommand == "SELECT")
        {
            // The connection is shared: the tab remembers its database instead of the server.
            if (lstWords.Count != 2 || !int.TryParse(lstWords[1], NumberStyles.None, CultureInfo.InvariantCulture, out var intIndex))
                throw new RedisConsoleException("Use: SELECT <database number>.");
            if (intIndex != 0 && IsCluster(objMux)) throw new RedisConsoleException("A cluster only has database 0.");
            await objMux.GetDatabase(intIndex).ExecuteAsync("DBSIZE").WaitAsync(objCancelToken); // fails for a number the server does not have
            intDatabase = intIndex;
            objResult = Scalar($"OK (database {intIndex})");
        }
        else
        {
            var objReply = await objMux.GetDatabase(intDatabase).ExecuteAsync(strCommand, arrArgs).WaitAsync(objCancelToken);
            objResult = ToGrid(strCommand, lstWords, objReply, intMaxRows);
        }
        objResult.ElapsedMs = objStopwatch.ElapsedMilliseconds;
        return (objResult, intDatabase);
    }

    /// <summary>Splits a line the way redis-cli does: spaces, "double quotes with \n \xHH escapes", 'single quotes'.</summary>
    private static List<string> SplitCommand(string strLine)
    {
        var lstWords = new List<string>();
        var intPos = 0;
        while (true)
        {
            while (intPos < strLine.Length && char.IsWhiteSpace(strLine[intPos])) intPos++;
            if (intPos >= strLine.Length) return lstWords;

            var objWord = new StringBuilder();
            var chrQuote = '\0';
            while (intPos < strLine.Length)
            {
                var chrAt = strLine[intPos];
                if (chrQuote == '\0')
                {
                    if (char.IsWhiteSpace(chrAt)) break;
                    if (chrAt is '"' or '\'') chrQuote = chrAt;
                    else objWord.Append(chrAt);
                }
                else if (chrAt == chrQuote) chrQuote = '\0';
                else if (chrAt == '\\' && intPos + 1 < strLine.Length && (chrQuote == '"' || strLine[intPos + 1] == '\''))
                {
                    var chrNext = strLine[++intPos];
                    if (chrQuote == '"' && chrNext == 'x' && intPos + 2 < strLine.Length
                        && int.TryParse(strLine.AsSpan(intPos + 1, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var intByte))
                    {
                        objWord.Append((char)intByte);
                        intPos += 2;
                    }
                    else objWord.Append(chrNext switch { 'n' => '\n', 'r' => '\r', 't' => '\t', 'b' => '\b', 'a' => '\a', _ => chrNext });
                }
                else objWord.Append(chrAt);
                intPos++;
            }
            if (chrQuote != '\0') throw new RedisConsoleException("A quote is not closed.");
            lstWords.Add(objWord.ToString());
        }
    }

    private static QueryResult Scalar(object? objValue)
    {
        var objResult = new QueryResult();
        Columns(objResult, "result");
        objResult.Rows.Add([objValue]);
        return objResult;
    }

    private static object? Value(RedisResult objReply)
    {
        if (objReply.IsNull) return "(nil)";
        return objReply.Resp2Type switch
        {
            ResultType.Integer => (long)objReply,
            ResultType.Array => Format(objReply),
            _ => Clip((string?)objReply),
        };
    }

    /// <summary>A nested reply as one line of text: ["a", 1, ["b", null]].</summary>
    private static string Format(RedisResult objReply)
    {
        if (objReply.IsNull) return "null";
        return objReply.Resp2Type switch
        {
            ResultType.Integer => ((long)objReply).ToString(CultureInfo.InvariantCulture),
            ResultType.Array => "[" + string.Join(", ", ((RedisResult[])objReply!).Select(Format)) + "]",
            _ => JsonSerializer.Serialize((string?)objReply, RelaxedText),
        };
    }

    private static QueryResult ToGrid(string strCommand, List<string> lstWords, RedisResult objReply, int intMaxRows)
    {
        if (objReply.IsNull || objReply.Resp2Type != ResultType.Array)
        {
            // INFO answers one long text of "name:value" lines under "# Section" titles.
            if (strCommand == "INFO" && !objReply.IsNull) return InfoGrid((string?)objReply ?? "");
            return Scalar(Value(objReply));
        }

        var arrItems = (RedisResult[])objReply!;
        var objResult = new QueryResult();
        bool Has(string strOption) => lstWords.Exists(strWord => strWord.Equals(strOption, StringComparison.OrdinalIgnoreCase));
        var boolFlat = arrItems.All(objItem => objItem.IsNull || objItem.Resp2Type != ResultType.Array);
        // Replies that are name / value pairs laid end to end.
        var (strLeft, strRight) = strCommand switch
        {
            "HGETALL" => ("field", "value"),
            "CONFIG" when Has("GET") => ("parameter", "value"),
            "ZRANGE" or "ZREVRANGE" or "ZRANGEBYSCORE" or "ZREVRANGEBYSCORE" or "ZPOPMIN" or "ZPOPMAX" or "ZRANDMEMBER" when Has("WITHSCORES")
                || strCommand is "ZPOPMIN" or "ZPOPMAX" => ("member", "score"),
            _ => ("", ""),
        };

        if (strLeft.Length > 0 && boolFlat && arrItems.Length % 2 == 0)
        {
            Columns(objResult, strLeft, strRight);
            for (var intIndex = 0; intIndex < arrItems.Length; intIndex += 2)
            {
                if (objResult.Rows.Count >= intMaxRows) { objResult.Truncated = true; break; }
                objResult.Rows.Add([Value(arrItems[intIndex]), Value(arrItems[intIndex + 1])]);
            }
            return objResult;
        }

        Columns(objResult, "#", "value");
        foreach (var objItem in arrItems)
        {
            if (objResult.Rows.Count >= intMaxRows) { objResult.Truncated = true; break; }
            objResult.Rows.Add([objResult.Rows.Count + 1, Value(objItem)]);
        }
        return objResult;
    }

    private static QueryResult InfoGrid(string strInfo)
    {
        var objResult = new QueryResult();
        Columns(objResult, "section", "name", "value");
        var strSection = "";
        foreach (var strLine in strInfo.Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            if (strLine.StartsWith('#')) { strSection = strLine.TrimStart('#', ' '); continue; }
            var intColon = strLine.IndexOf(':');
            objResult.Rows.Add(intColon < 0 ? [strSection, strLine, null] : [strSection, strLine[..intColon], strLine[(intColon + 1)..]]);
        }
        return objResult;
    }

    /// <summary>One editor tab: remembers the database chosen with SELECT. The connection itself is shared.</summary>
    private sealed class RedisSession(ConnectionMultiplexer objMux, int intInitialDatabase) : IDbSession
    {
        private int _intDatabase = intInitialDatabase;

        public bool InTransaction => false;

        public async Task<QueryResult> ExecuteAsync(string strSql, int intMaxRows, bool boolAutoCommit, CancellationToken objCancelToken,
            IRowSink? objSink = null)
        {
            var (objResult, intDatabase) = await RunAsync(objMux, _intDatabase, strSql, intMaxRows, objCancelToken);
            _intDatabase = intDatabase;
            return objResult;
        }

        public Task CommitAsync(CancellationToken objCancelToken) => Task.CompletedTask;
        public Task RollbackAsync(CancellationToken objCancelToken) => Task.CompletedTask;
        public ValueTask DisposeAsync() => ValueTask.CompletedTask; // the multiplexer is shared, not the tab's
    }
}
