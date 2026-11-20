using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using DbStudio.Core;
using Jint;
using Jint.Runtime;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;

namespace DbStudio.Providers;

public sealed partial class MongoProvider
{
    // What a call returned as BSON, kept beside its grid: scripts work on values, not on grid cells.
    private static readonly ConditionalWeakTable<QueryResult, BsonValue> RawResults = new();

    private static QueryResult WithRaw(QueryResult objResult, BsonValue objRaw)
    {
        RawResults.AddOrUpdate(objResult, objRaw);
        return objResult;
    }

    /// <summary>
    /// Runs statements that are more than one call chain (variables, loops, functions, forEach...) as JavaScript.
    /// The engine is a sandbox: it reaches the database only through __run, which hands each call to the same
    /// code the plain statements use. Values cross the boundary as shell text (ObjectId("..."), ISODate("...")).
    /// One host per editor tab: variables stay between statements.
    /// </summary>
    private sealed class ScriptHost(MongoProvider objProvider)
    {
        private const int MaxScriptDocuments = 1_000_000;
        private const int MaxOutputLines = 100_000;

        private sealed class CancelConstraint : Constraint
        {
            public CancellationToken Token;
            public override void Check() => Token.ThrowIfCancellationRequested();
            public override void Reset() { }
        }

        private sealed record ScriptCall(string Name, List<string> Args);
        private sealed record Outcome(string Kind, string? D, string? C, List<ScriptCall>? Calls, string? Text);

        private static readonly JsonSerializerOptions CaseInsensitive = new() { PropertyNameCaseInsensitive = true };

        private readonly CancelConstraint _objCancel = new();
        private readonly List<string> _lstOutput = [];
        private Engine? _objEngine;
        // The run in progress.
        private MongoClient _objClient = null!;
        private string _strDatabase = "";
        private IClientSessionHandle? _objTx;

        /// <summary>The server error a call of the last run met, even when the script caught it.</summary>
        public Exception? DatabaseError { get; private set; }

        public async Task<QueryResult> RunAsync(MongoClient objClient, string strDatabase, string strCode, int intMaxRows,
            IClientSessionHandle? objTx, CancellationToken objCancelToken)
        {
            (_objClient, _strDatabase, _objTx) = (objClient, strDatabase, objTx);
            _objCancel.Token = objCancelToken;
            _lstOutput.Clear();
            DatabaseError = null;

            // The engine is synchronous and its database calls block: keep it off the request's thread.
            var objOutcome = await Task.Run(() => Evaluate(strCode), CancellationToken.None);

            QueryResult? objValue = null;
            if (objOutcome.Kind == "cursor")
            {
                // A cursor left unread is the statement's result: read it like a plain find(), up to the grid's limit.
                var objCommand = new MongoCommand(null, null, objOutcome.D, objOutcome.C, ToCalls(objOutcome.Calls));
                objValue = await objProvider.RunCommandAsync(objClient, strDatabase, objCommand, intMaxRows, objTx, objCancelToken);
            }
            else if (objOutcome.Kind == "value") objValue = ToResult(BsonSerializer.Deserialize<BsonValue>(objOutcome.Text), intMaxRows);

            if (_lstOutput.Count == 0) return objValue ?? new QueryResult();
            var objOutput = Rows(["output"], _lstOutput.Select(strLine => new object?[] { strLine }).ToList());
            if (objValue is null) return objOutput;
            (objValue.More ??= []).Add(objOutput); // print() lines get a tab of their own
            return objValue;
        }

        private Outcome Evaluate(string strCode)
        {
            var objEngine = _objEngine ??= Create();
            objEngine.SetValue("__code", KeepDeclarations(strCode));
            try
            {
                var strJson = objEngine.Evaluate("__describe((0, eval)(__code))").AsString();
                return JsonSerializer.Deserialize<Outcome>(strJson, CaseInsensitive)!;
            }
            catch (JavaScriptException objEx)
            {
                throw new MongoShellException(objEx.Message);
            }
            catch (Exception objEx) when (objEx is not (OperationCanceledException or MongoShellException or MongoException)
                && objEx.GetType().Namespace?.StartsWith("Jint", StringComparison.Ordinal) == true)
            {
                throw new MongoShellException($"The script was stopped: {objEx.Message}");
            }
        }

        /// <summary>
        /// Each statement is evaluated on its own, so a top-level const / let would vanish with it: those become var,
        /// which stays for the next statements (and may be declared again when the script is re-run). Inside blocks nothing changes.
        /// </summary>
        private static string KeepDeclarations(string strCode)
        {
            var objOut = new StringBuilder(strCode.Length + 8);
            var intDepth = 0;
            var boolStart = true; // at the start of a statement
            var intPos = 0;
            while (intPos < strCode.Length)
            {
                var chrAt = strCode[intPos];
                var intSkip = 0; // length of a string or comment to copy as it is
                if (chrAt is '"' or '\'' or '`')
                {
                    var intEnd = intPos + 1;
                    while (intEnd < strCode.Length && strCode[intEnd] != chrAt) intEnd += strCode[intEnd] == '\\' ? 2 : 1;
                    intSkip = Math.Min(intEnd + 1, strCode.Length) - intPos;
                }
                else if (chrAt == '/' && intPos + 1 < strCode.Length && strCode[intPos + 1] == '/')
                {
                    var intEol = strCode.IndexOf('\n', intPos);
                    intSkip = (intEol < 0 ? strCode.Length : intEol) - intPos;
                }
                else if (chrAt == '/' && intPos + 1 < strCode.Length && strCode[intPos + 1] == '*')
                {
                    var intClose = strCode.IndexOf("*/", intPos + 2, StringComparison.Ordinal);
                    intSkip = (intClose < 0 ? strCode.Length : intClose + 2) - intPos;
                }
                if (intSkip > 0)
                {
                    objOut.Append(strCode, intPos, intSkip);
                    intPos += intSkip;
                    if (chrAt != '/') boolStart = false; // a comment does not start a statement, a string does
                    continue;
                }

                if (boolStart && intDepth == 0 && char.IsLetter(chrAt))
                {
                    var strWord = strCode.AsSpan(intPos).StartsWith("const") ? "const" : strCode.AsSpan(intPos).StartsWith("let") ? "let" : "";
                    var intAfter = intPos + strWord.Length;
                    if (strWord.Length > 0 && intAfter < strCode.Length && (char.IsWhiteSpace(strCode[intAfter]) || strCode[intAfter] is '{' or '['))
                    {
                        objOut.Append("var");
                        intPos = intAfter;
                        boolStart = false;
                        continue;
                    }
                }

                if (chrAt is '(' or '[' or '{') intDepth++;
                else if (chrAt is ')' or ']' or '}') intDepth = Math.Max(0, intDepth - 1);
                if (chrAt is ';' or '\n' or '}') boolStart = true;
                else if (!char.IsWhiteSpace(chrAt)) boolStart = false;
                objOut.Append(chrAt);
                intPos++;
            }
            return objOut.ToString();
        }

        private Engine Create()
        {
            // No CLR access is switched on: the script sees only the functions set below.
            var objEngine = new Engine(objOptions => objOptions
                .Constraint(_objCancel)
                .LimitRecursion(500)
                // A failed call becomes a JavaScript error the script may catch.
                .CatchClrExceptions(objEx => objEx is MongoShellException));
            objEngine.SetValue("__run", new Func<string?, string?, string, string>(Run));
            objEngine.SetValue("__print", new Action<string>(strLine =>
            {
                if (_lstOutput.Count < MaxOutputLines) _lstOutput.Add(strLine);
            }));
            objEngine.SetValue("__pretty", new Func<string, string>(strShell => ShellJson(BsonSerializer.Deserialize<BsonValue>(strShell), true)));
            objEngine.SetValue("__oid", new Func<string>(() => ObjectId.GenerateNewId().ToString()));
            objEngine.SetValue("__sleep", new Action<double>(dblMs =>
            {
                if (_objCancel.Token.WaitHandle.WaitOne(TimeSpan.FromMilliseconds(Math.Clamp(dblMs, 0, 3_600_000)))) _objCancel.Token.ThrowIfCancellationRequested();
            }));
            objEngine.Execute(Bootstrap);
            return objEngine;
        }

        private static List<MongoCall> ToCalls(List<ScriptCall>? lstCalls) =>
            (lstCalls ?? []).Select(objCall => new MongoCall(objCall.Name, objCall.Args)).ToList();

        /// <summary>One database call of the script: the calls of a chain, their arguments as shell text. Answers shell text.</summary>
        private string Run(string? strDatabase, string? strCollection, string strCalls)
        {
            _objCancel.Token.ThrowIfCancellationRequested();
            var objCommand = new MongoCommand(null, null, strDatabase, strCollection,
                ToCalls(JsonSerializer.Deserialize<List<ScriptCall>>(strCalls, CaseInsensitive)));
            try
            {
                var objResult = objProvider.RunCommandAsync(_objClient, _strDatabase, objCommand, MaxScriptDocuments, _objTx, _objCancel.Token)
                    .GetAwaiter().GetResult();
                if (objResult.Truncated)
                    throw new MongoShellException($"The script read more than {MaxScriptDocuments:N0} documents at once: add a filter or .limit().");
                return ShellJson(RawResults.TryGetValue(objResult, out var objRaw) ? objRaw : BsonNull.Value, false, true);
            }
            catch (Exception objEx) when (objEx is MongoException or TimeoutException)
            {
                DatabaseError = objEx;
                throw new MongoShellException(objProvider.DescribeError(objEx).Message);
            }
        }

        /// <summary>The value a script ends with, as a grid.</summary>
        private static QueryResult ToResult(BsonValue objValue, int intMaxRows)
        {
            switch (objValue)
            {
                case BsonDocument objDoc:
                    return Documents([objDoc], false);
                case BsonArray arrItems when arrItems.Count > 0 && arrItems.All(objItem => objItem is BsonDocument):
                    return Documents(arrItems.Take(intMaxRows).Cast<BsonDocument>().ToList(), arrItems.Count > intMaxRows);
                case BsonArray arrItems:
                    var objGrid = Rows(["value"], arrItems.Take(intMaxRows).Select(objItem => new object?[] { Cell(objItem) }));
                    objGrid.Truncated = arrItems.Count > intMaxRows;
                    return objGrid;
                default:
                    return Rows(["result"], [[Cell(objValue)]]);
            }
        }

        // The shell objects, written in JavaScript itself. Loaded once per engine.
        private const string Bootstrap = """
            (function () {
              'use strict';
              const run = __run, print0 = __print, pretty = __pretty, newId = __oid, sleep0 = __sleep;

              function ObjectId(s) {
                if (!(this instanceof ObjectId)) return new ObjectId(s);
                s = s === undefined ? newId() : String(s);
                if (!/^[0-9a-fA-F]{24}$/.test(s)) throw new Error('ObjectId() needs 24 hex characters.');
                this.str = s.toLowerCase();
              }
              ObjectId.prototype.toString = ObjectId.prototype.toHexString = ObjectId.prototype.valueOf = function () { return this.str; };
              ObjectId.prototype.equals = function (o) { return String(o) === this.str; };
              ObjectId.prototype.getTimestamp = function () { return new Date(parseInt(this.str.slice(0, 8), 16) * 1000); };

              function NumberLong(v) {
                if (!(this instanceof NumberLong)) return new NumberLong(v);
                v = String(v === undefined ? 0 : v);
                if (!/^-?\d+$/.test(v)) throw new Error('NumberLong() needs a whole number.');
                this.value = v;
              }
              NumberLong.prototype.valueOf = NumberLong.prototype.toNumber = function () { return Number(this.value); };
              NumberLong.prototype.toString = function () { return this.value; };
              // In arithmetic a number while it fits one exactly; past that the digits are kept as text.
              NumberLong.prototype[Symbol.toPrimitive] = function (hint) {
                return hint !== 'string' && Number.isSafeInteger(Number(this.value)) ? Number(this.value) : this.value;
              };

              function NumberDecimal(v) {
                if (!(this instanceof NumberDecimal)) return new NumberDecimal(v);
                v = String(v === undefined ? 0 : v);
                if (!/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$|^-?Infinity$|^NaN$/.test(v)) throw new Error('NumberDecimal() needs a number.');
                this.value = v;
              }
              NumberDecimal.prototype.valueOf = function () { return Number(this.value); };
              NumberDecimal.prototype.toString = function () { return this.value; };

              function NumberInt(v) { return Math.trunc(Number(v)) | 0; }

              function ISODate(s) {
                if (s === undefined) return new Date();
                s = String(s).trim().replace(' ', 'T');
                if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00Z';
                else if (!/(Z|[-+]\d{2}:?\d{2})$/.test(s)) s += 'Z';
                const d = new Date(s);
                if (isNaN(d)) throw new Error('ISODate() cannot read "' + s + '".');
                return d;
              }

              // A BSON value JavaScript has no type for (binary, timestamp, regex with Mongo options...): kept as its shell text.
              function Raw(text) { this.text = text; }
              Raw.prototype.toString = function () { return this.text; };
              const raw = text => new Raw(text);
              const quoted = v => JSON.stringify(String(v));

              function toShell(v) {
                if (v === null || v === undefined) return 'null';
                switch (typeof v) {
                  case 'string': return JSON.stringify(v);
                  case 'boolean': return String(v);
                  case 'bigint': return 'NumberLong("' + v + '")';
                  case 'number':
                    if (!Number.isFinite(v)) return Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity';
                    // Whole numbers past int32 stay doubles, as in mongosh.
                    if (Number.isInteger(v) && Math.abs(v) > 2147483647 && Math.abs(v) < 1e21) return v.toFixed(0) + '.0';
                    return String(v);
                  case 'function': throw new Error('A function cannot be sent to the server.');
                  case 'symbol': throw new Error('A symbol cannot be sent to the server.');
                }
                if (v instanceof ObjectId) return 'ObjectId("' + v.str + '")';
                if (v instanceof NumberLong) return 'NumberLong("' + v.value + '")';
                if (v instanceof NumberDecimal) return 'NumberDecimal("' + v.value + '")';
                if (v instanceof Raw) return v.text;
                if (v instanceof Date) {
                  if (isNaN(v)) throw new Error('An invalid date cannot be sent to the server.');
                  return 'ISODate("' + v.toISOString() + '")';
                }
                if (v instanceof RegExp) return '{"$regex": ' + JSON.stringify(v.source) + ', "$options": "' + v.flags.replace(/[^ims]/g, '') + '"}';
                if (v instanceof Cursor) return toShell(v.toArray());
                if (v instanceof Set) return toShell(Array.from(v));
                if (v instanceof Map) return toShell(Object.fromEntries(v));
                if (Array.isArray(v)) return '[' + v.map(toShell).join(', ') + ']';
                const parts = [];
                for (const k of Object.keys(v)) if (v[k] !== undefined) parts.push(JSON.stringify(k) + ': ' + toShell(v[k]));
                return '{' + parts.join(', ') + '}';
              }

              // Shell text from the server side back into values. The names are passed in: a script cannot shadow them.
              const fromShell = text => new Function('ObjectId', 'ISODate', 'NumberLong', 'NumberDecimal', '__raw', 'return (' + text + ');')(
                ObjectId, ISODate, NumberLong, NumberDecimal, raw);

              const call = (name, args) => {
                args = Array.from(args);
                while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
                return { name, args: args.map(toShell) };
              };
              const exec = (database, collection, calls) => fromShell(run(database, collection, JSON.stringify(calls)));
              const one = r => (Array.isArray(r) && r.length === 1 ? r[0] : r);

              class Cursor {
                constructor(database, collection, calls) {
                  this._d = database; this._c = collection; this._calls = calls; this._docs = null; this._at = 0;
                }
                _chain(name, args) {
                  if (this._docs) throw new Error('.' + name + '() must come before the cursor is read.');
                  return new Cursor(this._d, this._c, this._calls.concat([call(name, args)]));
                }
                sort(v) { return this._chain('sort', [v]); }
                limit(n) { return this._chain('limit', [n]); }
                skip(n) { return this._chain('skip', [n]); }
                project(v) { return this._chain('project', [v]); }
                projection(v) { return this._chain('project', [v]); }
                hint(v) { return this._chain('hint', [v]); }
                pretty() { return this; }
                _load() { return this._docs || (this._docs = exec(this._d, this._c, this._calls)); }
                toArray() { const rest = this._load().slice(this._at); this._at = this._docs.length; return rest; }
                forEach(fn) { for (const doc of this.toArray()) fn(doc); }
                map(fn) { return this.toArray().map(fn); }
                hasNext() { return this._at < this._load().length; }
                next() {
                  if (!this.hasNext()) throw new Error('The cursor has no more documents.');
                  return this._docs[this._at++];
                }
                count() { return Number(exec(this._d, this._c, this._calls.concat([call('count', [])]))); }
                itcount() { return this.toArray().length; }
                [Symbol.iterator]() { return this.toArray()[Symbol.iterator](); }
              }

              const COUNTS = ['countDocuments', 'count', 'estimatedDocumentCount'];
              const SINGLE = ['createIndex', 'dropIndex', 'stats'];
              const PLAIN = ['distinct', 'insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany',
                'getIndexes', 'drop', 'renameCollection'];
              const hasOwn = (o, p) => Object.prototype.hasOwnProperty.call(o, p);

              function collection(database, name) {
                const send = (method, args) => exec(database, name, [call(method, args)]);
                const methods = {
                  find: (...a) => new Cursor(database, name, [call('find', a)]),
                  aggregate: (...a) => new Cursor(database, name, [call('aggregate', a)]),
                  findOne: (...a) => { const r = send('findOne', a); return r.length > 0 ? r[0] : null; },
                  getName: () => name,
                  toString: () => 'db.' + name,
                };
                for (const m of COUNTS) methods[m] = (...a) => Number(send(m, a));
                for (const m of SINGLE) methods[m] = (...a) => one(send(m, a));
                for (const m of PLAIN) methods[m] = (...a) => send(m, a);
                // Called itself: the last name was not a method.
                const target = function () {
                  throw new Error('db.' + name + '() is not a method DbStudio knows. On a collection: ' + Object.keys(methods).filter(k => k !== 'toString' && k !== 'getName').join(', ') + '.');
                };
                return new Proxy(target, {
                  get(t, p) {
                    if (typeof p !== 'string' || p === 'then' || p === 'toJSON') return undefined;
                    if (hasOwn(methods, p)) return methods[p];
                    return collection(database, name + '.' + p); // collection names may hold dots
                  },
                });
              }

              function database(name) {
                const send = (method, args) => exec(name, null, [call(method, args)]);
                const methods = {
                  getSiblingDB: n => database(String(n)),
                  getCollection: n => collection(name, String(n)),
                  getName: () => send('getName', []),
                  getCollectionNames: () => send('getCollectionNames', []),
                  createCollection: (...a) => one(send('createCollection', a)),
                  runCommand: (...a) => one(send('runCommand', a)),
                  adminCommand: (...a) => one(send('adminCommand', a)),
                  stats: () => one(send('stats', [])),
                  toString: () => (name === null ? 'db' : 'db.getSiblingDB(' + quoted(name) + ')'),
                };
                return new Proxy({}, {
                  get(t, p) {
                    if (typeof p !== 'string' || p === 'then' || p === 'toJSON') return undefined;
                    if (hasOwn(methods, p)) return methods[p];
                    return collection(name, p);
                  },
                });
              }

              const tojson = v => { try { return pretty(toShell(v)); } catch (e) { return String(v); } };
              const print = (...a) => { print0(a.map(v => (typeof v === 'string' ? v : tojson(v))).join(' ')); };

              Object.assign(globalThis, {
                db: database(null), // null: the database the tab is in ("use x" changes it)
                ObjectId, ISODate, NumberLong, NumberInt, NumberDecimal,
                UUID: s => raw('UUID(' + quoted(s) + ')'),
                BinData: (t, s) => raw('BinData(' + Number(t) + ', ' + quoted(s) + ')'),
                Timestamp: (t, i) => raw('Timestamp(' + Number(t || 0) + ', ' + Number(i || 0) + ')'),
                MinKey: raw('MinKey'), MaxKey: raw('MaxKey'),
                print, printjson: v => { print0(tojson(v)); }, tojson,
                console: { log: print, info: print, warn: print, error: print },
                sleep: ms => sleep0(Number(ms) || 0),
              });

              // What a statement ended with, for the host.
              globalThis.__describe = v => {
                if (v === undefined) return JSON.stringify({ kind: 'none' });
                if (v instanceof Cursor && !v._docs) return JSON.stringify({ kind: 'cursor', d: v._d, c: v._c, calls: v._calls });
                let text;
                try { text = toShell(v); } catch (e) { text = JSON.stringify(String(v)); }
                return JSON.stringify({ kind: 'value', text });
              };
            })();
            """;
    }
}
