using System.Text;

namespace DbStudio.Host.Services;

/// <summary>A script the user opened: where it lives, its file name and its text.</summary>
public sealed record SqlFile(string Path, string Name, string Text);

/// <summary>Path: a file this app opened or saved before (written in place). Null: ask where to save, starting from Name.</summary>
public sealed record SqlFileSaveRequest(string? Path, string? Name, string Text);

public sealed record SqlFileSaved(string Path, string Name);

/// <summary>
/// File > Open / Save for .sql scripts. The UI never names a path by itself: files are read through the Open dialog,
/// and written either through the Save dialog or back to a path one of those dialogs returned in this run.
/// </summary>
internal sealed class SqlFiles
{
    private const long MaxFileBytes = 20 * 1024 * 1024;
    private const string Filter = "SQL scripts (*.sql)|*.sql|Text files (*.txt)|*.txt|All files (*.*)|*.*";

    private readonly object _objLock = new();
    private readonly HashSet<string> _hsKnown = new(StringComparer.OrdinalIgnoreCase);
    private Form? _objOwner;
    private string? _strLastDirectory;

    /// <summary>The window that owns the dialogs. Called once, by the main form.</summary>
    public void Attach(Form objOwner) => _objOwner = objOwner;

    /// <summary>Open dialog (several files allowed). Empty when the user cancels.</summary>
    public List<SqlFile> Open()
    {
        if (_objOwner is not { IsDisposed: false, IsHandleCreated: true } objOwner) return [];

        var arrPaths = objOwner.Invoke(() =>
        {
            using var objDialog = new OpenFileDialog
            {
                Title = "Open SQL file", Filter = Filter, Multiselect = true, CheckFileExists = true,
                InitialDirectory = _strLastDirectory ?? "",
            };
            return objDialog.ShowDialog(objOwner) == DialogResult.OK ? objDialog.FileNames : [];
        });

        var lstFiles = new List<SqlFile>();
        foreach (var strPicked in arrPaths)
        {
            var strPath = Path.GetFullPath(strPicked);
            if (new FileInfo(strPath).Length > MaxFileBytes)
                throw new InvalidOperationException($"{Path.GetFileName(strPath)} is larger than 20 MB: too big for the editor.");
            // UTF-8 unless the file's byte order mark says otherwise.
            lstFiles.Add(new SqlFile(strPath, Path.GetFileName(strPath), File.ReadAllText(strPath, Encoding.UTF8)));
            Remember(strPath);
        }
        return lstFiles;
    }

    /// <summary>Null when the Save dialog is cancelled.</summary>
    public SqlFileSaved? Save(SqlFileSaveRequest objRequest)
    {
        string? strPath = null;
        if (!string.IsNullOrWhiteSpace(objRequest.Path))
        {
            strPath = Path.GetFullPath(objRequest.Path);
            lock (_objLock)
            {
                if (!_hsKnown.Contains(strPath)) throw new InvalidOperationException("This file was not opened by DbStudio: use Save as.");
            }
        }
        else if (_objOwner is { IsDisposed: false, IsHandleCreated: true } objOwner)
        {
            strPath = objOwner.Invoke(() =>
            {
                using var objDialog = new SaveFileDialog
                {
                    Title = "Save SQL file", Filter = Filter, DefaultExt = "sql", AddExtension = true, OverwritePrompt = true,
                    FileName = string.IsNullOrWhiteSpace(objRequest.Name) ? "query.sql" : Path.GetFileName(objRequest.Name),
                    InitialDirectory = _strLastDirectory ?? "",
                };
                return objDialog.ShowDialog(objOwner) == DialogResult.OK ? Path.GetFullPath(objDialog.FileName) : null;
            });
        }
        if (strPath is null) return null;

        File.WriteAllText(strPath, objRequest.Text, new UTF8Encoding(false));
        Remember(strPath);
        return new SqlFileSaved(strPath, Path.GetFileName(strPath));
    }

    private void Remember(string strPath)
    {
        lock (_objLock)
        {
            _hsKnown.Add(strPath);
            _strLastDirectory = Path.GetDirectoryName(strPath);
        }
    }
}
