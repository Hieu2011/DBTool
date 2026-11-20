using System.Collections.Concurrent;

namespace DbStudio.Host.Services;

/// <summary>Running queries by client-generated id, so the Stop button can cancel them.</summary>
internal sealed class QueryRegistry
{
    private readonly ConcurrentDictionary<Guid, CancellationTokenSource> _dicRunning = new();

    public CancellationTokenSource Begin(Guid guidQueryId, CancellationToken objRequestAborted)
    {
        var objCts = CancellationTokenSource.CreateLinkedTokenSource(objRequestAborted);
        _dicRunning[guidQueryId] = objCts;
        return objCts;
    }

    public void End(Guid guidQueryId) => _dicRunning.TryRemove(guidQueryId, out _);

    public bool Cancel(Guid guidQueryId)
    {
        if (!_dicRunning.TryGetValue(guidQueryId, out var objCts)) return false;
        objCts.Cancel();
        return true;
    }
}
