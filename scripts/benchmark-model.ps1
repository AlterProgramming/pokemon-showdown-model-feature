param(
    [ValidateSet('model1', 'model2', 'model2_large', 'multi')]
    [string]$ServerVariant,
    [ValidateSet('move-only', 'model1-legacy', 'joint-policy', 'custom')]
    [string]$RLModelProfile,
    [int]$TotalGames = 500,
    [int]$Concurrency = 5,
    [int]$BattleTimeoutMs = 180000,
    [int]$MaxFailedGames = 10,
    [ValidateSet('none', 'all', 'wins', 'losses', 'ties')]
    [string]$ReplayCaptureMode = 'none',
    [int]$ReplayCaptureCount = 0,
    [string]$ReplayOutputDir = 'logs\replays',
    [string]$RLModelID = '',
    [ValidateSet('default', 'yes', 'no')]
    [string]$AllowVoluntarySwitches = 'default',
    [string]$LogPrefix = '',
    [switch]$Build,
    [switch]$LeaveServerRunning
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if (-not $LogPrefix) {
    $LogPrefix = "$ServerVariant-benchmark-$stamp"
}

$serverOutLog = Join-Path $repoRoot "logs\$LogPrefix.server.out.log"
$serverErrLog = Join-Path $repoRoot "logs\$LogPrefix.server.err.log"
$runnerLog = Join-Path $repoRoot "logs\$LogPrefix.runner.log"
$stateFile = Join-Path $repoRoot "logs\$LogPrefix.server.state.json"

if (Test-Path $stateFile) {
    Write-Host "[benchmark] Found stale server state. Stopping previous benchmark server first." -ForegroundColor Yellow
    & (Join-Path $PSScriptRoot 'stop-model-server.ps1') -StateFilePath $stateFile
}

& (Join-Path $PSScriptRoot 'start-model-server.ps1') `
    -ModelVariant $ServerVariant `
    -Background `
    -StdoutLogPath $serverOutLog `
    -StderrLogPath $serverErrLog `
    -StateFilePath $stateFile
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

try {
    & (Join-Path $PSScriptRoot 'run-statistical-runner.ps1') `
        -TotalGames $TotalGames `
        -Concurrency $Concurrency `
        -BattleTimeoutMs $BattleTimeoutMs `
        -MaxFailedGames $MaxFailedGames `
        -ReplayCaptureMode $ReplayCaptureMode `
        -ReplayCaptureCount $ReplayCaptureCount `
        -ReplayOutputDir $ReplayOutputDir `
        -RLModelID $RLModelID `
        -RLModelProfile $RLModelProfile `
        -AllowVoluntarySwitches $AllowVoluntarySwitches `
        -LogPath $runnerLog `
        -Build:$Build
    $runnerExitCode = $LASTEXITCODE
} finally {
    if (-not $LeaveServerRunning) {
        & (Join-Path $PSScriptRoot 'stop-model-server.ps1') -StateFilePath $stateFile
    }
}

Write-Host "[benchmark] Runner log: $runnerLog" -ForegroundColor Cyan
Write-Host "[benchmark] Server stdout: $serverOutLog" -ForegroundColor DarkGray
Write-Host "[benchmark] Server stderr: $serverErrLog" -ForegroundColor DarkGray
exit $runnerExitCode
