using System.Net.Http.Headers;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace DbStudio.Host.Services;

/// <summary>
/// "Who uses DbStudio": when version.json of the update folder names a second, upload-only share ("stats"), the app
/// drops one small file there per day (and per new version) with the Windows user, the computer, its addresses and
/// the version. The Updates dialog says so. Never blocks or fails anything: every error is swallowed.
/// </summary>
internal sealed partial class UpdateService
{
    private sealed record UsageState(string? Date, string? Version);

    private int _intReporting;

    private string UsageFile => Path.Combine(Path.GetDirectoryName(_strFile)!, "usage.json");

    /// <summary>Fire and forget. strStatsUrl: the "stats" link of version.json, a public upload-only share on the update host.</summary>
    private void ReportUsage(string? strStatsUrl)
    {
        if (string.IsNullOrWhiteSpace(strStatsUrl) || Interlocked.Exchange(ref _intReporting, 1) == 1) return;
        _ = Task.Run(async () =>
        {
            try { await ReportUsageAsync(strStatsUrl).ConfigureAwait(false); }
            catch (Exception) { /* counting users must never get in the way */ }
            finally { Interlocked.Exchange(ref _intReporting, 0); }
        });
    }

    private async Task ReportUsageAsync(string strStatsUrl)
    {
        var strToday = DateTime.Now.ToString("yyyy-MM-dd");
        UsageState? objLast = null;
        try { if (File.Exists(UsageFile)) objLast = JsonSerializer.Deserialize<UsageState>(File.ReadAllText(UsageFile), Json); }
        catch (Exception objEx) when (objEx is JsonException or IOException) { }
        if (objLast?.Date == strToday && objLast.Version == CurrentVersion) return; // once a day, and once more after an update

        var (strRoot, strToken) = ParseShare(strStatsUrl);
        // Only the server the updates come from gets this: version.json cannot point the report somewhere else.
        var objUpdateUrl = Load().Url;
        if (objUpdateUrl is null || !string.Equals(new Uri(ParseShare(objUpdateUrl).Root).Host, new Uri(strRoot).Host, StringComparison.OrdinalIgnoreCase)) return;

        var lstAddresses = NetworkInterface.GetAllNetworkInterfaces()
            .Where(objCard => objCard.OperationalStatus == OperationalStatus.Up && objCard.NetworkInterfaceType != NetworkInterfaceType.Loopback)
            .Select(objCard => objCard.GetIPProperties())
            // Only cards with a gateway: the virtual ones (Hyper-V, WSL, Docker) have none and say nothing about where the PC is.
            .Where(objProperties => objProperties.GatewayAddresses.Any(objGateway => objGateway.Address.AddressFamily == AddressFamily.InterNetwork))
            .SelectMany(objProperties => objProperties.UnicastAddresses)
            .Where(objItem => objItem.Address.AddressFamily == AddressFamily.InterNetwork)
            .Select(objItem => objItem.Address.ToString())
            .Distinct()
            .ToList();
        var strBody = JsonSerializer.Serialize(new
        {
            user = Environment.UserName,
            domain = Environment.UserDomainName,
            machine = Environment.MachineName,
            ips = lstAddresses,
            os = Environment.OSVersion.VersionString,
            version = CurrentVersion,
            at = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"),
        }, Json);

        // One name per computer, user, day and version: nothing is ever overwritten (an upload-only share would rename it).
        var strName = SafeNameRegex().Replace($"{Environment.MachineName}_{Environment.UserName}_{strToday.Replace("-", "")}_v{CurrentVersion}", "-") + ".json";
        // The stats share takes the password of the update link (the one the user already typed): the link alone,
        // leaked, is then useless. A share left without a password is tried second.
        var strPassword = "";
        try
        {
            if (Load().ProtectedPassword is { Length: > 0 } strProtected)
                strPassword = Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(strProtected), Entropy, DataProtectionScope.CurrentUser));
        }
        catch (Exception objEx) when (objEx is CryptographicException or FormatException) { }

        foreach (var strSecret in strPassword.Length > 0 ? new[] { strPassword, "" } : [""])
        {
            using var objRequest = new HttpRequestMessage(HttpMethod.Put, $"{strRoot}/public.php/webdav/{Uri.EscapeDataString(strName)}");
            objRequest.Headers.Authorization = new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($"{strToken}:{strSecret}")));
            objRequest.Headers.Add("X-Requested-With", "XMLHttpRequest");
            objRequest.Content = new StringContent(strBody, Encoding.UTF8, "application/json");
            using var objTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            using var objResponse = await Http.SendAsync(objRequest, objTimeout.Token).ConfigureAwait(false);
            if (objResponse.StatusCode == System.Net.HttpStatusCode.Unauthorized) continue;
            if (!objResponse.IsSuccessStatusCode) return; // tried again at the next start

            File.WriteAllText(UsageFile, JsonSerializer.Serialize(new UsageState(strToday, CurrentVersion), Json));
            return;
        }
    }

    [GeneratedRegex(@"[^A-Za-z0-9._-]+")]
    private static partial Regex SafeNameRegex();
}
