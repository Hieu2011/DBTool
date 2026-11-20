using System.Text.Json;
using System.Threading.Channels;
using DbStudio.Core;

namespace DbStudio.Host.Services;

/// <summary>Hands the rows a provider reads to the HTTP response writer, so the grid fills while the query runs.</summary>
internal sealed class ChannelRowSink : IRowSink
{
    // Unbounded: the provider already stops at MaxRows, and its read loop must not block on the network.
    private readonly Channel<object> _objChannel = Channel.CreateUnbounded<object>(
        new UnboundedChannelOptions { SingleReader = true, SingleWriter = true });

    /// <summary>The statement returned a result set and its rows went through here.</summary>
    public bool Started { get; private set; }

    public ChannelReader<object> Reader => _objChannel.Reader;

    public void Begin(IReadOnlyList<ResultColumn> lstColumns)
    {
        Started = true;
        _objChannel.Writer.TryWrite(lstColumns);
    }

    public bool Write(object?[] arrRow)
    {
        _objChannel.Writer.TryWrite(arrRow);
        return true;
    }

    public void Complete() => _objChannel.Writer.TryComplete();
}

/// <summary>Writes the NDJSON lines of POST /query/stream: columns, row batches, then done or error.</summary>
internal static class QueryStream
{
    private const int BatchRows = 500;
    private static readonly byte[] NewLine = "\n"u8.ToArray();

    public static async Task WriteLineAsync(Stream objBody, object objLine, JsonSerializerOptions objJson, CancellationToken objCancelToken)
    {
        await JsonSerializer.SerializeAsync(objBody, objLine, objJson, objCancelToken);
        await objBody.WriteAsync(NewLine, objCancelToken);
        await objBody.FlushAsync(objCancelToken);
    }

    /// <summary>Runs until the sink completes.</summary>
    public static async Task PumpAsync(ChannelReader<object> objReader, Stream objBody, JsonSerializerOptions objJson,
        CancellationToken objCancelToken)
    {
        var lstBatch = new List<object?[]>(BatchRows);
        async Task FlushBatchAsync()
        {
            if (lstBatch.Count == 0) return;
            await WriteLineAsync(objBody, new { t = "rows", rows = lstBatch }, objJson, objCancelToken);
            lstBatch.Clear();
        }

        while (await objReader.WaitToReadAsync(objCancelToken))
        {
            while (objReader.TryRead(out var objItem))
            {
                if (objItem is IReadOnlyList<ResultColumn> lstColumns)
                    await WriteLineAsync(objBody, new { t = "columns", columns = lstColumns }, objJson, objCancelToken);
                else
                {
                    lstBatch.Add((object?[])objItem);
                    if (lstBatch.Count >= BatchRows) await FlushBatchAsync();
                }
            }
            await FlushBatchAsync();
        }
    }
}
