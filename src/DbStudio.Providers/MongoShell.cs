using System.Text;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;

namespace DbStudio.Providers;

/// <summary>A statement the Mongo shell parser cannot read or the provider does not run.</summary>
public sealed class MongoShellException(string strMessage, string? strCode = null) : Exception(strMessage)
{
    /// <summary>The text is not one plain call chain, or uses something only JavaScript has: the script engine gets it instead.</summary>
    public const string Script = "Script";

    /// <summary>Lets the UI tell some failures apart (QueryError.Code).</summary>
    public string? Code { get; } = strCode;
}

/// <summary>One call of a chain: name(arg, arg...). Args are the raw texts between the commas.</summary>
internal sealed record MongoCall(string Name, List<string> Args)
{
    /// <summary>Argument intIndex as BSON; null when it was not given.</summary>
    public BsonValue? Arg(int intIndex)
    {
        if (intIndex >= Args.Count) return null;
        try { return BsonSerializer.Deserialize<BsonValue>(Args[intIndex]); }
        catch (Exception objEx) when (objEx is FormatException or BsonException or InvalidOperationException)
        {
            throw new MongoShellException($"{Name}(): argument {intIndex + 1} is not valid JSON. {objEx.Message}", MongoShellException.Script);
        }
    }

    public BsonDocument? Document(int intIndex) => Arg(intIndex) switch
    {
        null => null,
        BsonDocument objDocument => objDocument,
        _ => throw new MongoShellException($"{Name}(): argument {intIndex + 1} must be a document {{ ... }}."),
    };
}

/// <summary>
/// What a line of mongo shell syntax asks for: db[.getSiblingDB("x")].collection.method(...).modifier(...).
/// Shell: "show dbs", "show collections", "use name" (Collection and Calls are then empty).
/// </summary>
internal sealed record MongoCommand(string? Shell, string? ShellArg, string? Database, string? Collection, List<MongoCall> Calls)
{
    public MongoCall Main => Calls[0];
}

/// <summary>Reads a plain call chain of mongo shell syntax. Anything it cannot read is left to the script engine (MongoProvider.ScriptHost).</summary>
internal static class MongoShell
{
    public static MongoCommand Parse(string strText)
    {
        var strSource = StripComments(strText).Trim().TrimEnd(';').Trim();
        if (strSource.Length == 0) throw new MongoShellException("Nothing to run.");

        var arrWords = strSource.Split((char[]?)null, 3, StringSplitOptions.RemoveEmptyEntries);
        if (arrWords[0] == "show" && arrWords.Length == 2)
        {
            return arrWords[1] switch
            {
                "dbs" or "databases" => new MongoCommand("dbs", null, null, null, []),
                "collections" or "tables" => new MongoCommand("collections", null, null, null, []),
                _ => throw new MongoShellException("Use: show dbs, show collections."),
            };
        }
        if (arrWords[0] == "use" && arrWords.Length == 2) return new MongoCommand("use", arrWords[1].Trim('"', '\''), null, null, []);

        if (!strSource.StartsWith("db", StringComparison.Ordinal) || (strSource.Length > 2 && strSource[2] != '.'))
            throw new MongoShellException("A statement starts with db: db.collection.find({ ... }). Also: show dbs, show collections, use <database>.",
                MongoShellException.Script);

        string? strDatabase = null, strCollection = null;
        var lstName = new List<string>(); // collection names may hold dots: db.a.b.find()
        var lstCalls = new List<MongoCall>();
        var intPos = 2;
        while (intPos < strSource.Length)
        {
            SkipSpace(strSource, ref intPos);
            if (intPos >= strSource.Length) break;
            if (strSource[intPos] != '.') throw new MongoShellException($"Unexpected text: {Preview(strSource, intPos)}", MongoShellException.Script);
            intPos++;
            SkipSpace(strSource, ref intPos);

            var intStart = intPos;
            while (intPos < strSource.Length && (char.IsLetterOrDigit(strSource[intPos]) || strSource[intPos] is '_' or '$' or '-')) intPos++;
            var strName = strSource[intStart..intPos];
            if (strName.Length == 0) throw new MongoShellException($"A name is expected: {Preview(strSource, intStart)}", MongoShellException.Script);
            SkipSpace(strSource, ref intPos);

            if (intPos >= strSource.Length || strSource[intPos] != '(')
            {
                if (lstCalls.Count > 0) throw new MongoShellException($"Unexpected .{strName} after {lstCalls[^1].Name}().", MongoShellException.Script);
                lstName.Add(strName);
                continue;
            }

            var intClose = FindClose(strSource, intPos);
            var objCall = new MongoCall(strName, SplitArgs(strSource[(intPos + 1)..intClose]));
            intPos = intClose + 1;

            // Before any method: the calls that pick the database / collection.
            if (lstCalls.Count == 0 && lstName.Count == 0 && strCollection is null)
            {
                if (strName == "getSiblingDB") { strDatabase = StringArg(objCall); continue; }
                if (strName == "getCollection") { strCollection = StringArg(objCall); continue; }
            }
            lstCalls.Add(objCall);
        }

        if (lstName.Count > 0)
        {
            if (strCollection is not null) throw new MongoShellException("Unexpected name after getCollection().", MongoShellException.Script);
            strCollection = string.Join('.', lstName);
        }
        if (lstCalls.Count == 0)
            throw new MongoShellException("Nothing is called: add a method, e.g. .find({}).", MongoShellException.Script);
        return new MongoCommand(null, null, strDatabase, strCollection, lstCalls);
    }

    private static string StringArg(MongoCall objCall) =>
        objCall.Arg(0) is BsonString objName && objName.Value.Length > 0
            ? objName.Value
            : throw new MongoShellException($"{objCall.Name}() needs a name in quotes.", MongoShellException.Script);

    private static string Preview(string strSource, int intPos) =>
        strSource[intPos..Math.Min(strSource.Length, intPos + 30)];

    private static void SkipSpace(string strSource, ref int intPos)
    {
        while (intPos < strSource.Length && char.IsWhiteSpace(strSource[intPos])) intPos++;
    }

    /// <summary>Index just past the string that opens at intPos.</summary>
    private static int SkipString(string strSource, int intPos)
    {
        var chrQuote = strSource[intPos++];
        while (intPos < strSource.Length)
        {
            if (strSource[intPos] == '\\') intPos += 2;
            else if (strSource[intPos++] == chrQuote) return intPos;
        }
        throw new MongoShellException("A string is not closed.", MongoShellException.Script);
    }

    /// <summary>Index of the bracket that closes the one at intOpen.</summary>
    private static int FindClose(string strSource, int intOpen)
    {
        var intDepth = 0;
        for (var intPos = intOpen; intPos < strSource.Length; intPos++)
        {
            var chrAt = strSource[intPos];
            if (chrAt is '"' or '\'' or '`') { intPos = SkipString(strSource, intPos) - 1; continue; }
            if (chrAt is '(' or '[' or '{') intDepth++;
            else if (chrAt is ')' or ']' or '}')
            {
                if (--intDepth == 0) return intPos;
            }
        }
        throw new MongoShellException("A bracket is not closed.", MongoShellException.Script);
    }

    /// <summary>Splits "a, {b: 1, c: [2, 3]}, 'x,y'" at its top-level commas.</summary>
    private static List<string> SplitArgs(string strArgs)
    {
        var lstArgs = new List<string>();
        var intDepth = 0;
        var intStart = 0;
        for (var intPos = 0; intPos < strArgs.Length; intPos++)
        {
            var chrAt = strArgs[intPos];
            if (chrAt is '"' or '\'' or '`') { intPos = SkipString(strArgs, intPos) - 1; continue; }
            if (chrAt is '(' or '[' or '{') intDepth++;
            else if (chrAt is ')' or ']' or '}') intDepth--;
            else if (chrAt == ',' && intDepth == 0)
            {
                lstArgs.Add(strArgs[intStart..intPos].Trim());
                intStart = intPos + 1;
            }
        }
        var strLast = strArgs[intStart..].Trim();
        if (strLast.Length > 0 || lstArgs.Count > 0) lstArgs.Add(strLast);
        if (lstArgs.Exists(strArg => strArg.Length == 0)) throw new MongoShellException("An argument is missing between two commas.", MongoShellException.Script);
        return lstArgs;
    }

    /// <summary>Drops // and /* */ comments outside strings: the BSON reader does not take them.</summary>
    private static string StripComments(string strText)
    {
        var objClean = new StringBuilder(strText.Length);
        for (var intPos = 0; intPos < strText.Length; intPos++)
        {
            var chrAt = strText[intPos];
            if (chrAt is '"' or '\'' or '`')
            {
                var intEnd = SkipString(strText, intPos);
                objClean.Append(strText, intPos, intEnd - intPos);
                intPos = intEnd - 1;
            }
            else if (chrAt == '/' && intPos + 1 < strText.Length && strText[intPos + 1] == '/')
            {
                var intEol = strText.IndexOf('\n', intPos);
                if (intEol < 0) break;
                intPos = intEol - 1;
            }
            else if (chrAt == '/' && intPos + 1 < strText.Length && strText[intPos + 1] == '*')
            {
                var intEnd = strText.IndexOf("*/", intPos + 2, StringComparison.Ordinal);
                if (intEnd < 0) break;
                intPos = intEnd + 1;
                objClean.Append(' ');
            }
            else objClean.Append(chrAt);
        }
        return objClean.ToString();
    }
}
