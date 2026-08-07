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
        $registry = Get-Content $registryPath -Raw | ConvertFrom-Json
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

function New-VectorWarmupPayload {
    param([string]$ModelID = '')

    return @{
        model_id = $ModelID
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
}

function New-SequenceWarmupPayload {
    param(
        [string]$ModelID,
        [int]$SequenceLength
    )

    $history = @()
    for ($turn = 0; $turn -lt $SequenceLength; $turn++) {
        $history += ,@(for ($i = 0; $i -lt 582; $i++) { 0 })
    }

    return @{
        model_id = $ModelID
        state_history = $history
        legal_moves = @(
            @{
                slot = 1
                move = 'Tackle'
                id = 'tackle'
                disabled = $false
            }
        )
        legal_switches = @()
    } | ConvertTo-Json -Depth 8
}

function New-EntityWarmupPayload {
    $boosts = @{
        atk = 0
        def = 0
        spa = 0
        spd = 0
        spe = 0
        accuracy = 0
        evasion = 0
    }

    return @{
        battle_state = @{
            turn_index = 1
            field = @{
                weather = $null
                global_conditions = @()
            }
            p1 = @{
                active_uid = 'p1a'
                slots = @('p1a', $null, $null, $null, $null, $null)
                side_conditions = @{}
            }
            p2 = @{
                active_uid = 'p2a'
                slots = @('p2a', $null, $null, $null, $null, $null)
                side_conditions = @{}
            }
            mons = @{
                p1a = @{
                    uid = 'p1a'
                    player = 'p1'
                    species = 'Pikachu'
                    hp_frac = 1.0
                    status = $null
                    ability = $null
                    item = $null
                    tera_type = $null
                    terastallized = $false
                    public_revealed = $true
                    fainted = $false
                    boosts = $boosts
                    observed_moves = @('thunderbolt')
                }
                p2a = @{
                    uid = 'p2a'
                    player = 'p2'
                    species = 'Eevee'
                    hp_frac = 1.0
                    status = $null
                    ability = $null
                    item = $null
                    tera_type = $null
                    terastallized = $false
                    public_revealed = $true
                    fainted = $false
                    boosts = $boosts
                    observed_moves = @('tackle')
                }
            }
        }
        perspective_player = 'p1'
        legal_moves = @(
            @{
                slot = 1
                move = 'Tackle'
                id = 'tackle'
                disabled = $false
            }
        )
        legal_switches = @()
    } | ConvertTo-Json -Depth 12
}

function Get-ModelServerWarmupPayload {
    param(
        [Parameter(Mandatory = $true)]
        $Health
    )

    $modelID = [string]$Health.default_model_id
    $contract = $null
    if ($Health.model_contracts -and $modelID) {
        $contractProperty = $Health.model_contracts.PSObject.Properties[$modelID]
        if ($contractProperty) {
            $contract = $contractProperty.Value
        }
    }

    if ($contract -and [bool]$contract.sequence_model) {
        $sequenceLength = [int]$contract.sequence_length
        if ($sequenceLength -le 0) {
            $sequenceLength = 16
        }
        return New-SequenceWarmupPayload -ModelID $modelID -SequenceLength $sequenceLength
    }

    if ($Health.default_entity_model_id) {
        return New-EntityWarmupPayload
    }

    return New-VectorWarmupPayload -ModelID $modelID
}

function Wait-ForModelServerReady {
    param([int]$TimeoutSeconds = 30)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-RestMethod `
                -Uri ("http://{0}:{1}/health" -f $readyCheckHost, $Port) `
                -Method Get `
                -TimeoutSec 5
            if ($null -eq $health -or $health.status -ne 'ok') {
                Start-Sleep -Seconds 1
                continue
            }

            $defaultContract = $null
            if ($health.model_contracts -and $health.default_model_id) {
                $contractProperty = $health.model_contracts.PSObject.Properties[[string]$health.default_model_id]
                if ($contractProperty) {
                    $defaultContract = $contractProperty.Value
                }
            }
            $warmupMode = if ($defaultContract -and [bool]$defaultContract.sequence_model) {
                'sequence'
            } elseif ($health.default_entity_model_id) {
                'entity'
            } else {
                'vector'
            }
            Write-Host "[server] Warmup mode: $warmupMode" -ForegroundColor DarkGray

            $response = Invoke-WebRequest `
                -Uri ("http://{0}:{1}/predict" -f $readyCheckHost, $Port) `
                -Method Post `
                -UseBasicParsing `
                -ContentType 'application/json' `
                -Body (Get-ModelServerWarmupPayload -Health $health) `
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
