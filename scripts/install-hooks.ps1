# Turns on the repository's git hooks for this clone (scripts\hooks\pre-push: release when the version changes).
# -Remove puts git back on its default .git\hooks.
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

if ($Remove) {
    git -C $root config --unset core.hooksPath
    Write-Host 'Hooks off: git uses .git\hooks again.'
    return
}
git -C $root config core.hooksPath scripts/hooks
Write-Host 'Hooks on: a push to main that changes <Version> releases to the update folder first.' -ForegroundColor Green
Write-Host 'Skip it once with:  $env:DBSTUDIO_SKIP_DEPLOY = 1; git push'
