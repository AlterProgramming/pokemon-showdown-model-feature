param(
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
    [ValidateSet('move-only', 'model1-legacy', 'joint-policy', 'joint-policy-value', 'custom')]
    [string]$ModelAProfile = 'move-only',
    [ValidateSet('default', 'yes', 'no')]
    [string]$ModelAAllowVoluntarySwitches = 'default',
    [string]$ModelServerEndpoint = '',
    [string]$ModelAEndpoint = '',
    [string]$ModelBName = 'Model2',
    [string]$ModelBID = 'model2',
    [ValidateSet('move-only', 'model1-legacy', 'joint-policy', 'joint-policy-value', 'custom')]
    [string]$ModelBProfile = 'joint-policy',
    [ValidateSet('default', 'yes', 'no')]
    [string]$ModelBAllowVoluntarySwitches = 'default',
    [string]$ModelBEndpoint = '',
    [string]$LogPath = '',
    [switch]$Build
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$runnerPath = '.\dist\sim\examples\model-vs-model-runner.js'
$defaultLogPath = Join-Path $repoRoot ("model-vs-model-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
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

function Set-OptionalSwitchOverride {
    param(
        [string]$EnvName,
        [string]$Value
    )

    switch ($Value) {
    'yes' { Set-Item -Path "Env:$EnvName" -Value '1' }
    'no' { Set-Item -Path "Env:$EnvName" -Value '0' }
    default { Remove-Item "Env:$EnvName" -ErrorAction SilentlyContinue }
    }
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
    $env:MODEL_A_NAME = $ModelAName
    $env:MODEL_A_ID = $ModelAID
    $env:MODEL_A_PROFILE = $ModelAProfile
    $env:MODEL_B_NAME = $ModelBName
    $env:MODEL_B_ID = $ModelBID
    $env:MODEL_B_PROFILE = $ModelBProfile

    if ($ModelServerEndpoint) {
        $env:MODEL_SERVER_ENDPOINT = $ModelServerEndpoint
    } else {
        Remove-Item Env:MODEL_SERVER_ENDPOINT -ErrorAction SilentlyContinue
    }

    if ($ModelAEndpoint) {
        $env:MODEL_A_ENDPOINT = $ModelAEndpoint
    } else {
        Remove-Item Env:MODEL_A_ENDPOINT -ErrorAction SilentlyContinue
    }

    if ($ModelBEndpoint) {
        $env:MODEL_B_ENDPOINT = $ModelBEndpoint
    } else {
        Remove-Item Env:MODEL_B_ENDPOINT -ErrorAction SilentlyContinue
    }

    Set-OptionalSwitchOverride -EnvName 'MODEL_A_ALLOW_VOLUNTARY_SWITCHES' -Value $ModelAAllowVoluntarySwitches
    Set-OptionalSwitchOverride -EnvName 'MODEL_B_ALLOW_VOLUNTARY_SWITCHES' -Value $ModelBAllowVoluntarySwitches

    Write-Host "[runner] Repo: $repoRoot" -ForegroundColor DarkGray
    Write-Host "[runner] Model A: $ModelAName ($ModelAID / $ModelAProfile)" -ForegroundColor DarkGray
    Write-Host "[runner] Model B: $ModelBName ($ModelBID / $ModelBProfile)" -ForegroundColor DarkGray
    if ($ModelServerEndpoint) {
        Write-Host "[runner] Shared Endpoint: $ModelServerEndpoint" -ForegroundColor DarkGray
    }
    if ($ModelAEndpoint) {
        Write-Host "[runner] Model A Endpoint Override: $ModelAEndpoint" -ForegroundColor DarkGray
    }
    if ($ModelBEndpoint) {
        Write-Host "[runner] Model B Endpoint Override: $ModelBEndpoint" -ForegroundColor DarkGray
    }
    Write-Host "[runner] Games: $TotalGames  Concurrency: $Concurrency" -ForegroundColor DarkGray
    Write-Host "[runner] Log: $LogPath" -ForegroundColor DarkGray
    if ($ReplayGrid) {
        $gridFile = if ($ReplayGridFileName) { $ReplayGridFileName } else { 'model-vs-model-grid.html' }
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
