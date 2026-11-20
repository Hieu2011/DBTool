# Builds the UI, embeds it into the host and publishes a single self-contained DbStudio.exe into .\dist
param(
    [switch]$FrameworkDependent   # smaller exe; needs the .NET 8 Desktop Runtime installed
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

Push-Location "$root\web"
npm ci
npm run build
Pop-Location

$selfContained = if ($FrameworkDependent) { 'false' } else { 'true' }

dotnet publish "$root\src\DbStudio.Host" -c Release -r win-x64 `
    --self-contained $selfContained `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:DebugType=none `
    -o "$root\dist"

Write-Host "`nDone: $root\dist\DbStudio.exe" -ForegroundColor Green
