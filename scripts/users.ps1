# Who uses DbStudio: reads the reports the apps dropped in the upload-only folder (release.ps1 -SaveStatsLink)
# and prints one line per computer + Windows user, with the latest version and day seen.
#     .\scripts\users.ps1            # everyone
#     .\scripts\users.ps1 -Days 30   # seen in the last 30 days
param([int]$Days = 0)
$ErrorActionPreference = 'Stop'
$saved = Join-Path $env:APPDATA 'DbStudio\release.xml'
if (-not (Test-Path $saved)) { throw 'No saved cloud account. Run .\scripts\release.ps1 -SaveCredential first.' }
$config = Import-Clixml $saved
if (-not $config.StatsFolder) { throw 'No stats folder is set. Run .\scripts\release.ps1 -SaveStatsLink first.' }

$pair = "$($config.Credential.UserName):$($config.Credential.GetNetworkCredential().Password)"
$auth = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pair))
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$folderUrl = "$($config.Url)/remote.php/webdav/" + (($config.StatsFolder -split '/' | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/')

# Invoke-WebRequest of Windows PowerShell has no PROPFIND.
$request = [Net.HttpWebRequest]::Create("$folderUrl/")
$request.Method = 'PROPFIND'
$request.Headers['Authorization'] = $auth
$request.Headers['Depth'] = '1'
$request.ContentLength = 0
$response = $request.GetResponse()
try { $xml = [xml](New-Object IO.StreamReader($response.GetResponseStream(), [Text.Encoding]::UTF8)).ReadToEnd() } finally { $response.Close() }

# MACHINE_user_yyyyMMdd_vX.Y.Z.json (a renamed duplicate ends in " (2).json"): the newest file of each machine + user.
$files = foreach ($node in $xml.GetElementsByTagName('href', 'DAV:')) {
    $name = [Uri]::UnescapeDataString(($node.InnerText.TrimEnd('/') -split '/')[-1])
    if ($name -match '^(?<who>.+)_(?<day>\d{8})_v(?<version>\d+\.\d+\.\d+)(?: \(\d+\))?\.json$') {
        [pscustomobject]@{ Name = $name; Who = $Matches.who; Day = $Matches.day; Version = [version]$Matches.version }
    }
}
if (-not $files) { 'No reports yet.'; return }

$since = if ($Days -gt 0) { (Get-Date).AddDays(-$Days).ToString('yyyyMMdd') } else { '' }
$rows = foreach ($group in ($files | Group-Object Who)) {
    $last = $group.Group | Sort-Object Day, Version | Select-Object -Last 1
    if ($since -and $last.Day -lt $since) { continue }
    $info = $null
    try {
        $content = (Invoke-WebRequest -Uri "$folderUrl/$([Uri]::EscapeDataString($last.Name))" -Headers @{ Authorization = $auth } -UseBasicParsing).Content
        if ($content -is [byte[]]) { $content = [Text.Encoding]::UTF8.GetString($content) }
        $info = $content | ConvertFrom-Json
    } catch { }
    [pscustomobject]@{
        User     = $(if ($info) { "$($info.domain)\$($info.user)" } else { $group.Name })
        Machine  = $info.machine
        Version  = $last.Version.ToString()
        LastSeen = $(if ($info) { $info.at } else { $last.Day })
        IP       = ($info.ips -join ', ')
        Days     = ($group.Group | Select-Object -ExpandProperty Day -Unique).Count
    }
}
$rows | Sort-Object LastSeen -Descending | Format-Table -AutoSize
"$(@($rows).Count) user(s)$(if ($Days -gt 0) { " in the last $Days days" })."
