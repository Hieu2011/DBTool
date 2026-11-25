using System.Text.Json;

namespace DbStudio.Host.Services;

/// <summary>An editor tab as it was when the app closed. Text is the editor's content, saved to a file or not.</summary>
public sealed record WorkspaceTab(string Id, Guid ConnectionId, int Number, string? Title, string? FilePath, string Text, bool Dirty);

public sealed record Workspace(string? ActiveTabId, List<WorkspaceTab> Tabs, DateTime SavedAt = default);

/// <summary>
/// The editor tabs of the last run, in %APPDATA%\DbStudio\workspace.json, so unsaved text survives closing the app.
/// Kept for a week after the last save, then forgotten.
/// </summary>
internal sealed class WorkspaceStore
{
    private const int MaxTabs = 100;
    private const int MaxTextLength = 2_000_000;
    private static readonly TimeSpan KeepFor = TimeSpan.FromDays(7);

    private readonly string _strFile;
    private readonly object _objLock = new();

    public WorkspaceStore()
    {
        var strDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "DbStudio");
        Directory.CreateDirectory(strDir);
        _strFile = Path.Combine(strDir, "workspace.json");
    }

    /// <summary>Null: nothing saved, the file is unreadable, or it is older than a week (then it is deleted).</summary>
    public Workspace? Load()
    {
        lock (_objLock)
        {
            try
            {
                if (!File.Exists(_strFile)) return null;
                var objSaved = JsonSerializer.Deserialize<Workspace>(File.ReadAllText(_strFile));
                if (objSaved?.Tabs is null) return null;
                if (DateTime.UtcNow - objSaved.SavedAt <= KeepFor) return objSaved;
                File.Delete(_strFile);
            }
            catch (Exception objEx) when (objEx is JsonException or IOException or UnauthorizedAccessException)
            {
                // A broken file only costs the last session.
            }
            return null;
        }
    }

    /// <summary>Replaces the saved session. A tab too long to keep is left out, the rest is still saved.</summary>
    public void Save(Workspace objWorkspace)
    {
        var lstTabs = (objWorkspace.Tabs ?? [])
            .Where(objTab => !string.IsNullOrEmpty(objTab.Id) && (objTab.Text ?? "").Length <= MaxTextLength)
            .Take(MaxTabs)
            .Select(objTab => objTab with { Text = objTab.Text ?? "" })
            .ToList();
        lock (_objLock)
        {
            var strTmp = _strFile + ".tmp";
            File.WriteAllText(strTmp, JsonSerializer.Serialize(new Workspace(objWorkspace.ActiveTabId, lstTabs, DateTime.UtcNow)));
            File.Move(strTmp, _strFile, overwrite: true);
        }
    }
}
