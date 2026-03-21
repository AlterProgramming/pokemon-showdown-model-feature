param(
    [ValidateSet('stdout', 'stderr')]
    [string]$Stream = 'stdout',
    [int]$Tail = 120,
    [string]$StdoutLogPath = 'logs\model-server.out.log',
    [string]$StderrLogPath = 'logs\model-server.err.log'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent

if (-not [System.IO.Path]::IsPathRooted($StdoutLogPath)) {
    $StdoutLogPath = Join-Path $repoRoot $StdoutLogPath
}
if (-not [System.IO.Path]::IsPathRooted($StderrLogPath)) {
    $StderrLogPath = Join-Path $repoRoot $StderrLogPath
}

$targetPath = if ($Stream -eq 'stderr') { $StderrLogPath } else { $StdoutLogPath }
if (-not (Test-Path $targetPath)) {
    Write-Host "[server] Log not found: $targetPath" -ForegroundColor Yellow
    exit 1
}

Write-Host "[server] Showing $Stream log: $targetPath" -ForegroundColor Cyan
Get-Content -Path $targetPath -Tail $Tail
