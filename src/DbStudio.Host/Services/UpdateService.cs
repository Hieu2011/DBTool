using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace DbStudio.Host.Services;

/// <summary>Where updates come from, as the UI sees it. The password never leaves the server.</summary>
public sealed record UpdateConfigDto(string? Url, bool HasPassword, string CurrentVersion, bool CanApply, string? BuiltOn);

/// <summary>Password null = keep the saved one; empty = the link has none.</summary>
public sealed record UpdateConfigInput(string? Url, string? Password);

/// <summary>ReleasedOn: the day the version in the update folder was published (yyyy-MM-dd), when its manifest says.</summary>
public sealed record UpdateInfo(string CurrentVersion, string LatestVersion, bool Available, string? Notes, string? ReleasedOn);

public sealed record UpdateProgress(long Received, long? Total);

/// <summary>Code "UpdateAuth": the link's password is missing, wrong or unreadable (the UI then asks for it).</summary>
internal sealed class UpdateException(string strMessage, string? strCode = null) : Exception(strMessage)
{
    public const string Auth = "UpdateAuth";
    public string? Code { get; } = strCode;
}

/// <summary>
/// Self-update from a public share link of a Nextcloud / ownCloud folder (https://host/index.php/s/TOKEN) that holds
/// version.json ({ "version", "file", "sha256", "date", "notes", "stats" }) and the exe. The link is a setting, never part of the code;
/// its password is kept with DPAPI in %APPDATA%\DbStudio\update.json. Nothing is checked or downloaded unless asked.
/// </summary>
internal sealed partial class UpdateService
{
    private const string ManifestName = "version.json";
    private const long MaxExeBytes = 1L << 30;
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("DbStudio.update.v1");
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private static readonly HttpClient Http = CreateClient();

    private sealed record Stored(string? Url, string? ProtectedPassword);
    private sealed record Manifest(string? Version, string? File, string? Sha256, string? Notes, string? Date, string? Stats);

    private readonly string _strFile;
    private readonly object _objLock = new();
    private readonly SemaphoreSlim _objApplying = new(1, 1);
    private Form? _objOwner;
    private UpdateProgress? _objProgress;

    public UpdateService()
    {
        var strDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "DbStudio");
        Directory.CreateDirectory(strDir);
        _strFile = Path.Combine(strDir, "update.json");
        // The exe replaced by the last update: it could not be deleted while it was still running.
        try { if (ExePath is { } strExe) File.Delete(strExe + ".old"); } catch (Exception objEx) when (objEx is IOException or UnauthorizedAccessException) { }
    }

    /// <summary>The window to close when the new exe has been started. Called once, by the main form.</summary>
    public void Attach(Form objOwner) => _objOwner = objOwner;

    public static string CurrentVersion => Display(typeof(UpdateService).Assembly.GetName().Version ?? new Version(0, 0, 0));

    /// <summary>The day this exe was built (yyyy-MM-dd), stamped by the csproj.</summary>
    private static string? BuiltOn { get; } = typeof(UpdateService).Assembly
        .GetCustomAttributes(typeof(System.Reflection.AssemblyMetadataAttribute), false)
        .OfType<System.Reflection.AssemblyMetadataAttribute>()
        .FirstOrDefault(objItem => objItem.Key == "BuildDate")?.Value;

    public UpdateProgress? Progress => _objProgress;

    /// <summary>The published single-file exe. Null for a debug / dotnet run build: nothing to replace there.</summary>
    private static string? ExePath =>
        Environment.ProcessPath is { } strPath
        // Any file name: the exe downloaded from the update folder is called DbStudio-<version>.exe.
        && string.Equals(Path.GetExtension(strPath), ".exe", StringComparison.OrdinalIgnoreCase)
        && string.IsNullOrEmpty(typeof(UpdateService).Assembly.Location)
            ? strPath
            : null;

    public UpdateConfigDto GetConfig()
    {
        var objStored = Load();
        return new UpdateConfigDto(objStored.Url, !string.IsNullOrEmpty(objStored.ProtectedPassword), CurrentVersion, ExePath is not null, BuiltOn);
    }

    public UpdateConfigDto SaveConfig(UpdateConfigInput objInput)
    {
        var strUrl = string.IsNullOrWhiteSpace(objInput.Url) ? null : objInput.Url.Trim();
        if (strUrl is not null) ParseShare(strUrl); // refuses anything that is not an https share link
        lock (_objLock)
        {
            var objOld = Load();
            var strProtected = objInput.Password is null ? objOld.ProtectedPassword
                : objInput.Password.Length == 0 ? null
                : Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(objInput.Password), Entropy, DataProtectionScope.CurrentUser));
            var strTmp = _strFile + ".tmp";
            File.WriteAllText(strTmp, JsonSerializer.Serialize(new Stored(strUrl, strUrl is null ? null : strProtected), Json));
            File.Move(strTmp, _strFile, overwrite: true);
        }
        return GetConfig();
    }

    public async Task<UpdateInfo> CheckAsync(CancellationToken objCancelToken)
    {
        var (objManifest, objLatest) = await ReadManifestAsync(objCancelToken).ConfigureAwait(false);
        var objCurrent = typeof(UpdateService).Assembly.GetName().Version ?? new Version(0, 0, 0);
        ReportUsage(objManifest.Stats);
        return new UpdateInfo(CurrentVersion, Display(objLatest), Normalize(objLatest) > Normalize(objCurrent), objManifest.Notes,
            DateOnly.TryParseExact(objManifest.Date, "yyyy-MM-dd", out var dtReleased) ? dtReleased.ToString("yyyy-MM-dd") : null);
    }

    /// <summary>Downloads the new exe, checks its SHA-256, puts it in place of the running one and starts it.</summary>
    public async Task ApplyAsync(CancellationToken objCancelToken)
    {
        if (ExePath is not { } strTarget) throw new UpdateException("This build cannot update itself (it is not the published DbStudio.exe).");
        if (!await _objApplying.WaitAsync(0, objCancelToken).ConfigureAwait(false)) throw new UpdateException("An update is already running.");
        string? strNew = null;
        try
        {
            var (objManifest, _) = await ReadManifestAsync(objCancelToken).ConfigureAwait(false);
            var strName = objManifest.File ?? "DbStudio.exe";
            if (strName != Path.GetFileName(strName) || !strName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                throw new UpdateException($"{ManifestName}: \"file\" must be the name of an .exe in the shared folder.");
            if (objManifest.Sha256 is not { Length: 64 } strExpected || !HexRegex().IsMatch(strExpected))
                throw new UpdateException($"{ManifestName} has no valid \"sha256\": the download could not be verified, so nothing was installed.");

            // Next to the exe: same volume, so putting it in place is a rename, and a folder that cannot be written fails here.
            strNew = strTarget + ".new";
            _objProgress = new UpdateProgress(0, null);
            string strActual;
            using (var objResponse = await SendAsync(strName, HttpCompletionOption.ResponseHeadersRead, objCancelToken).ConfigureAwait(false))
            {
                var lngTotal = objResponse.Content.Headers.ContentLength;
                if (lngTotal > MaxExeBytes) throw new UpdateException("The file in the shared folder is too large to be DbStudio.");
                await using var objSource = await objResponse.Content.ReadAsStreamAsync(objCancelToken).ConfigureAwait(false);
                await using var objFile = new FileStream(strNew, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16, useAsync: true);
                using var objHash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                var arrBuffer = new byte[1 << 16];
                long lngReceived = 0;
                int intRead;
                while ((intRead = await objSource.ReadAsync(arrBuffer, objCancelToken).ConfigureAwait(false)) > 0)
                {
                    if ((lngReceived += intRead) > MaxExeBytes) throw new UpdateException("The download is too large to be DbStudio.");
                    objHash.AppendData(arrBuffer, 0, intRead);
                    await objFile.WriteAsync(arrBuffer.AsMemory(0, intRead), objCancelToken).ConfigureAwait(false);
                    _objProgress = new UpdateProgress(lngReceived, lngTotal);
                }
                strActual = Convert.ToHexString(objHash.GetHashAndReset());
            }
            if (!strActual.Equals(strExpected, StringComparison.OrdinalIgnoreCase))
                throw new UpdateException($"The downloaded file does not match the SHA-256 in {ManifestName}. Nothing was installed.");

            // A running exe cannot be overwritten, but it can be renamed: step aside, then move the new one in.
            var strOld = strTarget + ".old";
            File.Delete(strOld);
            File.Move(strTarget, strOld);
            try { File.Move(strNew, strTarget); }
            catch { File.Move(strOld, strTarget); throw; }
            strNew = null;

            Process.Start(new ProcessStartInfo(strTarget) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(strTarget) });
            _ = Task.Run(async () =>
            {
                await Task.Delay(700); // lets the answer reach the UI first
                if (_objOwner is { IsDisposed: false, IsHandleCreated: true } objOwner) objOwner.BeginInvoke(objOwner.Close);
                else Application.Exit();
            }, CancellationToken.None);
        }
        catch (Exception objEx) when (objEx is IOException or UnauthorizedAccessException)
        {
            throw new UpdateException($"The new version could not be put in place: {objEx.Message}");
        }
        finally
        {
            _objProgress = null;
            if (strNew is not null) try { File.Delete(strNew); } catch (Exception objEx) when (objEx is IOException or UnauthorizedAccessException) { }
            _objApplying.Release();
        }
    }

    private async Task<(Manifest Manifest, Version Latest)> ReadManifestAsync(CancellationToken objCancelToken)
    {
        using var objResponse = await SendAsync(ManifestName, HttpCompletionOption.ResponseContentRead, objCancelToken).ConfigureAwait(false);
        var strJson = await objResponse.Content.ReadAsStringAsync(objCancelToken).ConfigureAwait(false);
        Manifest? objManifest;
        try { objManifest = JsonSerializer.Deserialize<Manifest>(strJson, Json); }
        catch (JsonException) { objManifest = null; }
        if (objManifest?.Version is not { } strVersion || !Version.TryParse(strVersion.TrimStart('v', 'V'), out var objLatest))
            throw new UpdateException($"{ManifestName} in the shared folder is not valid: it needs \"version\" like \"1.2.0\".");
        return (objManifest, objLatest);
    }

    /// <summary>GET of one file of the share through its public WebDAV endpoint (token + password as Basic auth).</summary>
    private async Task<HttpResponseMessage> SendAsync(string strName, HttpCompletionOption enmCompletion, CancellationToken objCancelToken)
    {
        var objStored = Load();
        if (string.IsNullOrWhiteSpace(objStored.Url)) throw new UpdateException("No update link is set. Paste the share link of the folder that holds the new versions.");
        var (strRoot, strToken) = ParseShare(objStored.Url);
        var strPassword = "";
        if (!string.IsNullOrEmpty(objStored.ProtectedPassword))
        {
            try { strPassword = Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(objStored.ProtectedPassword), Entropy, DataProtectionScope.CurrentUser)); }
            catch (Exception objEx) when (objEx is CryptographicException or FormatException) { throw new UpdateException("The saved password of the update link cannot be read on this account. Type it again.", UpdateException.Auth); }
        }

        using var objRequest = new HttpRequestMessage(HttpMethod.Get, $"{strRoot}/public.php/webdav/{Uri.EscapeDataString(strName)}");
        objRequest.Headers.Authorization = new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($"{strToken}:{strPassword}")));
        objRequest.Headers.Add("X-Requested-With", "XMLHttpRequest");
        HttpResponseMessage objResponse;
        try { objResponse = await Http.SendAsync(objRequest, enmCompletion, objCancelToken).ConfigureAwait(false); }
        catch (HttpRequestException objEx) { throw new UpdateException($"The update server could not be reached: {objEx.Message}"); }

        if (objResponse.IsSuccessStatusCode) return objResponse;
        var enmStatus = objResponse.StatusCode;
        objResponse.Dispose();
        if (enmStatus == HttpStatusCode.Unauthorized)
            throw new UpdateException(strPassword.Length == 0 ? "The update link needs its password." : "The update link refused the saved password. Type the current one.", UpdateException.Auth);
        throw new UpdateException(enmStatus == HttpStatusCode.NotFound
            ? $"{strName} was not found in the shared folder (or the link no longer exists)."
            : $"The update server answered {(int)enmStatus} for {strName}.");
    }

    /// <summary>https://host[/path]/index.php/s/TOKEN (or /s/TOKEN) -> the server root and the share token.</summary>
    private static (string Root, string Token) ParseShare(string strUrl)
    {
        if (!Uri.TryCreate(strUrl, UriKind.Absolute, out var objUri) || objUri.Scheme != Uri.UriSchemeHttps)
            throw new UpdateException("The update link must be an https:// share link.");
        var objMatch = ShareRegex().Match(objUri.AbsolutePath);
        if (!objMatch.Success) throw new UpdateException("That is not a public share link. It looks like https://server/index.php/s/AbCdEf123.");
        return ($"https://{objUri.Authority}{objMatch.Groups["base"].Value}", objMatch.Groups["token"].Value);
    }

    private Stored Load()
    {
        lock (_objLock)
        {
            try { return File.Exists(_strFile) ? JsonSerializer.Deserialize<Stored>(File.ReadAllText(_strFile), Json) ?? new Stored(null, null) : new Stored(null, null); }
            catch (Exception objEx) when (objEx is JsonException or IOException) { return new Stored(null, null); }
        }
    }

    private static HttpClient CreateClient()
    {
        // No redirects: the Basic header must never follow one to another host.
        var objClient = new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = false, ConnectTimeout = TimeSpan.FromSeconds(15) }) { Timeout = TimeSpan.FromMinutes(30) };
        objClient.DefaultRequestHeaders.UserAgent.ParseAdd("DbStudio-Updater");
        return objClient;
    }

    private static Version Normalize(Version objVersion) => new(objVersion.Major, objVersion.Minor, Math.Max(objVersion.Build, 0));

    private static string Display(Version objVersion) => Normalize(objVersion).ToString(3);

    [GeneratedRegex(@"^(?<base>.*?)(?:/index\.php)?/s/(?<token>[A-Za-z0-9]+)/?$")]
    private static partial Regex ShareRegex();

    [GeneratedRegex("^[0-9a-fA-F]{64}$")]
    private static partial Regex HexRegex();
}
