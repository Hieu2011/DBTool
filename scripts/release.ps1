# Builds DbStudio and uploads it to the update folder (a Nextcloud / ownCloud folder, over WebDAV),
# so Help > Check for updates sees the new version on every machine.
#
# Where and who is never written in this file. Run once, in your own terminal:
#     .\scripts\release.ps1 -SaveCredential
# It asks for the server, the folder, the user and an app password (Settings > Security on the cloud, not the login
# password) and keeps them in %APPDATA%\DbStudio\release.xml, the password encrypted for this Windows account (DPAPI).
# Without that file the environment variables DBSTUDIO_CLOUD_URL / _USER / _APP_PASSWORD / _FOLDER are used.
param(
    [switch]$SaveCredential,   # ask for the cloud account and save it, then stop
    [switch]$SaveStatsLink,    # ask for the upload-only share the apps report to (who uses DbStudio), then stop
    [string]$Version,      # e.g. 1.2.0: written into the project first. Omitted: the project's current version
    [string]$Notes = '',   # shown by Help > Check for updates. Omitted: the version's entry in CHANGELOG.md
    [switch]$SkipBuild,    # upload what is already in .\dist
    [switch]$IfNewer       # do nothing when the update folder already has this version or a later one (pre-push hook)
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$project = "$root\src\DbStudio.Host\DbStudio.Host.csproj"

$saved = Join-Path $env:APPDATA 'DbStudio\release.xml'

if ($SaveCredential) {
    $url = (Read-Host 'Cloud address (https://...)').Trim().TrimEnd('/')
    if ($url -notlike 'https://*') { throw 'The address must start with https://' }
    $dir = (Read-Host 'Folder that the update link shares [DBTool]').Trim('/', ' ')
    $credential = Get-Credential -Message 'Cloud user name and an APP PASSWORD (not the login password)'
    if (-not $credential) { throw 'Cancelled.' }
    New-Item -ItemType Directory -Force (Split-Path $saved) | Out-Null
    # Export-Clixml encrypts the password with DPAPI: only this Windows account on this PC can read it back.
    $new = @{ Url = $url; Folder = $(if ($dir) { $dir } else { 'DBTool' }); Credential = $credential }
    # The stats link (-SaveStatsLink) survives a new account.
    if (Test-Path $saved) { $old = Import-Clixml $saved; if ($old.Stats) { $new.Stats = $old.Stats; $new.StatsFolder = $old.StatsFolder } }
    $new | Export-Clixml $saved
    Write-Host "Saved to $saved" -ForegroundColor Green
    return
}

if ($SaveStatsLink) {
    if (-not (Test-Path $saved)) { throw 'Run .\scripts\release.ps1 -SaveCredential first.' }
    $config = Import-Clixml $saved
    $link = (Read-Host 'Share link of the upload-only (file drop) folder; give it the same password as the update link (empty = stop reporting)').Trim()
    if ($link -and $link -notlike 'https://*') { throw 'The link must start with https://' }
    $name = if ($link) { (Read-Host 'Name of that folder in your cloud [DBTool-Users]').Trim('/', ' ') } else { '' }
    $config.Stats = $link
    $config.StatsFolder = $(if ($name) { $name } else { 'DBTool-Users' })
    $config | Export-Clixml $saved
    Write-Host "Saved. The link goes into version.json at the next release." -ForegroundColor Green
    return
}

if (Test-Path $saved) {
    $config = Import-Clixml $saved
    $base = $config.Url
    $folder = $config.Folder
    $user = $config.Credential.UserName
    $secret = $config.Credential.GetNetworkCredential().Password
} else {
    foreach ($name in 'DBSTUDIO_CLOUD_URL', 'DBSTUDIO_CLOUD_USER', 'DBSTUDIO_CLOUD_APP_PASSWORD') {
        if (-not [Environment]::GetEnvironmentVariable($name)) { throw "No saved cloud account. Run .\scripts\release.ps1 -SaveCredential first (or set $name)." }
    }
    $base = $env:DBSTUDIO_CLOUD_URL.TrimEnd('/')
    $folder = if ($env:DBSTUDIO_CLOUD_FOLDER) { $env:DBSTUDIO_CLOUD_FOLDER.Trim('/') } else { 'DBTool' }
    $user = $env:DBSTUDIO_CLOUD_USER
    $secret = $env:DBSTUDIO_CLOUD_APP_PASSWORD
}
if ($base -notlike 'https://*') { throw 'The cloud address must start with https://' }

if ($Version) {
    if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Version looks like 1.2.0' }
    $text = [IO.File]::ReadAllText($project)
    $changed = [regex]::Replace($text, '<Version>[^<]*</Version>', "<Version>$Version</Version>")
    if ($changed -eq $text -and $text -notmatch "<Version>$([regex]::Escape($Version))</Version>") { throw "No <Version> element in $project" }
    [IO.File]::WriteAllText($project, $changed, (New-Object Text.UTF8Encoding $false))
}

$token = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${user}:${secret}"))
$headers = @{ Authorization = "Basic $token" }
$folderUrl = "$base/remote.php/webdav/" + (($folder -split '/' | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/')
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$current = [version]([regex]::Match([IO.File]::ReadAllText($project), '<Version>([^<]+)</Version>').Groups[1].Value)

if ($IfNewer) {
    # Before the build: most pushes have nothing to release.
    $cloud = $null
    try {
        $answer = (Invoke-WebRequest -Uri "$folderUrl/version.json" -Headers $headers -UseBasicParsing).Content
        if ($answer -is [byte[]]) { $answer = [Text.Encoding]::UTF8.GetString($answer) }
        $cloud = [version](($answer | ConvertFrom-Json).version)
    } catch {
        $status = [int]$_.Exception.Response.StatusCode
        if ($status -ne 404) { throw "The update folder could not be read: $($_.Exception.Message)" }   # 404: first release
    }
    if ($cloud -and $cloud -ge $current) {
        Write-Host "The update folder already has $cloud (this build is $current): nothing to release."
        return
    }
}

# Notes shown by the app: what was asked for, else what CHANGELOG.md says about this version.
if (-not $Notes -and (Test-Path "$root\CHANGELOG.md")) {
    $section = [regex]::Match([IO.File]::ReadAllText("$root\CHANGELOG.md"), "(?ms)^## $([regex]::Escape($current.ToString(3)))\b[^\n]*\n(.*?)(?=^## |\z)")
    if ($section.Success) {
        $Notes = (@($section.Groups[1].Value -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }) -join "`n")
    }
}

if (-not $SkipBuild) { & "$PSScriptRoot\publish.ps1" -Notes $Notes -SkipInstall:(Test-Path "$root\web\node_modules") }

$manifest = Get-Content "$root\dist\version.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$exe = "$root\dist\DbStudio.exe"
if ((Get-FileHash $exe -Algorithm SHA256).Hash -ne $manifest.sha256) { throw 'dist\version.json does not belong to dist\DbStudio.exe: build again.' }

# The exe goes up under a name of its own; version.json, which points at it, goes last.
# A machine that checks in between still sees the previous version, whole.
$exeName = "DbStudio-$($manifest.version).exe"
$size = (Get-Item $exe).Length
Write-Host "Uploading $exeName ($([math]::Round($size / 1MB)) MB) to $folder ..."
Invoke-WebRequest -Uri "$folderUrl/$exeName" -Method Put -InFile $exe -Headers $headers -ContentType 'application/octet-stream' -UseBasicParsing -TimeoutSec 3600 | Out-Null

$uploaded = [long](Invoke-WebRequest -Uri "$folderUrl/$exeName" -Method Head -Headers $headers -UseBasicParsing).Headers['Content-Length']
if ($uploaded -ne $size) { throw "The upload is incomplete ($uploaded of $size bytes). version.json was not changed, so nobody gets a broken update." }

$cloudManifest = [ordered]@{ version = $manifest.version; file = $exeName; sha256 = $manifest.sha256; date = $manifest.date; notes = $manifest.notes }
# The upload-only share the apps report to; a setting of this machine, like the account.
if ((Test-Path $saved) -and $config.Stats) { $cloudManifest.stats = $config.Stats }
$cloudManifest = $cloudManifest | ConvertTo-Json
Invoke-WebRequest -Uri "$folderUrl/version.json" -Method Put -Body ([Text.Encoding]::UTF8.GetBytes($cloudManifest)) -Headers $headers -ContentType 'application/json' -UseBasicParsing | Out-Null

# CHANGELOG.md keeps what version.json forgets at the next release. One entry per version: an existing one is left alone.
$changelog = "$root\CHANGELOG.md"
$utf8 = New-Object Text.UTF8Encoding $false
$log = if (Test-Path $changelog) { [IO.File]::ReadAllText($changelog) } else { "# Changelog`n" }
if ($log -notmatch "(?m)^## $([regex]::Escape($manifest.version))\b") {
    $lines = @("$($manifest.notes)" -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($lines.Count -eq 0) { $lines = @('(no notes)') }
    $entry = "## $($manifest.version) $([char]0x2014) $(Get-Date -Format 'yyyy-MM-dd')`n`n" + (($lines | ForEach-Object { "- " + ($_ -replace '^[-*]\s*', '') }) -join "`n") + "`n`n"
    # above the newest entry, under the file's introduction
    $at = [regex]::Match($log, '(?m)^## ')
    $log = if ($at.Success) { $log.Substring(0, $at.Index) + $entry + $log.Substring($at.Index) } else { $log.TrimEnd() + "`n`n" + $entry }
    [IO.File]::WriteAllText($changelog, $log, $utf8)
    Write-Host "CHANGELOG.md: added $($manifest.version)"
}

Write-Host "`nReleased $($manifest.version): $folder/$exeName + version.json" -ForegroundColor Green
Write-Host 'Older DbStudio-*.exe files stay in the folder; delete them there when you no longer need them.'
