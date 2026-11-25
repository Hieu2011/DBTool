# Builds the UI, embeds it into the host and publishes a single self-contained DbStudio.exe into .\dist
param(
    [switch]$FrameworkDependent,  # smaller exe; needs the .NET 8 Desktop Runtime installed
    [string]$Notes = '',          # shown by Help > Check for updates
    [switch]$SkipInstall          # keep web\node_modules as it is instead of npm ci
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

Push-Location "$root\web"
if (-not $SkipInstall) { npm ci; if ($LASTEXITCODE) { throw 'npm ci failed' } }
npm run build
if ($LASTEXITCODE) { throw 'The UI build failed' }
Pop-Location

# A running DbStudio locks its exe but lets it be renamed: step it aside (the next start deletes the .old file).
$target = "$root\dist\DbStudio.exe"
if (Test-Path $target) {
    try { [IO.File]::Open($target, 'Open', 'ReadWrite', 'None').Dispose() }
    catch { Move-Item $target "$target.old" -Force }
}

$selfContained = if ($FrameworkDependent) { 'false' } else { 'true' }
# Compressed inside the exe (about 95 MB instead of 225): a smaller update download for a slightly slower start.
# Only a self-contained bundle can be compressed.
$compress = if ($FrameworkDependent) { 'false' } else { 'true' }

dotnet publish "$root\src\DbStudio.Host" -c Release -r win-x64 `
    --self-contained $selfContained `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:EnableCompressionInSingleFile=$compress `
    -p:DebugType=none `
    -o "$root\dist"
if ($LASTEXITCODE) { throw 'dotnet publish failed' }

# version.json goes into the update folder together with the exe (Help > Check for updates reads it).
[xml]$project = Get-Content "$root\src\DbStudio.Host\DbStudio.Host.csproj"
$version = ($project.Project.PropertyGroup | ForEach-Object { $_.Version } | Where-Object { $_ } | Select-Object -First 1)
$manifest = [ordered]@{
    version = "$version"
    file    = 'DbStudio.exe'
    sha256  = (Get-FileHash "$root\dist\DbStudio.exe" -Algorithm SHA256).Hash
    date    = (Get-Date -Format 'yyyy-MM-dd')
    notes   = $Notes
}
[IO.File]::WriteAllText("$root\dist\version.json", ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

Write-Host "`nDone: $root\dist\DbStudio.exe ($version)" -ForegroundColor Green
Write-Host "To release: upload dist\DbStudio.exe and dist\version.json to the update folder." -ForegroundColor Green
