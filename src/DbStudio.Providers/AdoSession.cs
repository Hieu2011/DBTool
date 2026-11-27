using System.Data;
using System.Data.Common;
using DbStudio.Core;

namespace DbStudio.Providers;

public abstract partial class AdoProviderBase
{
    /// <summary>Connection kept open for one editor tab, with an optional manual transaction.</summary>
    private sealed class AdoSession(AdoProviderBase objProvider, ConnectionProfile objProfile, DbConnection objInitialConn) : IDbSession, IResumableSession
    {
        private const string StatementSavepoint = "dbstudio_stmt";

        private DbConnection _objConn = objInitialConn;
        private DbTransaction? _objTransaction;

        /// <summary>A cut result left open: any other use of the connection closes it first.</summary>
        private sealed record OpenCursor(string Id, DbCommand Command, DbDataReader Reader, bool Savepoint, DbTransaction? OwnTransaction);
        private OpenCursor? _objCursor;

        public bool InTransaction => _objTransaction is not null;

        public DateTime? CursorUsedUtc { get; private set; }

        public Task<QueryResult> ExecuteAsync(string strSql, int intMaxRows, bool boolAutoCommit, CancellationToken objCancelToken,
            IRowSink? objSink = null) => RunAsync(strSql, intMaxRows, boolAutoCommit, objCancelToken, objSink, boolKeep: false, 0);

        public Task<QueryResult> ExecuteKeepingAsync(string strSql, int intMaxRows, bool boolAutoCommit, CancellationToken objCancelToken,
            IRowSink? objSink = null, int intSkipRows = 0) =>
            RunAsync(strSql, intMaxRows, boolAutoCommit, objCancelToken, objSink, boolKeep: true, intSkipRows);

        public async Task<QueryResult?> FetchMoreAsync(string strCursor, int intMaxRows, CancellationToken objCancelToken)
        {
            if (_objCursor is not { } objCursor || objCursor.Id != strCursor) return null;
            if (_objConn.State != ConnectionState.Open) { await CloseCursorAsync(); return null; }

            var objStopwatch = System.Diagnostics.Stopwatch.StartNew();
            var objResult = new QueryResult();
            using var objCancelReg = objCancelToken.Register(() => { try { objCursor.Command.Cancel(); } catch { /* already finished */ } });
            try { await objProvider.ReadRowsAsync(objCursor.Reader, objResult, intMaxRows, objCancelToken, boolResume: true); }
            catch { await CloseCursorAsync(); throw; }

            if (objResult.Truncated)
            {
                objResult.Cursor = objCursor.Id;
                CursorUsedUtc = DateTime.UtcNow;
            }
            else await CloseCursorAsync(boolReadAll: true);
            objResult.ElapsedMs = objStopwatch.ElapsedMilliseconds;
            return objResult;
        }

        public Task CloseCursorAsync() => CloseCursorAsync(boolReadAll: false);

        /// <summary>boolReadAll false: rows remain, so the statement is cancelled (a dispose alone would drain them all).</summary>
        private async Task CloseCursorAsync(bool boolReadAll)
        {
            if (_objCursor is not { } objCursor) return;
            _objCursor = null;
            CursorUsedUtc = null;
            if (!boolReadAll) { try { objCursor.Command.Cancel(); } catch { } }
            try { await objCursor.Reader.DisposeAsync(); } catch { /* cancel error from the drain, or a broken connection */ }
            try { await objCursor.Command.DisposeAsync(); } catch { }
            if (objCursor.Savepoint) await EndSavepointAsync(boolRollback: false);
            if (objCursor.OwnTransaction is { } objOwn)
            {
                // Read to the end: what the statement did is kept. Cut short: it ends as a rollback, like any cancelled statement.
                if (boolReadAll) { try { await objOwn.CommitAsync(); } catch { } }
                try { await objOwn.DisposeAsync(); } catch { }
            }
        }

        private async Task<QueryResult> RunAsync(string strSql, int intMaxRows, bool boolAutoCommit, CancellationToken objCancelToken,
            IRowSink? objSink, bool boolKeep, int intSkipRows)
        {
            await CloseCursorAsync();
            await EnsureOpenAsync(objCancelToken);
            if (!boolAutoCommit && _objTransaction is null)
                _objTransaction = await _objConn.BeginTransactionAsync(objCancelToken);

            // Keeps one bad statement (or a cancelled read) from aborting the user's transaction.
            var boolSavepoint = _objTransaction is not null && objProvider.SavepointPerStatement;
            if (boolSavepoint) await _objTransaction!.SaveAsync(StatementSavepoint, objCancelToken);

            QueryResult objResult;
            var objSlot = boolKeep ? new CursorSlot { SkipRows = Math.Max(intSkipRows, 0) } : null;
            try
            {
                objResult = _objTransaction is null
                    ? await objProvider.ExecuteAutoCommitAsync(_objConn, strSql, intMaxRows, objCancelToken, objSink, objSlot)
                    : await objProvider.ExecuteOnAsync(_objConn, _objTransaction, strSql, intMaxRows, objCancelToken, objSink: objSink, objKeep: objSlot);
            }
            catch
            {
                if (boolSavepoint) await EndSavepointAsync(boolRollback: true);
                throw;
            }
            if (objSlot is { Command: { } objCmd, Reader: { } objReader })
            {
                // The savepoint cannot be released while the statement is open: closing the cursor ends it.
                _objCursor = new OpenCursor(Guid.NewGuid().ToString("N"), objCmd, objReader, boolSavepoint, objSlot.Transaction);
                CursorUsedUtc = DateTime.UtcNow;
                objResult.Cursor = _objCursor.Id;
                return objResult;
            }
            if (boolSavepoint) await EndSavepointAsync(boolRollback: false);
            return objResult;
        }

        public async Task CommitAsync(CancellationToken objCancelToken)
        {
            await CloseCursorAsync();
            await EndTransactionAsync(true, objCancelToken);
        }

        public async Task RollbackAsync(CancellationToken objCancelToken)
        {
            await CloseCursorAsync();
            await EndTransactionAsync(false, objCancelToken);
        }

        public async ValueTask DisposeAsync()
        {
            await CloseCursorAsync();
            await DisposeTransactionAsync(); // uncommitted work is rolled back
            await _objConn.DisposeAsync();
        }

        private async Task EndTransactionAsync(bool boolCommit, CancellationToken objCancelToken)
        {
            if (_objTransaction is null) return;
            try
            {
                if (boolCommit) await _objTransaction.CommitAsync(objCancelToken);
                else await _objTransaction.RollbackAsync(objCancelToken);
            }
            finally
            {
                await DisposeTransactionAsync();
            }
        }

        /// <summary>Never throws: the statement's own outcome is what the user must see.</summary>
        private async Task EndSavepointAsync(bool boolRollback)
        {
            if (_objTransaction is null) return;
            if (!boolRollback)
            {
                try { await _objTransaction.ReleaseAsync(StatementSavepoint); return; }
                catch { /* a truncated read was cancelled server-side: transaction is aborted, roll back below */ }
            }
            try { await _objTransaction.RollbackAsync(StatementSavepoint); }
            catch { /* user ended the transaction in SQL, or the connection is gone */ }
        }

        private async Task EnsureOpenAsync(CancellationToken objCancelToken)
        {
            if (_objConn.State == ConnectionState.Open) return;

            var boolLostTransaction = _objTransaction is not null;
            await DisposeTransactionAsync();
            await _objConn.DisposeAsync();
            _objConn = objProvider.CreateConnection(objProfile);
            await _objConn.OpenAsync(objCancelToken);

            if (boolLostTransaction)
                throw new InvalidOperationException(
                    "The connection was lost and its open transaction was rolled back. Reconnected: run the statement again.");
        }

        private async Task DisposeTransactionAsync()
        {
            if (_objTransaction is null) return;
            try { await _objTransaction.DisposeAsync(); } catch { /* connection already broken */ }
            _objTransaction = null;
        }
    }
}
