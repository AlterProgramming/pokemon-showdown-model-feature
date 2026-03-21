param(
    [string]$RepoPath = 'C:\Users\jeanj\Documents\School - Research\CSCI 8590 Introduction to Deep Learning\Pokemon Showdown Agent',
    [string]$VenvPython = 'C:\Users\jeanj\Documents\School - Research\deepLearning\Scripts\python.exe',
    [ValidateSet('model1', 'model2', 'model2_large', 'multi')]
    [string]$ModelVariant = 'model1',
    [switch]$Background,
    [string]$StdoutLogPath = 'logs\model-server.out.log',
    [string]$StderrLogPath = 'logs\model-server.err.log',
    [string]$StateFilePath = 'logs\model-server.state.json',
    [int]$ReadyTimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent

if (-not (Test-Path $RepoPath)) {
    throw "Training repo not found: $RepoPath"
}
if (-not (Test-Path $VenvPython)) {
    throw "Venv python not found: $VenvPython"
}

if (-not [System.IO.Path]::IsPathRooted($StdoutLogPath)) {
    $StdoutLogPath = Join-Path $repoRoot $StdoutLogPath
}
if (-not [System.IO.Path]::IsPathRooted($StderrLogPath)) {
    $StderrLogPath = Join-Path $repoRoot $StderrLogPath
}
if (-not [System.IO.Path]::IsPathRooted($StateFilePath)) {
    $StateFilePath = Join-Path $repoRoot $StateFilePath
}

$logDir = Split-Path $StdoutLogPath -Parent
if ($logDir) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$stateDir = Split-Path $StateFilePath -Parent
if ($stateDir) {
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
}

$launcherPath = if ($ModelVariant -in @('multi', 'model2_large')) {
    Join-Path $RepoPath 'flask_api_multi.py'
} else {
    Join-Path $RepoPath ".codex-flask_api_$ModelVariant.py"
}

if ($ModelVariant -notin @('multi', 'model2_large')) {
    $launcherSource = if ($ModelVariant -eq 'model2') {
        git -c safe.directory="$RepoPath" -C $RepoPath show HEAD:flask_api.py
    } else {
        Get-Content (Join-Path $RepoPath 'flask_api.py') -Raw
    }
    $launcherSource = $launcherSource -replace 'app\.run\(host="0\.0\.0\.0", port=5000, debug=True\)', 'app.run(host="0.0.0.0", port=5000, debug=False, use_reloader=False)'
    Set-Content -Path $launcherPath -Value $launcherSource
}

function Wait-ForModelServerReady {
    param([int]$TimeoutSeconds = 30)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $warmupPayload = @{
        state_vector = @(for ($i = 0; $i -lt 582; $i++) { 0 })
        legal_moves = @(
            @{
                slot = 1
                move = 'Tackle'
                id = 'tackle'
                disabled = $false
            }
        )
        legal_switches = @()
    } | ConvertTo-Json -Depth 6

    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest `
                -Uri 'http://127.0.0.1:5000/predict' `
                -Method Post `
                -UseBasicParsing `
                -ContentType 'application/json' `
                -Body $warmupPayload `
                -TimeoutSec 5
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                return $true
            }
        } catch {
            Start-Sleep -Seconds 1
        }
    }
    return $false
}

Write-Host "[server] Repo: $RepoPath" -ForegroundColor DarkGray
Write-Host "[server] Python: $VenvPython" -ForegroundColor DarkGray
Write-Host "[server] Variant: $ModelVariant" -ForegroundColor DarkGray
Write-Host "[server] Launcher: $launcherPath" -ForegroundColor DarkGray

if ($Background) {
    $pythonCommand = if ($ModelVariant -in @('multi', 'model2_large')) {
        "`"$VenvPython`" `"$launcherPath`" --mode $ModelVariant"
    } else {
        "`"$VenvPython`" `"$launcherPath`""
    }
    $cmdCommand = "set PYTHONUNBUFFERED=1 && $pythonCommand 1>> `"$StdoutLogPath`" 2>> `"$StderrLogPath`""
    $process = Start-Process `
        -FilePath 'cmd.exe' `
        -ArgumentList @('/d', '/c', $cmdCommand) `
        -WorkingDirectory $RepoPath `
        -PassThru

    @{
        pid = $process.Id
        modelVariant = $ModelVariant
        repoPath = $RepoPath
        launcherPath = $launcherPath
        stdoutLogPath = $StdoutLogPath
        stderrLogPath = $StderrLogPath
        startedAt = (Get-Date).ToString('o')
    } | ConvertTo-Json -Depth 5 | Set-Content -Path $StateFilePath

    Write-Host "[server] Started in background. PID: $($process.Id)" -ForegroundColor Cyan
    Write-Host "[server] Stdout: $StdoutLogPath" -ForegroundColor DarkGray
    Write-Host "[server] Stderr: $StderrLogPath" -ForegroundColor DarkGray
    Write-Host "[server] State: $StateFilePath" -ForegroundColor DarkGray
    if (-not (Wait-ForModelServerReady -TimeoutSeconds $ReadyTimeoutSeconds)) {
        throw "Model server did not become ready within $ReadyTimeoutSeconds seconds."
    }
    Write-Host "[server] Ready on http://127.0.0.1:5000" -ForegroundColor Cyan
    exit 0
}

Push-Location $RepoPath
try {
    if ($ModelVariant -in @('multi', 'model2_large')) {
        & $VenvPython $launcherPath --mode $ModelVariant
    } else {
        & $VenvPython $launcherPath
    }
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
