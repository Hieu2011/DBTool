# Builds the UI, embeds it into the host and publishes a single self-contained DbStudio.exe into .\dist
param(
    [switch]$FrameworkDependent,  # smaller exe; needs the .NET 8 Desktop Runtime installed
    [string]$Notes = ''           # shown by Help > Check for updates
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

# version.json goes into the update folder together with the exe (Help > Check for updates reads it).
[xml]$project = Get-Content "$root\src\DbStudio.Host\DbStudio.Host.csproj"
$version = ($project.Project.PropertyGroup | ForEach-Object { $_.Version } | Where-Object { $_ } | Select-Object -First 1)
$manifest = [ordered]@{
    version = "$version"
    file    = 'DbStudio.exe'
    sha256  = (Get-FileHash "$root\dist\DbStudio.exe" -Algorithm SHA256).Hash
    notes   = $Notes
}
[IO.File]::WriteAllText("$root\dist\version.json", ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

Write-Host "`nDone: $root\dist\DbStudio.exe ($version)" -ForegroundColor Green
Write-Host "To release: upload dist\DbStudio.exe and dist\version.json to the update folder." -ForegroundColor Green
