using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using DbStudio.Core;

namespace DbStudio.Host.Services;

/// <summary>
/// Saves connections to %APPDATA%\DbStudio\connections.json.
/// Passwords are encrypted with Windows DPAPI (CurrentUser): only this Windows account can read them.
/// </summary>
internal sealed class DpapiConnectionStore : IConnectionStore
{
    private static readonly byte[] Entropy = "DbStudio.v1"u8.ToArray();
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    private readonly string _strFile;
    private readonly object _objLock = new();
    private readonly List<ConnectionProfile> _lstItems;

    public DpapiConnectionStore()
    {
        var strDir = AppPaths.DataDirectory;
        Directory.CreateDirectory(strDir);
        _strFile = Path.Combine(strDir, "connections.json");
        _lstItems = Load();
    }

    public IReadOnlyList<ConnectionProfile> List()
    {
        lock (_objLock) return _lstItems.OrderBy(objItem => objItem.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    public ConnectionProfile? Get(Guid guidId)
    {
        lock (_objLock) return _lstItems.FirstOrDefault(objItem => objItem.Id == guidId);
    }

    public ConnectionProfile Save(ConnectionProfile objProfile)
    {
        lock (_objLock)
        {
            var intIndex = _lstItems.FindIndex(objItem => objItem.Id == objProfile.Id);
            if (intIndex >= 0)
            {
                if (string.IsNullOrEmpty(objProfile.Password)) objProfile.Password = _lstItems[intIndex].Password;
                _lstItems[intIndex] = objProfile;
            }
            else
            {
                if (objProfile.Id == Guid.Empty) objProfile.Id = Guid.NewGuid();
                _lstItems.Add(objProfile);
            }
            Persist();
            return objProfile;
        }
    }

    public bool Delete(Guid guidId)
    {
        lock (_objLock)
        {
            var boolRemoved = _lstItems.RemoveAll(objItem => objItem.Id == guidId) > 0;
            if (boolRemoved) Persist();
            return boolRemoved;
        }
    }

    private List<ConnectionProfile> Load()
    {
        if (!File.Exists(_strFile)) return [];
        var lstStored = JsonSerializer.Deserialize<List<StoredConnection>>(File.ReadAllText(_strFile), Json) ?? [];
        return lstStored.Select(objStored =>
        {
            var objProfile = objStored.Profile;
            objProfile.Password = objStored.ProtectedPassword is null ? null : Unprotect(objStored.ProtectedPassword);
            return objProfile;
        }).ToList();
    }

    private void Persist()
    {
        var lstStored = _lstItems.Select(objProfile =>
        {
            var objCopy = JsonSerializer.Deserialize<ConnectionProfile>(JsonSerializer.Serialize(objProfile))!;
            objCopy.Password = null;
            return new StoredConnection(objCopy, string.IsNullOrEmpty(objProfile.Password) ? null : Protect(objProfile.Password));
        }).ToList();

        var strTmp = _strFile + ".tmp";
        File.WriteAllText(strTmp, JsonSerializer.Serialize(lstStored, Json));
        File.Move(strTmp, _strFile, overwrite: true);
    }

    private static string Protect(string strPlain) => Convert.ToBase64String(
        ProtectedData.Protect(Encoding.UTF8.GetBytes(strPlain), Entropy, DataProtectionScope.CurrentUser));

    private static string? Unprotect(string strCipher)
    {
        try
        {
            return Encoding.UTF8.GetString(
                ProtectedData.Unprotect(Convert.FromBase64String(strCipher), Entropy, DataProtectionScope.CurrentUser));
        }
        catch (CryptographicException)
        {
            return null; // file copied from another Windows account/PC: user re-enters the password
        }
    }

    private sealed record StoredConnection(ConnectionProfile Profile, string? ProtectedPassword);
}
