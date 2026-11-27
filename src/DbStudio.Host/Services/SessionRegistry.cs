using System.Collections.Concurrent;
using DbStudio.Core;

namespace DbStudio.Host.Services;

/// <summary>One open DB session per editor tab, by client-generated id. Opened on first use.</summary>
internal sealed class SessionRegistry : IAsyncDisposable
{
    private const string BusyMessage = "Another statement is still running in this tab.";

    private sealed class Entry(Guid guidConnectionId)
    {
        public Guid ConnectionId { get; } = guidConnectionId;
        /// <summary>A connection runs one command at a time.</summary>
        public SemaphoreSlim Gate { get; } = new(1, 1);
        /// <summary>Cancelled when the tab closes, so a running statement stops.</summary>
        public CancellationTokenSource Closed { get; } = new();
        public IDbSession? Session { get; set; }
    }

    // An open result keeps a statement (on PostgreSQL: a snapshot and a table lock) alive on the server.
    private static readonly TimeSpan CursorIdleLimit = TimeSpan.FromMinutes(5);

    private readonly ConcurrentDictionary<Guid, Entry> _dicSessions = new();
    private readonly System.Threading.Timer _objSweeper;

    public SessionRegistry() =>
        _objSweeper = new System.Threading.Timer(_ => _ = CloseIdleCursorsAsync(), null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));

    /// <summary>Results nobody scrolled for a while are closed; the grid then offers to run the statement again.</summary>
    private async Task CloseIdleCursorsAsync()
    {
        foreach (var objEntry in _dicSessions.Values)
        {
            if (objEntry.Session is not IResumableSession { CursorUsedUtc: { } dtUsed } || DateTime.UtcNow - dtUsed < CursorIdleLimit) continue;
            if (!await objEntry.Gate.WaitAsync(0, CancellationToken.None)) continue; // busy: looked at again next minute
            try { if (objEntry.Session is IResumableSession objSession) await objSession.CloseCursorAsync(); }
            catch { /* the sweep must never bring the app down */ }
            finally { objEntry.Gate.Release(); }
        }
    }

    /// <summary>Null when the session or that open result is gone.</summary>
    public async Task<QueryResult?> FetchMoreAsync(Guid guidSessionId, string strCursor, int intMaxRows, CancellationToken objCancelToken)
    {
        if (!_dicSessions.TryGetValue(guidSessionId, out var objEntry)) return null;
        if (!await objEntry.Gate.WaitAsync(0, CancellationToken.None)) throw new InvalidOperationException(BusyMessage);
        try
        {
            if (objEntry.Session is not IResumableSession objSession) return null;
            using var objLinked = CancellationTokenSource.CreateLinkedTokenSource(objCancelToken, objEntry.Closed.Token);
            return await objSession.FetchMoreAsync(strCursor, intMaxRows, objLinked.Token);
        }
        finally
        {
            objEntry.Gate.Release();
        }
    }

    public async Task<QueryResult> ExecuteAsync(Guid guidSessionId, ConnectionProfile objProfile, IDbProvider objProvider,
        string strSql, int intMaxRows, bool boolAutoCommit, CancellationToken objCancelToken, IRowSink? objSink = null,
        bool boolKeepOpen = false, int intSkipRows = 0)
    {
        var objEntry = _dicSessions.GetOrAdd(guidSessionId, _ => new Entry(objProfile.Id));
        if (!await objEntry.Gate.WaitAsync(0, CancellationToken.None)) throw new InvalidOperationException(BusyMessage);
        try
        {
            objEntry.Closed.Token.ThrowIfCancellationRequested();
            using var objLinked = CancellationTokenSource.CreateLinkedTokenSource(objCancelToken, objEntry.Closed.Token);
            objEntry.Session ??= await objProvider.OpenSessionAsync(objProfile, objLinked.Token);
            // Without the skip the caller would get the rows it already has.
            if (intSkipRows > 0 && !(boolKeepOpen && objEntry.Session is IResumableSession))
                throw new NotSupportedException("This kind of connection cannot read on from a row offset.");
            return boolKeepOpen && objEntry.Session is IResumableSession objResumable
                ? await objResumable.ExecuteKeepingAsync(strSql, intMaxRows, boolAutoCommit, objLinked.Token, objSink, intSkipRows)
                : await objEntry.Session.ExecuteAsync(strSql, intMaxRows, boolAutoCommit, objLinked.Token, objSink);
        }
        finally
        {
            objEntry.Gate.Release();
        }
    }

    /// <summary>Connects now instead of at the first statement. Waits for a running call instead of failing:
    /// a second open of the same tab must simply find the session there.</summary>
    public async Task OpenAsync(Guid guidSessionId, ConnectionProfile objProfile, IDbProvider objProvider, CancellationToken objCancelToken)
    {
        var objEntry = _dicSessions.GetOrAdd(guidSessionId, _ => new Entry(objProfile.Id));
        using var objLinked = CancellationTokenSource.CreateLinkedTokenSource(objCancelToken, objEntry.Closed.Token);
        await objEntry.Gate.WaitAsync(objLinked.Token);
        try
        {
            objEntry.Session ??= await objProvider.OpenSessionAsync(objProfile, objLinked.Token);
        }
        finally
        {
            objEntry.Gate.Release();
        }
    }

    /// <summary>No-op when the session doesn't exist or has no open transaction.</summary>
    public async Task EndTransactionAsync(Guid guidSessionId, bool boolCommit, CancellationToken objCancelToken)
    {
        if (!_dicSessions.TryGetValue(guidSessionId, out var objEntry)) return;
        if (!await objEntry.Gate.WaitAsync(0, CancellationToken.None)) throw new InvalidOperationException(BusyMessage);
        try
        {
            if (objEntry.Session is null) return;
            if (boolCommit) await objEntry.Session.CommitAsync(objCancelToken);
            else await objEntry.Session.RollbackAsync(objCancelToken);
        }
        finally
        {
            objEntry.Gate.Release();
        }
    }

    public async Task CloseAsync(Guid guidSessionId)
    {
        if (_dicSessions.TryRemove(guidSessionId, out var objEntry)) await CloseEntryAsync(objEntry);
    }

    /// <summary>The profile changed or was deleted: its sessions hold stale credentials.</summary>
    public async Task CloseByConnectionAsync(Guid guidConnectionId)
    {
        foreach (var objPair in _dicSessions.Where(objPair => objPair.Value.ConnectionId == guidConnectionId).ToList())
            await CloseAsync(objPair.Key);
    }

    public async ValueTask DisposeAsync()
    {
        await _objSweeper.DisposeAsync();
        foreach (var guidSessionId in _dicSessions.Keys.ToList())
            await CloseAsync(guidSessionId);
    }

    private static async Task CloseEntryAsync(Entry objEntry)
    {
        objEntry.Closed.Cancel();
        await objEntry.Gate.WaitAsync(); // the cancelled statement unwinds first
        try
        {
            if (objEntry.Session is not null)
            {
                try { await objEntry.Session.DisposeAsync(); } catch { /* connection already broken */ }
                objEntry.Session = null;
            }
        }
        finally
        {
            objEntry.Gate.Release();
        }
    }
}
