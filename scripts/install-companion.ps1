[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'AI Factory Copilot\Companion'),
    [string]$TaskName = 'AI Factory Copilot Companion',
    [string]$NodePath = '',
    [ValidateRange(1024, 65535)]
    [int]$Port = 8142
)

$ErrorActionPreference = 'Stop'
$installRootWasProvided = $PSBoundParameters.ContainsKey('InstallRoot')
$nodePathWasProvided = $PSBoundParameters.ContainsKey('NodePath')
$portWasProvided = $PSBoundParameters.ContainsKey('Port')

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $repositoryRoot 'companion'
$sourceServer = Join-Path $sourceRoot 'server.mjs'
$sourceLibrary = Join-Path $sourceRoot 'lib'
$sourceRunner = Join-Path $PSScriptRoot 'run-companion.ps1'
$sourceConfigurator = Join-Path $PSScriptRoot 'configure-companion.ps1'
$sourcePackage = Join-Path $sourceRoot 'package.json'
$sourceEnvironmentExample = Join-Path $sourceRoot '.env.example'

function Resolve-NodePath {
    param([string]$ConfiguredPath)

    if ($ConfiguredPath) {
        if (-not (Test-Path -LiteralPath $ConfiguredPath -PathType Leaf)) {
            throw "Configured Node.js executable is missing: $ConfiguredPath"
        }
        return (Resolve-Path -LiteralPath $ConfiguredPath).Path
    }

    $command = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    foreach ($candidate in @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    throw 'Node.js 20 or newer was not found. Install it from https://nodejs.org/ and re-run this installer.'
}

function Resolve-PowerShellPath {
    foreach ($candidate in @(
        (Join-Path $PSHOME 'pwsh.exe'),
        (Join-Path $PSHOME 'powershell.exe')
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    foreach ($commandName in @('pwsh.exe', 'powershell.exe')) {
        $command = Get-Command $commandName -CommandType Application -ErrorAction SilentlyContinue
        if ($command) {
            return $command.Source
        }
    }
    throw 'Could not resolve a headless PowerShell executable for the scheduled task.'
}

function Test-RecognizedCompanionInstall {
    param([string]$CandidateRoot)

    if (-not $CandidateRoot -or
        -not (Test-Path -LiteralPath $CandidateRoot -PathType Container)) {
        return $false
    }

    $packagePath = Join-Path $CandidateRoot 'package.json'
    $serverPath = Join-Path $CandidateRoot 'server.mjs'
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
        return $false
    }

    try {
        $package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
        return $package.name -eq 'aifactory-copilot-bridge'
    }
    catch {
        return $false
    }
}

function Test-ValidOwnershipMarker {
    param([string]$CandidateRoot)

    if (-not $CandidateRoot -or
        -not (Test-Path -LiteralPath $CandidateRoot -PathType Container)) {
        return $false
    }

    $markerPath = Join-Path $CandidateRoot '.aifactory-companion-install'
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
        return $false
    }
    try {
        $marker = Get-Content -Raw -LiteralPath $markerPath | ConvertFrom-Json
        return $marker.product -eq 'AI Factory Copilot Companion' -and
            $marker.schema_version -eq 1
    }
    catch {
        return $false
    }
}

function Find-TaskInstallRoot {
    param($Task)

    if (-not $Task) {
        return $null
    }
    foreach ($taskAction in @($Task.Actions)) {
        $candidate = [string]$taskAction.WorkingDirectory
        if (-not $candidate -and
            [string]$taskAction.Arguments -match '(?i)-File\s+(?:"([^"]+)"|''([^'']+)''|(\S+))') {
            $runner = @($Matches[1], $Matches[2], $Matches[3]) |
                Where-Object { $_ } |
                Select-Object -First 1
            if ($runner) {
                $candidate = Split-Path -Parent $runner
            }
        }
        if ($candidate) {
            $candidate = [IO.Path]::GetFullPath($candidate).TrimEnd('\')
        }
        if ((Test-RecognizedCompanionInstall -CandidateRoot $candidate) -or
            (Test-ValidOwnershipMarker -CandidateRoot $candidate)) {
            return $candidate
        }
    }
    return $null
}

function Read-EnvironmentValue {
    param(
        [string]$Root,
        [string]$Name
    )

    if (-not $Root) {
        return $null
    }
    $environmentPath = Join-Path $Root '.env'
    if (-not (Test-Path -LiteralPath $environmentPath -PathType Leaf)) {
        return $null
    }
    foreach ($line in Get-Content -LiteralPath $environmentPath) {
        if ($line -match "^\s*$([regex]::Escape($Name))\s*=(.*)$") {
            $value = $Matches[1].Trim()
            if ($value.Length -ge 2 -and
                (($value.StartsWith('"') -and $value.EndsWith('"')) -or
                 ($value.StartsWith("'") -and $value.EndsWith("'")))) {
                return $value.Substring(1, $value.Length - 2)
            }
            return $value
        }
    }
    return $null
}

foreach ($requiredPath in @(
    $sourceServer,
    $sourceLibrary,
    $sourceRunner,
    $sourceConfigurator,
    $sourcePackage,
    $sourceEnvironmentExample
)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required companion source is missing: $requiredPath"
    }
}

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$taskInstallRoot = Find-TaskInstallRoot -Task $existingTask
if ($existingTask -and -not $taskInstallRoot) {
    throw "A scheduled task named '$TaskName' exists but is not a verified AI Factory Copilot task. Refusing to stop or replace it."
}
if (-not $installRootWasProvided -and $taskInstallRoot) {
    $InstallRoot = $taskInstallRoot
    Write-Host "Using the existing verified companion install at '$InstallRoot'."
}

if ((Test-Path -LiteralPath $InstallRoot -PathType Container)) {
    $existingRuntimePath = Join-Path $InstallRoot '.runtime.json'
    $existingRuntime = $null
    if (Test-Path -LiteralPath $existingRuntimePath -PathType Leaf) {
        try {
            $existingRuntime = Get-Content -Raw -LiteralPath $existingRuntimePath | ConvertFrom-Json
        }
        catch {
            throw "Existing runtime metadata is invalid: $existingRuntimePath"
        }
    }

    if (-not $portWasProvided) {
        $savedPort = if ($existingRuntime.port) {
            [int]$existingRuntime.port
        }
        else {
            $legacyPort = Read-EnvironmentValue -Root $InstallRoot -Name 'AIFACTORY_PORT'
            if ($legacyPort -match '^\d+$') { [int]$legacyPort } else { 0 }
        }
        if ($savedPort -ge 1024 -and $savedPort -le 65535) {
            $Port = $savedPort
        }
    }
    if (-not $nodePathWasProvided -and $existingRuntime.node_path) {
        $NodePath = [string]$existingRuntime.node_path
    }
}

$resolvedNodePath = Resolve-NodePath -ConfiguredPath $NodePath
$nodeVersion = (& $resolvedNodePath --version).Trim()
if ($nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) {
    throw "AI Factory Copilot requires Node.js 20 or newer; found '$nodeVersion' at '$resolvedNodePath'."
}
$powerShellPath = Resolve-PowerShellPath
$sourcePackageData = Get-Content -Raw -LiteralPath $sourcePackage | ConvertFrom-Json

$fullInstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$driveRoot = [IO.Path]::GetPathRoot($fullInstallRoot).TrimEnd('\')
if ($fullInstallRoot -eq $driveRoot -or
    (Split-Path -Leaf $fullInstallRoot) -ne 'Companion') {
    throw "Refusing unsafe install path '$fullInstallRoot'. The leaf directory must be exactly 'Companion'."
}

$installParent = Split-Path -Parent $fullInstallRoot
New-Item -ItemType Directory -Path $installParent -Force | Out-Null
$resolvedParent = (Resolve-Path -LiteralPath $installParent).Path.TrimEnd('\')
$resolvedInstallRoot = Join-Path $resolvedParent 'Companion'
if (-not [String]::Equals($resolvedInstallRoot, $fullInstallRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Resolved companion path '$resolvedInstallRoot' differs from requested '$fullInstallRoot'."
}

$installExisted = Test-Path -LiteralPath $resolvedInstallRoot -PathType Container
if ($installExisted) {
    $existingItems = @(Get-ChildItem -LiteralPath $resolvedInstallRoot -Force)
    if ($existingItems.Count -gt 0 -and
        -not (Test-ValidOwnershipMarker -CandidateRoot $resolvedInstallRoot) -and
        -not (Test-RecognizedCompanionInstall -CandidateRoot $resolvedInstallRoot)) {
        throw "Refusing to clean '$resolvedInstallRoot' because it is not a verified AI Factory Copilot install."
    }
}
elseif (Test-Path -LiteralPath $resolvedInstallRoot) {
    throw "Refusing install path '$resolvedInstallRoot' because it exists and is not a directory."
}

if ($installRootWasProvided -and $taskInstallRoot -and
    -not [String]::Equals($taskInstallRoot, $resolvedInstallRoot, [StringComparison]::OrdinalIgnoreCase)) {
    Write-Warning "The verified previous install at '$taskInstallRoot' will remain in place. Remove it explicitly after verifying this requested destination."
}

$transactionId = [guid]::NewGuid().ToString('N')
$stageRoot = Join-Path $resolvedParent ".aifactory-companion-stage-$transactionId"
$backupRoot = Join-Path $resolvedParent ".aifactory-companion-backup-$transactionId"
$parentPrefix = $resolvedParent.TrimEnd('\') + '\'
foreach ($transactionPath in @($stageRoot, $backupRoot, $resolvedInstallRoot)) {
    $fullTransactionPath = [IO.Path]::GetFullPath($transactionPath)
    if (-not $fullTransactionPath.StartsWith($parentPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing unsafe transaction path '$fullTransactionPath'."
    }
}

$runtimeFiles = @(
    [pscustomobject]@{ Source = $sourceServer; Relative = 'server.mjs' },
    [pscustomobject]@{ Source = $sourcePackage; Relative = 'package.json' },
    [pscustomobject]@{ Source = $sourceEnvironmentExample; Relative = '.env.example' },
    [pscustomobject]@{ Source = $sourceRunner; Relative = 'run-companion.ps1' },
    [pscustomobject]@{ Source = $sourceConfigurator; Relative = 'configure-companion.ps1' }
)
foreach ($sourceFile in Get-ChildItem -LiteralPath $sourceLibrary -File -Filter '*.mjs') {
    $runtimeFiles += [pscustomobject]@{
        Source = $sourceFile.FullName
        Relative = Join-Path 'lib' $sourceFile.Name
    }
}

$healthUri = "http://127.0.0.1:$Port/health"
$existingTaskXml = if ($existingTask) { Export-ScheduledTask -TaskName $TaskName } else { $null }
$existingTaskWasRunning = $existingTask -and [string]$existingTask.State -eq 'Running'
$deploymentStarted = $false
$installSucceeded = $false
$health = $null

try {
    # Build and hash a complete candidate before touching the working runtime.
    New-Item -ItemType Directory -Path $stageRoot | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $stageRoot 'lib') | Out-Null
    foreach ($runtimeFile in $runtimeFiles) {
        $stagedPath = Join-Path $stageRoot $runtimeFile.Relative
        Copy-Item -LiteralPath $runtimeFile.Source -Destination $stagedPath
        $sourceHash = (Get-FileHash -LiteralPath $runtimeFile.Source -Algorithm SHA256).Hash
        $stagedHash = (Get-FileHash -LiteralPath $stagedPath -Algorithm SHA256).Hash
        if ($sourceHash -ne $stagedHash) {
            throw "Staged runtime file does not match its source: $stagedPath"
        }
    }
    @{
        schema = 'aifactory.companion.runtime'
        schema_version = 1
        bridge_version = $sourcePackageData.version
        node_path = $resolvedNodePath
        port = $Port
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stageRoot '.runtime.json') -Encoding utf8
    @{
        product = 'AI Factory Copilot Companion'
        schema_version = 1
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stageRoot '.aifactory-companion-install') -Encoding utf8

    $deploymentStarted = $true
    if ($existingTask) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    }

    # Stop only a verified Copilot bridge. A different service is never killed
    # merely because it happens to use the requested port.
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    foreach ($processId in @($listeners.OwningProcess | Sort-Object -Unique)) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
        $isBridge = $false
        try {
            $existingHealth = Invoke-RestMethod -Uri $healthUri -TimeoutSec 2
            $isBridge = $existingHealth.schema -eq 'aifactory.bridge.health'
        }
        catch {
            $isBridge = $false
        }
        if (-not $process -or
            [IO.Path]::GetFileName($process.ExecutablePath) -ne 'node.exe' -or
            $process.CommandLine -notmatch 'server\.mjs' -or
            -not $isBridge) {
            throw "Port $Port is owned by an unrelated process; refusing to stop PID $processId."
        }
        Stop-Process -Id $processId -Force
        Wait-Process -Id $processId -Timeout 10 -ErrorAction SilentlyContinue
    }

    if (-not (Test-Path -LiteralPath $resolvedInstallRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $resolvedInstallRoot | Out-Null
    }
    New-Item -ItemType Directory -Path (Join-Path $resolvedInstallRoot 'Logs') -Force | Out-Null

    # Keep a rollback copy of every managed item. Logs and the user's .env are
    # deliberately preserved in place across upgrades.
    $managedItems = @(
        Get-ChildItem -LiteralPath $resolvedInstallRoot -Force |
            Where-Object { $_.Name -notin @('Logs', '.env') }
    )
    if ($managedItems.Count -gt 0) {
        New-Item -ItemType Directory -Path $backupRoot | Out-Null
        foreach ($item in $managedItems) {
            Copy-Item -LiteralPath $item.FullName -Destination $backupRoot -Recurse
        }
    }

    foreach ($item in $managedItems) {
        Remove-Item -LiteralPath $item.FullName -Recurse -Force
    }
    foreach ($item in Get-ChildItem -LiteralPath $stageRoot -Force) {
        Copy-Item -LiteralPath $item.FullName -Destination $resolvedInstallRoot -Recurse
    }

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $identity -or -not $identity.User) {
        throw 'Could not resolve the current Windows identity for the scheduled task.'
    }
    $runnerPath = Join-Path $resolvedInstallRoot 'run-companion.ps1'
    $action = New-ScheduledTaskAction `
        -Execute $powerShellPath `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runnerPath`"" `
        -WorkingDirectory $resolvedInstallRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -MultipleInstances IgnoreNew `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero)
    $principal = New-ScheduledTaskPrincipal `
        -UserId $identity.User.Value `
        -LogonType Interactive `
        -RunLevel Limited

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description 'Starts the localhost AI Factory Copilot bridge at user logon.' `
        -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName

    for ($attempt = 1; $attempt -le 40; ++$attempt) {
        try {
            $candidateHealth = Invoke-RestMethod -Uri $healthUri -TimeoutSec 2
            if ($candidateHealth.status -eq 'ok' -and
                $candidateHealth.schema -eq 'aifactory.bridge.health' -and
                $candidateHealth.bridge_version -eq $sourcePackageData.version) {
                $health = $candidateHealth
                break
            }
        }
        catch {
            # The task commonly needs one or two polls to start listening.
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $health) {
        $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName
        throw "Companion task is not ready. LastTaskResult=$($taskInfo.LastTaskResult). See '$resolvedInstallRoot\Logs\companion.log'."
    }

    foreach ($runtimeFile in $runtimeFiles) {
        $installedPath = Join-Path $resolvedInstallRoot $runtimeFile.Relative
        $sourceHash = (Get-FileHash -LiteralPath $runtimeFile.Source -Algorithm SHA256).Hash
        $installedHash = (Get-FileHash -LiteralPath $installedPath -Algorithm SHA256).Hash
        if ($sourceHash -ne $installedHash) {
            throw "Installed runtime file does not match its source: $installedPath"
        }
    }

    $installSucceeded = $true
}
catch {
    $failure = $_
    if ($deploymentStarted) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        # Task Scheduler can terminate the PowerShell host before its Node child.
        # Remove only the verified bridge child so the restored task can reclaim
        # the port instead of looping behind an orphaned failed runtime.
        foreach ($connection in @(
            Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        )) {
            $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)"
            $belongsToInstall = $process -and
                [IO.Path]::GetFileName($process.ExecutablePath) -eq 'node.exe' -and
                $process.CommandLine -match 'server\.mjs' -and
                $process.CommandLine -like "*$resolvedInstallRoot*"
            if ($belongsToInstall) {
                Stop-Process -Id $connection.OwningProcess -Force
                Wait-Process -Id $connection.OwningProcess -Timeout 10 -ErrorAction SilentlyContinue
            }
        }
        if (Test-Path -LiteralPath $resolvedInstallRoot -PathType Container) {
            Get-ChildItem -LiteralPath $resolvedInstallRoot -Force |
                Where-Object { $_.Name -notin @('Logs', '.env') } |
                Remove-Item -Recurse -Force
            if (Test-Path -LiteralPath $backupRoot -PathType Container) {
                foreach ($item in Get-ChildItem -LiteralPath $backupRoot -Force) {
                    Copy-Item -LiteralPath $item.FullName -Destination $resolvedInstallRoot -Recurse
                }
            }
        }

        if ($existingTaskXml) {
            Register-ScheduledTask -TaskName $TaskName -Xml $existingTaskXml -Force | Out-Null
            if ($existingTaskWasRunning) {
                Start-ScheduledTask -TaskName $TaskName
            }
        }
        else {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        }
    }
    throw $failure
}
finally {
    foreach ($temporaryPath in @($stageRoot, $backupRoot)) {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Recurse -Force
        }
    }
    if (-not $installSucceeded -and -not $installExisted -and
        (Test-Path -LiteralPath $resolvedInstallRoot -PathType Container) -and
        -not (Test-Path -LiteralPath (Join-Path $resolvedInstallRoot '.env') -PathType Leaf)) {
        Remove-Item -LiteralPath $resolvedInstallRoot -Recurse -Force
    }
}

Write-Host "Companion $($sourcePackageData.version) installed cleanly at '$resolvedInstallRoot'."
Write-Host "Verified $($runtimeFiles.Count) runtime file hashes with Node $nodeVersion."
Write-Host "Scheduled task '$TaskName' is ready on $healthUri using provider '$($health.provider)'."
