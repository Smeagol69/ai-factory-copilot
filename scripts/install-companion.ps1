[CmdletBinding()]
param(
    [string]$InstallRoot = 'D:\Modding\Satisfactory\Companion',
    [string]$TaskName = 'AI Factory Copilot Companion',
    [string]$NodePath = 'C:\Program Files\nodejs\node.exe',
    [int]$Port = 8142
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourceRoot = Join-Path $repositoryRoot 'companion'
$sourceServer = Join-Path $sourceRoot 'server.mjs'
$sourceLibrary = Join-Path $sourceRoot 'lib'
$sourceRunner = Join-Path $PSScriptRoot 'run-companion.ps1'

foreach ($requiredPath in @(
    $sourceServer,
    $sourceLibrary,
    $sourceRunner,
    (Join-Path $sourceRoot 'package.json'),
    $NodePath
)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required companion path is missing: $requiredPath"
    }
}

$fullInstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$driveRoot = [IO.Path]::GetPathRoot($fullInstallRoot).TrimEnd('\')
if ($fullInstallRoot -eq $driveRoot -or
    (Split-Path -Leaf $fullInstallRoot) -ne 'Companion') {
    throw "Refusing to clean unsafe install path '$fullInstallRoot'. The leaf directory must be 'Companion'."
}

$installParent = Split-Path -Parent $fullInstallRoot
if (-not (Test-Path -LiteralPath $installParent -PathType Container)) {
    throw "Companion install parent does not exist: $installParent"
}
if (-not (Test-Path -LiteralPath $fullInstallRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $fullInstallRoot | Out-Null
}
$resolvedInstallRoot = (Resolve-Path -LiteralPath $fullInstallRoot).Path.TrimEnd('\')
if ($resolvedInstallRoot -ne $fullInstallRoot) {
    throw "Resolved companion path '$resolvedInstallRoot' differs from requested '$fullInstallRoot'."
}

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

# Stop only the loopback bridge process that owns the configured port. Refuse
# to terminate an unrelated listener.
$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($listener in $listeners) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
    if (-not $process -or
        $process.ExecutablePath -ne $NodePath -or
        $process.CommandLine -notmatch 'server\.mjs') {
        throw "Port $Port is owned by an unrelated process; refusing to stop PID $($listener.OwningProcess)."
    }
    Stop-Process -Id $listener.OwningProcess -Force
    Wait-Process -Id $listener.OwningProcess -Timeout 10 -ErrorAction SilentlyContinue
}

# Clean one verified install directory. Preserve only logs and a user-created
# .env containing local secrets; tests and old runtime files are intentionally
# not installed.
Get-ChildItem -LiteralPath $resolvedInstallRoot -Force |
    Where-Object { $_.Name -notin @('Logs', '.env') } |
    Remove-Item -Recurse -Force

Copy-Item -LiteralPath $sourceServer -Destination $resolvedInstallRoot
Copy-Item -LiteralPath (Join-Path $sourceRoot 'package.json') -Destination $resolvedInstallRoot
Copy-Item -LiteralPath (Join-Path $sourceRoot '.env.example') -Destination $resolvedInstallRoot
Copy-Item -LiteralPath $sourceLibrary -Destination $resolvedInstallRoot -Recurse
Copy-Item -LiteralPath $sourceRunner -Destination (Join-Path $resolvedInstallRoot 'run-companion.ps1')
New-Item -ItemType Directory -Path (Join-Path $resolvedInstallRoot 'Logs') -Force | Out-Null

$powerShellPath = Join-Path $PSHOME 'powershell.exe'
$runnerPath = Join-Path $resolvedInstallRoot 'run-companion.ps1'
$action = New-ScheduledTaskAction `
    -Execute $powerShellPath `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runnerPath`"" `
    -WorkingDirectory $resolvedInstallRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
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

$healthUri = "http://127.0.0.1:$Port/health"
$health = $null
for ($attempt = 1; $attempt -le 40; ++$attempt) {
    try {
        $health = Invoke-RestMethod -Uri $healthUri -TimeoutSec 2
        if ($health.status -eq 'ok' -and $health.schema -eq 'aifactory.bridge.health') {
            break
        }
    }
    catch {
        Start-Sleep -Milliseconds 500
    }
}
if (-not $health -or $health.status -ne 'ok') {
    $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName
    throw "Companion task did not become healthy. LastTaskResult=$($taskInfo.LastTaskResult). See '$resolvedInstallRoot\Logs\companion.log'."
}

$installedLibraryCount = @(
    Get-ChildItem -LiteralPath (Join-Path $resolvedInstallRoot 'lib') -File -Filter '*.mjs'
).Count
$sourceLibraryCount = @(
    Get-ChildItem -LiteralPath $sourceLibrary -File -Filter '*.mjs'
).Count
if ($installedLibraryCount -ne $sourceLibraryCount) {
    throw "Installed library count $installedLibraryCount does not match source count $sourceLibraryCount."
}

$runtimeFiles = @(
    [pscustomobject]@{
        Source = $sourceServer
        Installed = Join-Path $resolvedInstallRoot 'server.mjs'
    },
    [pscustomobject]@{
        Source = Join-Path $sourceRoot 'package.json'
        Installed = Join-Path $resolvedInstallRoot 'package.json'
    },
    [pscustomobject]@{
        Source = Join-Path $sourceRoot '.env.example'
        Installed = Join-Path $resolvedInstallRoot '.env.example'
    },
    [pscustomobject]@{
        Source = $sourceRunner
        Installed = Join-Path $resolvedInstallRoot 'run-companion.ps1'
    }
)
foreach ($sourceFile in Get-ChildItem -LiteralPath $sourceLibrary -File -Filter '*.mjs') {
    $runtimeFiles += [pscustomobject]@{
        Source = $sourceFile.FullName
        Installed = Join-Path (Join-Path $resolvedInstallRoot 'lib') $sourceFile.Name
    }
}
foreach ($runtimeFile in $runtimeFiles) {
    $sourceHash = (Get-FileHash -LiteralPath $runtimeFile.Source -Algorithm SHA256).Hash
    $installedHash = (Get-FileHash -LiteralPath $runtimeFile.Installed -Algorithm SHA256).Hash
    if ($sourceHash -ne $installedHash) {
        throw "Installed runtime file does not match its source: $($runtimeFile.Installed)"
    }
}

Write-Host "Companion installed cleanly at '$resolvedInstallRoot'."
Write-Host "Verified $($runtimeFiles.Count) runtime file hashes."
Write-Host "Scheduled task '$TaskName' is healthy on $healthUri using provider '$($health.provider)'."
