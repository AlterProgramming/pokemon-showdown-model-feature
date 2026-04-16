param(
    [int]$TotalGames = 20,
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
    [string]$RLModelID = '',
    [string]$RLModelEndpoint = '',
    [ValidateSet('move-only', 'model1-legacy', 'joint-policy', 'joint-policy-value', 'custom')]
    [string]$RLModelProfile = 'joint-policy',
    [ValidateSet('default', 'yes', 'no')]
    [string]$AllowVoluntarySwitches = 'default',
    [string]$LogPath = '',
    [switch]$Build
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$runnerPath = '.\dist\sim\examples\statistical-runner.js'
$defaultLogPath = Join-Path $repoRoot ("runner-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$nodeExecutable = if (Test-Path 'C:\Program Files\nodejs\node.exe') {
    'C:\Program Files\nodejs\node.exe'
} elseif (Get-Command node -ErrorAction SilentlyContinue) {
    'node'
} else {
    throw 'Node.js executable not found.'
}

if (-not $LogPath) {
    $LogPath = $defaultLogPath
} elseif (-not [System.IO.Path]::IsPathRooted($LogPath)) {
    $LogPath = Join-Path $repoRoot $LogPath
}

Push-Location $repoRoot
try {
    if ($Build) {
        & $nodeExecutable build
        if ($LASTEXITCODE -ne 0) {
            return
        }
    }

    $env:TOTAL_GAMES = "$TotalGames"
    $env:CONCURRENCY = "$Concurrency"
    $env:BATTLE_TIMEOUT_MS = "$BattleTimeoutMs"
    $env:MAX_FAILED_GAMES = "$MaxFailedGames"
    $env:REPLAY_CAPTURE_MODE = $ReplayCaptureMode
    $env:REPLAY_CAPTURE_COUNT = "$ReplayCaptureCount"
    if ([System.IO.Path]::IsPathRooted($ReplayOutputDir)) {
        $env:REPLAY_OUTPUT_DIR = $ReplayOutputDir
    } else {
        $env:REPLAY_OUTPUT_DIR = Join-Path $repoRoot $ReplayOutputDir
    }
    if ($ReplayGrid) {
        $env:REPLAY_GRID = '1'
        $env:REPLAY_GRID_REFRESH_SECONDS = "$ReplayGridRefreshSeconds"
        if ($ReplayGridFileName) {
            $env:REPLAY_GRID_FILE_NAME = $ReplayGridFileName
        } else {
            Remove-Item Env:REPLAY_GRID_FILE_NAME -ErrorAction SilentlyContinue
        }
    } else {
        Remove-Item Env:REPLAY_GRID -ErrorAction SilentlyContinue
        Remove-Item Env:REPLAY_GRID_REFRESH_SECONDS -ErrorAction SilentlyContinue
        Remove-Item Env:REPLAY_GRID_FILE_NAME -ErrorAction SilentlyContinue
    }
    $env:RL_MODEL_PROFILE = $RLModelProfile
    if ($RLModelID) {
        $env:RL_MODEL_ID = $RLModelID
    } else {
        Remove-Item Env:RL_MODEL_ID -ErrorAction SilentlyContinue
    }
    if ($RLModelEndpoint) {
        $env:RL_MODEL_ENDPOINT = $RLModelEndpoint
    } else {
        Remove-Item Env:RL_MODEL_ENDPOINT -ErrorAction SilentlyContinue
    }
    switch ($AllowVoluntarySwitches) {
    'yes' { $env:RL_ALLOW_VOLUNTARY_SWITCHES = '1' }
    'no' { $env:RL_ALLOW_VOLUNTARY_SWITCHES = '0' }
    default { Remove-Item Env:RL_ALLOW_VOLUNTARY_SWITCHES -ErrorAction SilentlyContinue }
    }

    Write-Host "[runner] Repo: $repoRoot" -ForegroundColor DarkGray
    Write-Host "[runner] Profile: $RLModelProfile" -ForegroundColor DarkGray
    if ($RLModelEndpoint) {
        Write-Host "[runner] Endpoint: $RLModelEndpoint" -ForegroundColor DarkGray
    }
    Write-Host "[runner] Games: $TotalGames  Concurrency: $Concurrency" -ForegroundColor DarkGray
    Write-Host "[runner] Log: $LogPath" -ForegroundColor DarkGray
    if ($ReplayGrid) {
        $gridFile = if ($ReplayGridFileName) { $ReplayGridFileName } else { 'random-vs-model-grid.html' }
        Write-Host "[runner] Replay Grid: $(Join-Path $env:REPLAY_OUTPUT_DIR $gridFile)" -ForegroundColor DarkGray
    }

    if (Test-Path $LogPath) {
        Remove-Item $LogPath -Force
    }

    # Stream the runner output live while also saving it to disk.
    & cmd.exe /d /c "`"$nodeExecutable`" `"$runnerPath`" 2>&1" | Tee-Object -FilePath $LogPath
    $exitCode = $LASTEXITCODE

    if (-not (Test-Path $LogPath)) {
        Write-Host "[runner] Log file was not created." -ForegroundColor Yellow
    }

    $global:LASTEXITCODE = $exitCode
    return
} finally {
    Pop-Location
}
