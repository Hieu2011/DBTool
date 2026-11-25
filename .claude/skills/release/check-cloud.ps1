# Prints what the update folder holds now (version.json) next to the local build, with the saved release account.
# Read-only. The account comes from %APPDATA%\DbStudio\release.xml (release.ps1 -SaveCredential); nothing is printed of it.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$saved = Join-Path $env:APPDATA 'DbStudio\release.xml'
if (-not (Test-Path $saved)) { throw 'No saved cloud account: the user runs .\scripts\release.ps1 -SaveCredential in their own terminal.' }
$config = Import-Clixml $saved
$pair = "$($config.Credential.UserName):$($config.Credential.GetNetworkCredential().Password)"
$headers = @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pair)) }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$folder = ($config.Folder -split '/' | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/'

$answer = (Invoke-WebRequest -Uri "$($config.Url)/remote.php/webdav/$folder/version.json" -Headers $headers -UseBasicParsing).Content
if ($answer -is [byte[]]) { $answer = [Text.Encoding]::UTF8.GetString($answer) }
$cloud = $answer | ConvertFrom-Json
"cloud  : $($cloud.version)  $($cloud.file)  $($cloud.date)  sha256 $($cloud.sha256.Substring(0, 12))"

$project = [IO.File]::ReadAllText("$root\src\DbStudio.Host\DbStudio.Host.csproj")
"project: $([regex]::Match($project, '<Version>([^<]+)</Version>').Groups[1].Value)"
$exe = "$root\dist\DbStudio.exe"
if (Test-Path $exe) { "local  : sha256 $((Get-FileHash $exe -Algorithm SHA256).Hash.Substring(0, 12))  built $((Get-Item $exe).LastWriteTime.ToString('yyyy-MM-dd HH:mm'))" }
