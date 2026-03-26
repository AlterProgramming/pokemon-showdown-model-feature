param(
    [string]$RepoPath = 'C:\Users\jeanj\Documents\School - Research\CSCI 8590 Introduction to Deep Learning\Pokemon Showdown Agent',
    [string]$VenvPython = 'C:\Users\jeanj\Documents\School - Research\deepLearning\Scripts\python.exe',
    [string]$ModelVariant = 'multi',
    [string]$ModelIDs = '',
    [string]$ListenHost = '127.0.0.1',
    [int]$Port = 5000,
    [double]$RequestTimeoutSeconds = 15.0,
    [int]$WorkerMaxRequests = 5000,
    [double]$WorkerMaxAgeSeconds = 3600.0,
    [int]$WorkersPerModel = 1,
    [string]$ModelWorkerOverrides = '',
    [double]$WorkerBootstrapTimeoutSeconds = 30.0,
    [double]$WorkerStartupTimeoutSeconds = 120.0,
    [switch]$Background,
    [string]$StdoutLogPath = 'logs\model-server.out.log',
    [string]$StderrLogPath = 'logs\model-server.err.log',
    [string]$StateFilePath = 'logs\model-server.state.json',
    [int]$ReadyTimeoutSeconds = 240
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent

if (-not (Test-Path $RepoPath)) {
    throw "Training repo not found: $RepoPath"
}
if (-not (Test-Path $VenvPython)) {
    throw "Venv python not found: $VenvPython"
}

$registryPath = Join-Path $RepoPath 'artifacts\model_registry.json'
$registeredVariants = @()
if (Test-Path $registryPath) {
    try {
        $registry = Get-Content $registryPath -Raw | ConvertFrom-Json -Depth 8
        $registeredVariants = @($registry.models.PSObject.Properties.Name)
    } catch {
        Write-Warning "Failed to parse model registry at $registryPath. Continuing without wrapper-side validation."
    }
}

if ($ModelVariant -ne 'multi' -and $registeredVariants.Count -and $ModelVariant -notin $registeredVariants) {
    throw "Model variant '$ModelVariant' is not in $registryPath. Registered models: $($registeredVariants -join ', ')"
}

$requestedModelIDs = @()
if ($ModelIDs) {
    $requestedModelIDs = @(
        $ModelIDs.Split(',') |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ }
    )
}

if ($ModelVariant -ne 'multi' -and $requestedModelIDs.Count) {
    throw "-ModelIDs can only be used when -ModelVariant multi is selected."
}

if ($registeredVariants.Count -and $requestedModelIDs.Count) {
    $missingModelIDs = @($requestedModelIDs | Where-Object { $_ -notin $registeredVariants })
    if ($missingModelIDs.Count) {
        throw "Model IDs not found in ${registryPath}: $($missingModelIDs -join ', '). Registered models: $($registeredVariants -join ', ')"
    }
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

$launcherPath = Join-Path $RepoPath 'flask_api_multi.py'
$requestTimeoutArg = $RequestTimeoutSeconds.ToString([System.Globalization.CultureInfo]::InvariantCulture)
$workerMaxAgeArg = $WorkerMaxAgeSeconds.ToString([System.Globalization.CultureInfo]::InvariantCulture)
$workerBootstrapTimeoutArg = $WorkerBootstrapTimeoutSeconds.ToString([System.Globalization.CultureInfo]::InvariantCulture)
$workerStartupTimeoutArg = $WorkerStartupTimeoutSeconds.ToString([System.Globalization.CultureInfo]::InvariantCulture)
$readyCheckHost = if ($ListenHost -in @('0.0.0.0', '::')) { '127.0.0.1' } else { $ListenHost }
$pythonArgs = @(
    $launcherPath
    '--mode'
    $ModelVariant
    '--host'
    $ListenHost
    '--port'
    $Port
    '--request-timeout-seconds'
    $requestTimeoutArg
    '--worker-max-requests'
    $WorkerMaxRequests
    '--worker-max-age-seconds'
    $workerMaxAgeArg
    '--workers-per-model'
    $WorkersPerModel
    '--worker-bootstrap-timeout-seconds'
    $workerBootstrapTimeoutArg
    '--worker-startup-timeout-seconds'
    $workerStartupTimeoutArg
)
if ($ModelWorkerOverrides) {
    $pythonArgs += @('--model-worker-overrides', $ModelWorkerOverrides)
}
if ($requestedModelIDs.Count) {
    $pythonArgs += @('--model-ids', ($requestedModelIDs -join ','))
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
                -Uri ("http://{0}:{1}/predict" -f $readyCheckHost, $Port) `
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
if ($requestedModelIDs.Count) {
    Write-Host "[server] Model IDs: $($requestedModelIDs -join ', ')" -ForegroundColor DarkGray
}
Write-Host "[server] Host: $ListenHost" -ForegroundColor DarkGray
Write-Host "[server] Port: $Port" -ForegroundColor DarkGray
Write-Host "[server] Launcher: $launcherPath" -ForegroundColor DarkGray
Write-Host "[server] Request Timeout Seconds: $requestTimeoutArg" -ForegroundColor DarkGray
Write-Host "[server] Worker Max Requests: $WorkerMaxRequests" -ForegroundColor DarkGray
Write-Host "[server] Worker Max Age Seconds: $workerMaxAgeArg" -ForegroundColor DarkGray
Write-Host "[server] Workers Per Model: $WorkersPerModel" -ForegroundColor DarkGray
Write-Host "[server] Worker Bootstrap Timeout Seconds: $workerBootstrapTimeoutArg" -ForegroundColor DarkGray
Write-Host "[server] Worker Startup Timeout Seconds: $workerStartupTimeoutArg" -ForegroundColor DarkGray
if ($ModelWorkerOverrides) {
    Write-Host "[server] Model Worker Overrides: $ModelWorkerOverrides" -ForegroundColor DarkGray
}
if ($registeredVariants.Count) {
    Write-Host "[server] Registry Models: $($registeredVariants -join ', ')" -ForegroundColor DarkGray
}

if ($Background) {
    $pythonCommand = "`"$VenvPython`" " + (($pythonArgs | ForEach-Object {
        if ($_ -match '\s') {
            "`"$_`""
        } else {
            "$_"
        }
    }) -join ' ')
    $cmdCommand = "set PYTHONUNBUFFERED=1 && $pythonCommand 1>> `"$StdoutLogPath`" 2>> `"$StderrLogPath`""
    $process = Start-Process `
        -FilePath 'cmd.exe' `
        -ArgumentList @('/d', '/c', $cmdCommand) `
        -WorkingDirectory $RepoPath `
        -PassThru

    @{
        pid = $process.Id
        modelVariant = $ModelVariant
        modelIDs = $requestedModelIDs
        repoPath = $RepoPath
        launcherPath = $launcherPath
        host = $ListenHost
        port = $Port
        requestTimeoutSeconds = $RequestTimeoutSeconds
        workerMaxRequests = $WorkerMaxRequests
        workerMaxAgeSeconds = $WorkerMaxAgeSeconds
        workersPerModel = $WorkersPerModel
        modelWorkerOverrides = $ModelWorkerOverrides
        workerBootstrapTimeoutSeconds = $WorkerBootstrapTimeoutSeconds
        workerStartupTimeoutSeconds = $WorkerStartupTimeoutSeconds
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
    Write-Host ("[server] Ready on http://{0}:{1}" -f $readyCheckHost, $Port) -ForegroundColor Cyan
    $global:LASTEXITCODE = 0
    return
}

Push-Location $RepoPath
try {
    & $VenvPython @pythonArgs
    $global:LASTEXITCODE = $LASTEXITCODE
    return
} finally {
    Pop-Location
}
