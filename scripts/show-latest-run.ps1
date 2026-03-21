param(
    [string]$Pattern = 'runner-*.log',
    [int]$Tail = 120
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent

$latest = Get-ChildItem -Path $repoRoot -Filter $Pattern -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $latest) {
    Write-Host "[runner] No log files matched pattern: $Pattern" -ForegroundColor Yellow
    exit 1
}

Write-Host "[runner] Latest log: $($latest.FullName)" -ForegroundColor Cyan
Get-Content -Path $latest.FullName -Tail $Tail
