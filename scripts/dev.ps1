# Starts Vite (hot reload) in a new window, then the host in --dev mode.
# The host window loads http://localhost:5173; the API listens on 127.0.0.1:5280 without a token.
$root = Split-Path $PSScriptRoot -Parent

if (-not (Test-Path "$root\web\node_modules")) {
    Push-Location "$root\web"; npm install; Pop-Location
}

Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\web'; npm run dev"
Start-Sleep -Seconds 2
dotnet watch --project "$root\src\DbStudio.Host" run -- --dev
