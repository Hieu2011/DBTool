using System.Text.Json;

namespace DbStudio.Host.Services;

/// <summary>One statement the user ran in an editor. Rows: rows returned or affected, when known.</summary>
public sealed record HistoryEntry(Guid Id, Guid ConnectionId, string Sql, DateTime At, long ElapsedMs, long? Rows, string? Error);

public sealed record HistoryAddRequest(Guid ConnectionId, string Sql, long ElapsedMs = 0, long? Rows = null, string? Error = null);

/// <summary>
/// Statements run from the editors, newest last, in %APPDATA%\DbStudio\history.json (plain text: it is the user's own SQL).
/// Only what the UI reports is kept: grids, imports and exports do not land here.
/// </summary>
internal sealed class HistoryStore
{
    private const int MaxEntries = 2000;
    private const int MaxSqlLength = 50_000;
    private const int MaxErrorLength = 2000;

    private readonly string _strFile;
    private readonly object _objLock = new();
    private List<HistoryEntry>? _lstEntries;

    public HistoryStore()
    {
        var strDir = AppPaths.DataDirectory;
        Directory.CreateDirectory(strDir);
        _strFile = Path.Combine(strDir, "history.json");
    }

    /// <summary>Newest first.</summary>
    public List<HistoryEntry> List(Guid guidConnectionId, int intLimit)
    {
        lock (_objLock)
            return Load().Where(objEntry => objEntry.ConnectionId == guidConnectionId).Reverse().Take(intLimit).ToList();
    }

    public void Add(HistoryAddRequest objRequest)
    {
        var strSql = objRequest.Sql.Trim();
        if (strSql.Length == 0) return;
        if (strSql.Length > MaxSqlLength) strSql = strSql[..MaxSqlLength];
        var strError = objRequest.Error is { Length: > MaxErrorLength } ? objRequest.Error[..MaxErrorLength] : objRequest.Error;

        lock (_objLock)
        {
            var lstEntries = Load();
            // Running the same statement again moves it to the top instead of piling up copies.
            var intLast = lstEntries.FindLastIndex(objEntry => objEntry.ConnectionId == objRequest.ConnectionId);
            if (intLast >= 0 && lstEntries[intLast].Sql == strSql) lstEntries.RemoveAt(intLast);

            lstEntries.Add(new HistoryEntry(Guid.NewGuid(), objRequest.ConnectionId, strSql, DateTime.Now,
                objRequest.ElapsedMs, objRequest.Rows, strError));
            if (lstEntries.Count > MaxEntries) lstEntries.RemoveRange(0, lstEntries.Count - MaxEntries);
            Persist(lstEntries);
        }
    }

    public void RemoveConnection(Guid guidConnectionId)
    {
        lock (_objLock)
        {
            var lstEntries = Load();
            if (lstEntries.RemoveAll(objEntry => objEntry.ConnectionId == guidConnectionId) > 0) Persist(lstEntries);
        }
    }

    private List<HistoryEntry> Load()
    {
        if (_lstEntries is not null) return _lstEntries;
        try
        {
            _lstEntries = File.Exists(_strFile) ? JsonSerializer.Deserialize<List<HistoryEntry>>(File.ReadAllText(_strFile)) : null;
        }
        catch (Exception objEx) when (objEx is JsonException or IOException)
        {
            // A broken history file only costs the history.
        }
        return _lstEntries ??= [];
    }

    private void Persist(List<HistoryEntry> lstEntries)
    {
        try
        {
            var strTmp = _strFile + ".tmp";
            File.WriteAllText(strTmp, JsonSerializer.Serialize(lstEntries));
            File.Move(strTmp, _strFile, overwrite: true);
        }
        catch (Exception objEx) when (objEx is IOException or UnauthorizedAccessException)
        {
            // History is a convenience: never fail a query over it.
        }
    }
}
