param(
    [string]$StateFilePath = 'logs\model-server.state.json'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent

if (-not [System.IO.Path]::IsPathRooted($StateFilePath)) {
    $StateFilePath = Join-Path $repoRoot $StateFilePath
}

if (-not (Test-Path $StateFilePath)) {
    Write-Host "[server] State file not found: $StateFilePath" -ForegroundColor Yellow
    exit 0
}

$state = Get-Content -Path $StateFilePath -Raw | ConvertFrom-Json
$processId = [int]$state.pid

try {
    $process = Get-Process -Id $processId -ErrorAction Stop
    & taskkill /PID $processId /T /F | Out-Null
    Write-Host "[server] Stopped PID $processId ($($state.modelVariant))" -ForegroundColor Cyan
} catch {
    Write-Host "[server] Process $processId was not running." -ForegroundColor Yellow
}

Remove-Item $StateFilePath -Force -ErrorAction SilentlyContinue
