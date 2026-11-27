using System.Text.Json;

namespace DbStudio.Host.Services;

/// <summary>Position of one table box in a diagram.</summary>
public sealed record DiagramPoint(int X, int Y);

/// <summary>
/// Where the user dragged the boxes of each diagram, kept in %APPDATA%\DbStudio\diagram-layouts.json.
/// Server side because the UI's origin (random port) changes on every start.
/// </summary>
internal sealed class DiagramLayoutStore
{
    private const int MaxBoxes = 500;

    private readonly string _strFile;
    private readonly object _objLock = new();
    private Dictionary<string, Dictionary<string, DiagramPoint>>? _dicLayouts;

    public DiagramLayoutStore()
    {
        var strDir = AppPaths.DataDirectory;
        Directory.CreateDirectory(strDir);
        _strFile = Path.Combine(strDir, "diagram-layouts.json");
    }

    private static string KeyOf(Guid guidConnectionId, string strDiagram) => $"{guidConnectionId:N}|{strDiagram}";

    public Dictionary<string, DiagramPoint> Get(Guid guidConnectionId, string strDiagram)
    {
        lock (_objLock)
            return Load().TryGetValue(KeyOf(guidConnectionId, strDiagram), out var dicBoxes) ? dicBoxes : [];
    }

    /// <summary>An empty layout removes the entry.</summary>
    public void Set(Guid guidConnectionId, string strDiagram, Dictionary<string, DiagramPoint> dicBoxes)
    {
        if (dicBoxes.Count > MaxBoxes) throw new ArgumentException($"A diagram layout holds at most {MaxBoxes} boxes.");
        lock (_objLock)
        {
            var dicLayouts = Load();
            if (dicBoxes.Count == 0) dicLayouts.Remove(KeyOf(guidConnectionId, strDiagram));
            else dicLayouts[KeyOf(guidConnectionId, strDiagram)] = dicBoxes;
            Persist(dicLayouts);
        }
    }

    public void RemoveConnection(Guid guidConnectionId)
    {
        lock (_objLock)
        {
            var dicLayouts = Load();
            var strPrefix = $"{guidConnectionId:N}|";
            var lstKeys = dicLayouts.Keys.Where(strKey => strKey.StartsWith(strPrefix, StringComparison.Ordinal)).ToList();
            if (lstKeys.Count == 0) return;
            foreach (var strKey in lstKeys) dicLayouts.Remove(strKey);
            Persist(dicLayouts);
        }
    }

    private Dictionary<string, Dictionary<string, DiagramPoint>> Load()
    {
        if (_dicLayouts is not null) return _dicLayouts;
        try
        {
            _dicLayouts = File.Exists(_strFile)
                ? JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, DiagramPoint>>>(File.ReadAllText(_strFile))
                : null;
        }
        catch (Exception objEx) when (objEx is JsonException or IOException)
        {
            // A broken layout file only costs the saved positions.
        }
        return _dicLayouts ??= [];
    }

    private void Persist(Dictionary<string, Dictionary<string, DiagramPoint>> dicLayouts)
    {
        var strTmp = _strFile + ".tmp";
        File.WriteAllText(strTmp, JsonSerializer.Serialize(dicLayouts));
        File.Move(strTmp, _strFile, overwrite: true);
    }
}
