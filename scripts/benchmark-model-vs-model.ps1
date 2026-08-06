param(
    [string]$ServerHost = '127.0.0.1',
    [int]$ServerPort = 5000,
    [string]$ServerModelIDs = '',
    [int]$TotalGames = 100,
    [int]$Concurrency = 5,
    [int]$BattleTimeoutMs = 180000,
    [int]$MaxFailedGames = 10,
    [ValidateSet('none', 'all', 'wins', 'losses', 'ties')]
    [string]$ReplayCaptureMode = 'none',
    [int]$ReplayCaptureCount = 0,
    [string]$ReplayOutputDir = 'logs\replays',
    [switch]$ReplayGrid,
    [int]$ReplayGridRefreshSeconds = 2,
    [string]$ReplayGridFileName = '',
    [string]$ModelAName = 'Model1',
    [string]$ModelAID = 'model1',
    [ValidateSet('move-only', 'model1-legacy', 'joint-policy', 'joint-policy-value', 'not-elman-policy', 'custom')]
    [string]$ModelAProfile = 'move-only',
    [ValidateSet('default', 'yes', 'no')]
    [string]$ModelAAllowVoluntarySwitches = 'default',
    [string]$ModelBName = 'Model2',
    [string]$ModelBID = 'model2',
    [ValidateSet('move-only', 'model1-legacy', 'joint-policy', 'joint-policy-value', 'not-elman-policy', 'custom')]
    [string]$ModelBProfile = 'joint-policy',
    [ValidateSet('default', 'yes', 'no')]
    [string]$ModelBAllowVoluntarySwitches = 'default',
    [double]$RequestTimeoutSeconds = 15.0,
    [int]$WorkerMaxRequests = 5000,
    [double]$WorkerMaxAgeSeconds = 3600.0,
    [int]$WorkersPerModel = 1,
    [string]$ModelWorkerOverrides = '',
    [double]$WorkerBootstrapTimeoutSeconds = 30.0,
    [double]$WorkerStartupTimeoutSeconds = 120.0,
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
$runnerHost = if ($ServerHost -in @('0.0.0.0', '::')) { '127.0.0.1' } else { $ServerHost }
$serverEndpoint = "http://$($runnerHost):$ServerPort/predict"
$resolvedServerModelIDs = $ServerModelIDs
if (-not $resolvedServerModelIDs) {
    $resolvedServerModelIDs = (@($ModelAID, $ModelBID) | Where-Object { $_ } | Select-Object -Unique) -join ','
}

if (Test-Path $stateFile) {
    Write-Host "[benchmark] Found stale server state. Stopping previous benchmark server first." -ForegroundColor Yellow
    & (Join-Path $PSScriptRoot 'stop-model-server.ps1') -StateFilePath $stateFile
}

& (Join-Path $PSScriptRoot 'start-model-server.ps1') `
    -ModelVariant multi `
    -ModelIDs $resolvedServerModelIDs `
    -ListenHost $ServerHost `
    -Port $ServerPort `
    -RequestTimeoutSeconds $RequestTimeoutSeconds `
    -WorkerMaxRequests $WorkerMaxRequests `
    -WorkerMaxAgeSeconds $WorkerMaxAgeSeconds `
    -WorkersPerModel $WorkersPerModel `
    -ModelWorkerOverrides $ModelWorkerOverrides `
    -WorkerBootstrapTimeoutSeconds $WorkerBootstrapTimeoutSeconds `
    -WorkerStartupTimeoutSeconds $WorkerStartupTimeoutSeconds `
    -Background `
    -StdoutLogPath $serverOutLog `
    -StderrLogPath $serverErrLog `
    -StateFilePath $stateFile
if ($LASTEXITCODE -ne 0) {
    $global:LASTEXITCODE = $LASTEXITCODE
    return
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
        -ReplayGrid:$ReplayGrid `
        -ReplayGridRefreshSeconds $ReplayGridRefreshSeconds `
        -ReplayGridFileName $ReplayGridFileName `
        -ModelAName $ModelAName `
        -ModelAID $ModelAID `
        -ModelAProfile $ModelAProfile `
        -ModelAAllowVoluntarySwitches $ModelAAllowVoluntarySwitches `
        -ModelServerEndpoint $serverEndpoint `
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
$global:LASTEXITCODE = $runnerExitCode
return
