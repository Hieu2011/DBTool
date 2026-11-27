using System.Text.Json;

namespace DbStudio.Host.Services;

/// <summary>A piece of SQL the editor inserts when its prefix is typed. Body uses snippet syntax: $1, ${1:name}, $0.</summary>
public sealed record Snippet(Guid Id, string Name, string Prefix, string Body);

/// <summary>The user's snippets, in %APPDATA%\DbStudio\snippets.json. A few starters are offered until the file exists.</summary>
internal sealed class SnippetStore
{
    private const int MaxSnippets = 300;
    private const int MaxBodyLength = 20_000;
    private const int MaxNameLength = 100;

    private static readonly Snippet[] Starters =
    [
        new(Guid.Parse("5b0c1e52-0000-4000-8000-000000000001"), "Select all", "sel", "SELECT *\nFROM ${1:table}\nWHERE ${2:condition};$0"),
        new(Guid.Parse("5b0c1e52-0000-4000-8000-000000000002"), "Select count", "selc", "SELECT COUNT(*)\nFROM ${1:table}\nWHERE ${2:condition};$0"),
        new(Guid.Parse("5b0c1e52-0000-4000-8000-000000000003"), "Insert", "ins", "INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values});$0"),
        new(Guid.Parse("5b0c1e52-0000-4000-8000-000000000004"), "Update", "upd", "UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition};$0"),
        new(Guid.Parse("5b0c1e52-0000-4000-8000-000000000005"), "Delete", "del", "DELETE FROM ${1:table}\nWHERE ${2:condition};$0"),
        new(Guid.Parse("5b0c1e52-0000-4000-8000-000000000006"), "Left join", "lj", "LEFT JOIN ${1:table} ${2:alias} ON ${2:alias}.${3:column} = ${4:other}$0"),
    ];

    private readonly string _strFile;
    private readonly object _objLock = new();
    private List<Snippet>? _lstSnippets;

    public SnippetStore()
    {
        var strDir = AppPaths.DataDirectory;
        Directory.CreateDirectory(strDir);
        _strFile = Path.Combine(strDir, "snippets.json");
    }

    public List<Snippet> List()
    {
        lock (_objLock) return [.. Load()];
    }

    /// <summary>Replaces the whole list.</summary>
    public List<Snippet> Save(List<Snippet> lstSnippets)
    {
        if (lstSnippets.Count > MaxSnippets) throw new ArgumentException($"At most {MaxSnippets} snippets are kept.");
        var lstClean = new List<Snippet>(lstSnippets.Count);
        foreach (var objSnippet in lstSnippets)
        {
            var strName = (objSnippet.Name ?? "").Trim();
            var strPrefix = (objSnippet.Prefix ?? "").Trim();
            var strBody = objSnippet.Body ?? "";
            if (strName.Length == 0 || strBody.Trim().Length == 0) throw new ArgumentException("A snippet needs a name and a body.");
            if (strName.Length > MaxNameLength || strPrefix.Length > MaxNameLength)
                throw new ArgumentException($"Snippet names and prefixes hold at most {MaxNameLength} characters.");
            if (strBody.Length > MaxBodyLength) throw new ArgumentException($"A snippet body holds at most {MaxBodyLength:N0} characters.");
            lstClean.Add(new Snippet(objSnippet.Id == Guid.Empty ? Guid.NewGuid() : objSnippet.Id, strName, strPrefix, strBody));
        }

        lock (_objLock)
        {
            var strTmp = _strFile + ".tmp";
            File.WriteAllText(strTmp, JsonSerializer.Serialize(lstClean));
            File.Move(strTmp, _strFile, overwrite: true);
            _lstSnippets = lstClean;
            return [.. lstClean];
        }
    }

    private List<Snippet> Load()
    {
        if (_lstSnippets is not null) return _lstSnippets;
        try
        {
            _lstSnippets = File.Exists(_strFile) ? JsonSerializer.Deserialize<List<Snippet>>(File.ReadAllText(_strFile)) : null;
        }
        catch (Exception objEx) when (objEx is JsonException or IOException)
        {
            // A broken file only costs the saved snippets.
        }
        return _lstSnippets ??= [.. Starters];
    }
}
