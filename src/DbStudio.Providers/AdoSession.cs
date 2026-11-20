using System.Data;
using System.Data.Common;
using DbStudio.Core;

namespace DbStudio.Providers;

public abstract partial class AdoProviderBase
{
    /// <summary>Connection kept open for one editor tab, with an optional manual transaction.</summary>
    private sealed class AdoSession(AdoProviderBase objProvider, ConnectionProfile objProfile, DbConnection objInitialConn) : IDbSession
    {
        private const string StatementSavepoint = "dbstudio_stmt";

        private DbConnection _objConn = objInitialConn;
        private DbTransaction? _objTransaction;

        public bool InTransaction => _objTransaction is not null;

        public async Task<QueryResult> ExecuteAsync(string strSql, int intMaxRows, bool boolAutoCommit, CancellationToken objCancelToken,
            IRowSink? objSink = null)
        {
            await EnsureOpenAsync(objCancelToken);
            if (!boolAutoCommit && _objTransaction is null)
                _objTransaction = await _objConn.BeginTransactionAsync(objCancelToken);

            // Keeps one bad statement (or a cancelled read) from aborting the user's transaction.
            var boolSavepoint = _objTransaction is not null && objProvider.SavepointPerStatement;
            if (boolSavepoint) await _objTransaction!.SaveAsync(StatementSavepoint, objCancelToken);

            QueryResult objResult;
            try
            {
                objResult = _objTransaction is null
                    ? await objProvider.ExecuteAutoCommitAsync(_objConn, strSql, intMaxRows, objCancelToken, objSink)
                    : await objProvider.ExecuteOnAsync(_objConn, _objTransaction, strSql, intMaxRows, objCancelToken, objSink: objSink);
            }
            catch
            {
                if (boolSavepoint) await EndSavepointAsync(boolRollback: true);
                throw;
            }
            if (boolSavepoint) await EndSavepointAsync(boolRollback: false);
            return objResult;
        }

        public Task CommitAsync(CancellationToken objCancelToken) => EndTransactionAsync(true, objCancelToken);

        public Task RollbackAsync(CancellationToken objCancelToken) => EndTransactionAsync(false, objCancelToken);

        public async ValueTask DisposeAsync()
        {
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
