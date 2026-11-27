namespace DbStudio.Core;

public interface IDbProvider
{
    DbKind Kind { get; }

    /// <summary>Opens a connection and closes it again. Throws on failure.</summary>
    Task TestAsync(ConnectionProfile objProfile, CancellationToken objCancelToken);

    /// <summary>Runs one statement and returns at most <paramref name="intMaxRows"/> rows.
    /// With a sink, the rows of a plain result set go to it as they are read and the result comes back with
    /// its columns but no rows; results the provider builds itself (opened cursors) are still returned whole.</summary>
    Task<QueryResult> ExecuteAsync(ConnectionProfile objProfile, string strSql, int intMaxRows, CancellationToken objCancelToken,
        IRowSink? objSink = null);

    /// <summary>Runs one statement and hands every row to the sink as it is read, without keeping them in memory
    /// (export of large tables). Runs on its own connection.</summary>
    Task StreamAsync(ConnectionProfile objProfile, string strSql, IRowSink objSink, CancellationToken objCancelToken);

    /// <summary>Which table and column each result column of a SELECT comes from, and the primary keys of those tables,
    /// so the grid can write edits back. The statement is described, not run.</summary>
    Task<ResultOrigin> DescribeResultAsync(ConnectionProfile objProfile, string strSql, CancellationToken objCancelToken);

    /// <summary>Opens a connection that stays open for one editor tab (transaction, session settings).</summary>
    Task<IDbSession> OpenSessionAsync(ConnectionProfile objProfile, CancellationToken objCancelToken);

    /// <summary>Tables, views and their columns, used for the object tree and autocomplete.
    /// strSchema null: the default load. A name: only that schema, for providers that load one schema at a time.</summary>
    Task<SchemaMetadata> LoadMetadataAsync(ConnectionProfile objProfile, string? strSchema, CancellationToken objCancelToken);

    /// <summary>Detail grids and DDL of one object.
    /// boolFull: also the DDL and the slower grids (code that uses a table), for the object viewer.
    /// strSection: only the grid with that title, for one folder of the object tree.</summary>
    Task<ObjectDetail> LoadObjectAsync(ConnectionProfile objProfile, DbObjectInfo objObject, bool boolFull, string? strSection,
        CancellationToken objCancelToken);

    /// <summary>Parameters of a procedure or function, for the Execute form.</summary>
    Task<RoutineInfo> LoadRoutineAsync(ConnectionProfile objProfile, DbObjectInfo objRoutine, CancellationToken objCancelToken);

    /// <summary>Calls a procedure or function with the given arguments and opens the cursors it returns.
    /// Runs on its own connection and commits.</summary>
    Task<RoutineResult> ExecuteRoutineAsync(ConnectionProfile objProfile, DbObjectInfo objRoutine,
        IReadOnlyList<RoutineArgument> lstArguments, int intMaxRows, CancellationToken objCancelToken);

    /// <summary>Turns a driver exception into something the editor can show (message + position).</summary>
    QueryError DescribeError(Exception objEx);
}

/// <summary>Receives the rows of a streamed statement one by one.</summary>
public interface IRowSink
{
    /// <summary>Called once, before the first row.</summary>
    void Begin(IReadOnlyList<ResultColumn> lstColumns);

    /// <summary>StreamAsync reuses the array for the next row: copy what must be kept. False stops that read (the sink is full).</summary>
    bool Write(object?[] arrRow);
}

/// <summary>One open connection. Not thread-safe: the caller runs one call at a time.</summary>
public interface IDbSession : IAsyncDisposable
{
    bool InTransaction { get; }

    /// <summary>With <paramref name="boolAutoCommit"/> false, a transaction is started and kept until Commit/Rollback.</summary>
    Task<QueryResult> ExecuteAsync(string strSql, int intMaxRows, bool boolAutoCommit, CancellationToken objCancelToken,
        IRowSink? objSink = null);

    Task CommitAsync(CancellationToken objCancelToken);
    Task RollbackAsync(CancellationToken objCancelToken);
}

/// <summary>A session that can leave a cut result open and read on from it, instead of running the statement again.</summary>
public interface IResumableSession
{
    /// <summary>When the open result was last read; null when none is open.</summary>
    DateTime? CursorUsedUtc { get; }

    /// <summary>As ExecuteAsync; a result cut at intMaxRows stays open and carries QueryResult.Cursor.
    /// intSkipRows: the first rows are read and dropped (the caller has them from an earlier run).</summary>
    Task<QueryResult> ExecuteKeepingAsync(string strSql, int intMaxRows, bool boolAutoCommit, CancellationToken objCancelToken,
        IRowSink? objSink = null, int intSkipRows = 0);

    /// <summary>The next rows (Columns stays empty). Null when that result is no longer open.</summary>
    Task<QueryResult?> FetchMoreAsync(string strCursor, int intMaxRows, CancellationToken objCancelToken);

    /// <summary>Never throws.</summary>
    Task CloseCursorAsync();
}

public interface IConnectionStore
{
    IReadOnlyList<ConnectionProfile> List();
    ConnectionProfile? Get(Guid guidId);
    /// <summary>Insert or update. A null/empty password on update keeps the stored one.</summary>
    ConnectionProfile Save(ConnectionProfile objProfile);
    bool Delete(Guid guidId);
}
