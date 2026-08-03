[CmdletBinding()]
param(
    [switch]$SkipRollback
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$testParent = Join-Path $repositoryRoot '.installer-smoke'
$testRunRoot = Join-Path $testParent ([guid]::NewGuid().ToString('N'))
$testInstallRoot = Join-Path $testRunRoot 'Companion'
$testTaskName = "AI Factory Copilot Installer Test $([guid]::NewGuid().ToString('N'))"

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$testPort = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()

$failure = $null
try {
    & (Join-Path $PSScriptRoot 'install-companion.ps1') `
        -InstallRoot $testInstallRoot `
        -TaskName $testTaskName `
        -Port $testPort

    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$testPort/health" -TimeoutSec 3
    $expectedVersion = (Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot 'companion\package.json') |
        ConvertFrom-Json).version
    if ($health.schema -ne 'aifactory.bridge.health' -or
        $health.status -ne 'ok' -or
        $health.bridge_version -ne $expectedVersion) {
        throw 'The isolated companion returned invalid health metadata.'
    }
    Write-Host "Isolated companion install passed on port $testPort."

    & (Join-Path $PSScriptRoot 'configure-companion.ps1') `
        -Provider mock `
        -InstallRoot $testInstallRoot `
        -TaskName $testTaskName
    if (-not (Test-Path -LiteralPath (Join-Path $testInstallRoot '.env') -PathType Leaf)) {
        throw 'The provider configurator did not create the private environment file.'
    }
    $configuredHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$testPort/health" -TimeoutSec 3
    if ($configuredHealth.provider -ne 'mock' -or $configuredHealth.status -ne 'ok') {
        throw 'The configured isolated companion did not restart ready in mock mode.'
    }
    Write-Host 'Secure provider configuration and task restart passed.'

    if (-not $SkipRollback) {
        # Preserve a harmless local marker in the old runtime. A deliberately
        # invalid provider then forces the upgrade's post-swap health check to
        # fail; the marker proves that rollback restored the old files.
        $installedServer = Join-Path $testInstallRoot 'server.mjs'
        Add-Content -LiteralPath $installedServer -Value "`n// installer rollback sentinel"
        $beforeRollbackHash = (Get-FileHash -LiteralPath $installedServer -Algorithm SHA256).Hash
        Set-Content -LiteralPath (Join-Path $testInstallRoot '.env') `
            -Value 'AI_PROVIDER=invalid-provider' `
            -Encoding utf8

        $upgradeFailed = $false
        try {
            & (Join-Path $PSScriptRoot 'install-companion.ps1') `
                -InstallRoot $testInstallRoot `
                -TaskName $testTaskName
        }
        catch {
            $upgradeFailed = $true
        }
        if (-not $upgradeFailed) {
            throw 'The intentionally unhealthy upgrade unexpectedly succeeded.'
        }

        $afterRollbackHash = (Get-FileHash -LiteralPath $installedServer -Algorithm SHA256).Hash
        if ($afterRollbackHash -ne $beforeRollbackHash) {
            throw 'Failed upgrade did not restore the previous runtime.'
        }

        Remove-Item -LiteralPath (Join-Path $testInstallRoot '.env') -Force
        Stop-ScheduledTask -TaskName $testTaskName -ErrorAction SilentlyContinue
        Start-ScheduledTask -TaskName $testTaskName
        $restoredHealth = $null
        for ($attempt = 1; $attempt -le 20; ++$attempt) {
            try {
                $restoredHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$testPort/health" -TimeoutSec 2
                if ($restoredHealth.status -eq 'ok') {
                    break
                }
            }
            catch {
                # Wait for the restored task.
            }
            Start-Sleep -Milliseconds 500
        }
        if (-not $restoredHealth -or $restoredHealth.status -ne 'ok') {
            throw 'The previous task did not recover after the failed upgrade.'
        }
        Write-Host 'Forced upgrade failure restored the previous runtime and task.'
    }
}
catch {
    $failure = $_
}
finally {
    Stop-ScheduledTask -TaskName $testTaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $testTaskName -Confirm:$false -ErrorAction SilentlyContinue

    foreach ($connection in @(
        Get-NetTCPConnection -LocalPort $testPort -State Listen -ErrorAction SilentlyContinue
    )) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)"
        if (-not $process -or
            $process.CommandLine -notlike "*$testInstallRoot*server.mjs*") {
            throw "Refusing to stop unexpected PID $($connection.OwningProcess) during installer-test cleanup."
        }
        Stop-Process -Id $connection.OwningProcess -Force
    }

    $safeParent = [IO.Path]::GetFullPath($testParent).TrimEnd('\') + '\'
    $safeRunRoot = [IO.Path]::GetFullPath($testRunRoot)
    if (-not $safeRunRoot.StartsWith($safeParent, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing unsafe installer-test cleanup target '$safeRunRoot'."
    }
    if (Test-Path -LiteralPath $safeRunRoot) {
        Remove-Item -LiteralPath $safeRunRoot -Recurse -Force
    }
    if ((Test-Path -LiteralPath $testParent -PathType Container) -and
        @(Get-ChildItem -LiteralPath $testParent -Force).Count -eq 0) {
        Remove-Item -LiteralPath $testParent -Force
    }
}

if ($failure) {
    throw $failure
}
