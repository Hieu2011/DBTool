using System.Text.Json;

namespace DbStudio.Host.Services;

/// <summary>Where the main window was when the app closed. Bounds are those of the restored (not maximized) window.</summary>
public sealed record WindowPlacement(int X, int Y, int Width, int Height, bool Maximized);

/// <summary>
/// App settings kept in %APPDATA%\DbStudio\settings.json: the window placement and the UI's own values
/// (sidebar width...). Server side because the UI's origin (random port) changes on every start.
/// </summary>
internal sealed class SettingsStore
{
    private const int MaxUiKeys = 100;
    private const int MaxUiValueLength = 4000;

    private sealed class Data
    {
        public WindowPlacement? Window { get; set; }
        public Dictionary<string, JsonElement> Ui { get; set; } = [];
    }

    private readonly string _strFile;
    private readonly object _objLock = new();
    private Data? _objData;

    public SettingsStore()
    {
        var strDir = AppPaths.DataDirectory;
        Directory.CreateDirectory(strDir);
        _strFile = Path.Combine(strDir, "settings.json");
    }

    public WindowPlacement? Window
    {
        get { lock (_objLock) return Load().Window; }
        set
        {
            lock (_objLock)
            {
                Load().Window = value;
                Persist();
            }
        }
    }

    public Dictionary<string, JsonElement> GetUi()
    {
        lock (_objLock) return new Dictionary<string, JsonElement>(Load().Ui);
    }

    /// <summary>Sets the given keys and keeps the others. A null value removes its key.</summary>
    public void MergeUi(Dictionary<string, JsonElement> dicValues)
    {
        if (dicValues.Values.Any(objValue => objValue.GetRawText().Length > MaxUiValueLength))
            throw new ArgumentException($"A setting holds at most {MaxUiValueLength} characters.");
        lock (_objLock)
        {
            var dicUi = Load().Ui;
            foreach (var (strKey, objValue) in dicValues)
            {
                if (objValue.ValueKind == JsonValueKind.Null) dicUi.Remove(strKey);
                else dicUi[strKey] = objValue.Clone();
            }
            if (dicUi.Count > MaxUiKeys) throw new ArgumentException($"At most {MaxUiKeys} settings are kept.");
            Persist();
        }
    }

    private Data Load()
    {
        if (_objData is not null) return _objData;
        try
        {
            _objData = File.Exists(_strFile) ? JsonSerializer.Deserialize<Data>(File.ReadAllText(_strFile)) : null;
        }
        catch (Exception objEx) when (objEx is JsonException or IOException)
        {
            // A broken settings file only costs the saved preferences.
        }
        _objData ??= new Data();
        _objData.Ui ??= [];
        return _objData;
    }

    private void Persist()
    {
        try
        {
            var strTmp = _strFile + ".tmp";
            File.WriteAllText(strTmp, JsonSerializer.Serialize(_objData));
            File.Move(strTmp, _strFile, overwrite: true);
        }
        catch (Exception objEx) when (objEx is IOException or UnauthorizedAccessException)
        {
            // Settings are a convenience: never fail the caller over them.
        }
    }
}
