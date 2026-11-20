namespace DbStudio.Host.Services;

/// <summary>
/// Where exports may be written. The UI can't name a path on its own: it asks for the Save dialog, and
/// /export only writes to a path the user picked there. Also remembers finished exports for "Show in folder".
/// </summary>
internal sealed class ExportTargets
{
    private readonly object _objLock = new();
    private readonly HashSet<string> _hsPicked = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _hsExported = new(StringComparer.OrdinalIgnoreCase);
    private Form? _objOwner;
    private string? _strLastDirectory;

    /// <summary>The window that owns the Save dialog. Called once, by the main form.</summary>
    public void Attach(Form objOwner) => _objOwner = objOwner;

    /// <summary>Shows the Save dialog (Excel or CSV). Null when the user cancels. Blocks until the dialog closes.</summary>
    public string? Pick(string? strName, string? strFormat)
    {
        if (_objOwner is not { IsDisposed: false, IsHandleCreated: true } objOwner) return null;

        var strPath = objOwner.Invoke(() =>
        {
            using var objDialog = new SaveFileDialog
            {
                Title = "Export data",
                Filter = "Excel workbook (*.xlsx)|*.xlsx|CSV, UTF-8 (*.csv)|*.csv",
                FilterIndex = string.Equals(strFormat, "csv", StringComparison.OrdinalIgnoreCase) ? 2 : 1,
                FileName = Path.GetFileNameWithoutExtension(ExportFiles.NewPath(strName, "x")),
                InitialDirectory = _strLastDirectory ?? ExportFiles.DownloadsDirectory(),
                AddExtension = true,
                OverwritePrompt = true,
            };
            if (objDialog.ShowDialog(objOwner) != DialogResult.OK) return null;

            // A name typed with another extension still gets the one of the chosen type.
            var strChosen = objDialog.FileName;
            var strWanted = objDialog.FilterIndex == 2 ? ".csv" : ".xlsx";
            return Path.GetExtension(strChosen).ToLowerInvariant() is ".csv" or ".xlsx" ? strChosen : strChosen + strWanted;
        });
        if (strPath is null) return null;

        strPath = Path.GetFullPath(strPath);
        lock (_objLock)
        {
            _strLastDirectory = Path.GetDirectoryName(strPath);
            _hsPicked.Add(strPath);
        }
        return strPath;
    }

    /// <summary>True once for a path the Save dialog returned.</summary>
    public bool TryTake(string strPath)
    {
        lock (_objLock) return _hsPicked.Remove(Path.GetFullPath(strPath));
    }

    public void MarkExported(string strPath)
    {
        lock (_objLock) _hsExported.Add(Path.GetFullPath(strPath));
    }

    public bool WasExported(string strPath)
    {
        lock (_objLock) return _hsExported.Contains(strPath);
    }
}
