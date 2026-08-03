[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('mock', 'local', 'openai', 'anthropic')]
    [string]$Provider,
    [string]$Model = '',
    [SecureString]$ApiKey,
    [string]$LocalBaseUrl = '',
    [string]$InstallRoot = '',
    [string]$TaskName = 'AI Factory Copilot Companion'
)

$ErrorActionPreference = 'Stop'

function Convert-SecureValue {
    param([SecureString]$Value)
    if (-not $Value) { return '' }
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Read-Value {
    param([string[]]$Lines, [string]$Name)
    foreach ($line in $Lines) {
        if ($line -match "^\s*$([regex]::Escape($Name))\s*=(.*)$") {
            return $Matches[1].Trim().Trim('"').Trim("'")
        }
    }
    return ''
}

function Set-Value {
    param([Collections.Generic.List[string]]$Lines, [string]$Name, [string]$Value)
    if ($Value -match '[\r\n]') {
        throw "The value for $Name cannot contain a newline."
    }
    for ($index = 0; $index -lt $Lines.Count; ++$index) {
        if ($Lines[$index] -match "^\s*$([regex]::Escape($Name))\s*=") {
            $Lines[$index] = "$Name=$Value"
            return
        }
    }
    $Lines.Add("$Name=$Value")
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $InstallRoot -and $task) {
    $InstallRoot = @($task.Actions | ForEach-Object { $_.WorkingDirectory } | Where-Object { $_ }) |
        Select-Object -First 1
}
if (-not $InstallRoot -and
    (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.aifactory-companion-install') -PathType Leaf)) {
    $InstallRoot = $PSScriptRoot
}
if (-not $InstallRoot) {
    $InstallRoot = Join-Path $env:LOCALAPPDATA 'AI Factory Copilot\Companion'
}
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$markerPath = Join-Path $InstallRoot '.aifactory-companion-install'
$runtimePath = Join-Path $InstallRoot '.runtime.json'
foreach ($requiredPath in @($markerPath, $runtimePath, (Join-Path $InstallRoot '.env.example'))) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "The companion is not a verified install at '$InstallRoot'. Run install-companion.ps1 first."
    }
}
$marker = Get-Content -Raw -LiteralPath $markerPath | ConvertFrom-Json
if ($marker.product -ne 'AI Factory Copilot Companion' -or $marker.schema_version -ne 1) {
    throw "The ownership marker is invalid at '$markerPath'."
}

$environmentPath = Join-Path $InstallRoot '.env'
$templatePath = if (Test-Path -LiteralPath $environmentPath -PathType Leaf) {
    $environmentPath
}
else {
    Join-Path $InstallRoot '.env.example'
}
$lines = [Collections.Generic.List[string]]::new()
foreach ($line in Get-Content -LiteralPath $templatePath) { $lines.Add($line) }
Set-Value -Lines $lines -Name 'AI_PROVIDER' -Value $Provider

$plainKey = ''
try {
    if ($Provider -in @('openai', 'anthropic')) {
        if (-not $ApiKey) {
            $ApiKey = Read-Host "$Provider API key (input is hidden)" -AsSecureString
        }
        $plainKey = Convert-SecureValue -Value $ApiKey
        if (-not $plainKey) { throw "$Provider requires a non-empty API key." }
    }

    if ($Provider -eq 'openai') {
        if (-not $Model) { $Model = Read-Value -Lines $lines -Name 'OPENAI_MODEL' }
        if (-not $Model) { $Model = Read-Host 'OpenAI model ID' }
        if (-not $Model) { throw 'OpenAI requires a model ID.' }
        Set-Value -Lines $lines -Name 'OPENAI_API_KEY' -Value $plainKey
        Set-Value -Lines $lines -Name 'OPENAI_MODEL' -Value $Model
    }
    elseif ($Provider -eq 'anthropic') {
        if (-not $Model) { $Model = Read-Value -Lines $lines -Name 'ANTHROPIC_MODEL' }
        if (-not $Model) { $Model = Read-Host 'Anthropic model ID' }
        if (-not $Model) { throw 'Anthropic requires an explicit model ID.' }
        Set-Value -Lines $lines -Name 'ANTHROPIC_API_KEY' -Value $plainKey
        Set-Value -Lines $lines -Name 'ANTHROPIC_MODEL' -Value $Model
    }
    elseif ($Provider -eq 'local') {
        if (-not $Model) { $Model = Read-Value -Lines $lines -Name 'LOCAL_AI_MODEL' }
        if (-not $Model) { $Model = Read-Host 'Local model ID' }
        if (-not $Model) { throw 'A local provider requires a model ID.' }
        Set-Value -Lines $lines -Name 'LOCAL_AI_MODEL' -Value $Model
        if ($LocalBaseUrl) {
            if ($LocalBaseUrl -notmatch '^https?://') { throw 'LocalBaseUrl must be an HTTP(S) URL.' }
            Set-Value -Lines $lines -Name 'LOCAL_AI_BASE_URL' -Value $LocalBaseUrl.TrimEnd('/')
        }
    }

    $lines | Set-Content -LiteralPath $environmentPath -Encoding utf8
}
finally {
    $plainKey = $null
}

if (-not $task) {
    throw "Configuration was written to '$environmentPath', but scheduled task '$TaskName' is missing. Re-run install-companion.ps1."
}
$runtime = Get-Content -Raw -LiteralPath $runtimePath | ConvertFrom-Json
$healthUri = "http://127.0.0.1:$($runtime.port)/health"
$previousHealth = $null
try { $previousHealth = Invoke-RestMethod -Uri $healthUri -TimeoutSec 2 } catch {}
if ($previousHealth -and $previousHealth.schema -ne 'aifactory.bridge.health') {
    throw "Port $($runtime.port) is not serving AI Factory Copilot; refusing to stop it."
}

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
# Task Scheduler can stop its PowerShell host before the Node child exits. Stop
# only a child whose executable, command line, install root, and health endpoint
# all identify this exact companion; a coincidental listener is never killed.
foreach ($connection in @(
    Get-NetTCPConnection -LocalPort $runtime.port -State Listen -ErrorAction SilentlyContinue
)) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)"
    $isVerifiedCompanion = $previousHealth -and
        $process -and
        [IO.Path]::GetFileName($process.ExecutablePath) -eq 'node.exe' -and
        $process.CommandLine -match 'server\.mjs' -and
        $process.CommandLine.IndexOf($InstallRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
    if (-not $isVerifiedCompanion) {
        throw "Port $($runtime.port) is owned by an unverified process; refusing to stop PID $($connection.OwningProcess)."
    }
    Stop-Process -Id $connection.OwningProcess -Force
    Wait-Process -Id $connection.OwningProcess -Timeout 10 -ErrorAction SilentlyContinue
}
Start-ScheduledTask -TaskName $TaskName

$health = $null
for ($attempt = 1; $attempt -le 30; ++$attempt) {
    try {
        $candidate = Invoke-RestMethod -Uri $healthUri -TimeoutSec 2
        if ($candidate.provider -eq $Provider) {
            $health = $candidate
            break
        }
    }
    catch {
        # The hidden task commonly needs a few polls to restart.
    }
    Start-Sleep -Milliseconds 500
}
if (-not $health) {
    throw "The companion did not restart with provider '$Provider'. See '$InstallRoot\Logs\companion.log'."
}
if ($health.status -ne 'ok') {
    $issues = @($health.readiness.issues) -join '; '
    throw "Provider '$Provider' is configured but not ready: $issues"
}

Write-Host "Configured '$Provider' at '$environmentPath'."
Write-Host "Companion health is ready: $healthUri"
