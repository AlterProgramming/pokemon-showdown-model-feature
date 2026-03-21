param(
    [int]$TotalGames = 100,
    [int]$Concurrency = 5,
    [int]$BattleTimeoutMs = 180000,
    [int]$MaxFailedGames = 10,
    [ValidateSet('none', 'all', 'wins', 'losses', 'ties')]
    [string]$ReplayCaptureMode = 'none',
    [int]$ReplayCaptureCount = 0,
    [string]$ReplayOutputDir = 'logs\replays',
    [string]$ModelAName = 'Model1',
    [string]$ModelAID = 'model1',
    [ValidateSet('move-only', 'model1-legacy', 'joint-policy', 'custom')]
    [string]$ModelAProfile = 'move-only',
    [ValidateSet('default', 'yes', 'no')]
    [string]$ModelAAllowVoluntarySwitches = 'default',
    [string]$ModelBName = 'Model2',
    [string]$ModelBID = 'model2',
    [ValidateSet('move-only', 'model1-legacy', 'joint-policy', 'custom')]
    [string]$ModelBProfile = 'joint-policy',
    [ValidateSet('default', 'yes', 'no')]
    [string]$ModelBAllowVoluntarySwitches = 'default',
    [string]$LogPrefix = '',
    [switch]$Build,
    [switch]$LeaveServerRunning
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if (-not $LogPrefix) {
    $LogPrefix = "model-vs-model-$stamp"
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
    -ModelVariant multi `
    -Background `
    -StdoutLogPath $serverOutLog `
    -StderrLogPath $serverErrLog `
    -StateFilePath $stateFile
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

try {
    & (Join-Path $PSScriptRoot 'run-model-vs-model.ps1') `
        -TotalGames $TotalGames `
        -Concurrency $Concurrency `
        -BattleTimeoutMs $BattleTimeoutMs `
        -MaxFailedGames $MaxFailedGames `
        -ReplayCaptureMode $ReplayCaptureMode `
        -ReplayCaptureCount $ReplayCaptureCount `
        -ReplayOutputDir $ReplayOutputDir `
        -ModelAName $ModelAName `
        -ModelAID $ModelAID `
        -ModelAProfile $ModelAProfile `
        -ModelAAllowVoluntarySwitches $ModelAAllowVoluntarySwitches `
        -ModelBName $ModelBName `
        -ModelBID $ModelBID `
        -ModelBProfile $ModelBProfile `
        -ModelBAllowVoluntarySwitches $ModelBAllowVoluntarySwitches `
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
