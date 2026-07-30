[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repositoryCompanion = Join-Path (Split-Path -Parent $PSScriptRoot) 'companion'
$companionRoot = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'server.mjs') -PathType Leaf) {
    $PSScriptRoot
}
else {
    $repositoryCompanion
}
$logRoot = Join-Path $companionRoot 'Logs'
$logPath = Join-Path $logRoot 'companion.log'
trap {
    $message = "[$([DateTime]::UtcNow.ToString('o'))] Companion startup failed:`r`n$($_ | Out-String)"
    try {
        New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
        Add-Content -LiteralPath $logPath -Value $message
    }
    catch {
        # There is nowhere else reliable for a hidden scheduled task to log.
    }
    [Console]::Error.WriteLine($message)
    exit 1
}
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

$runtimePath = Join-Path $companionRoot '.runtime.json'
$runtime = if (Test-Path -LiteralPath $runtimePath -PathType Leaf) {
    Get-Content -Raw -LiteralPath $runtimePath | ConvertFrom-Json
}
else {
    $null
}

function Resolve-NodePath {
    param([string]$ConfiguredPath)

    if ($ConfiguredPath -and (Test-Path -LiteralPath $ConfiguredPath -PathType Leaf)) {
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

    throw 'Node.js 20 or newer was not found. Install it from https://nodejs.org/ and run the companion installer again.'
}

function Get-EnvironmentNames {
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    [void]$names.Add('AI_PROVIDER')

    $examplePath = Join-Path $companionRoot '.env.example'
    if (Test-Path -LiteralPath $examplePath -PathType Leaf) {
        foreach ($line in Get-Content -LiteralPath $examplePath) {
            if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') {
                [void]$names.Add($Matches[1])
            }
        }
    }

    return @($names)
}

function Import-CompanionEnvironment {
    param([string[]]$Names)

    # Persisted User values are read explicitly because Task Scheduler can keep
    # an environment captured before the user changed provider settings.
    foreach ($name in $Names) {
        $persistedValue = [Environment]::GetEnvironmentVariable($name, 'User')
        if ($null -ne $persistedValue) {
            [Environment]::SetEnvironmentVariable($name, $persistedValue, 'Process')
        }
    }

    # An installation-local .env is the final authority. This makes scheduled
    # startup deterministic and prevents stale machine-wide keys from silently
    # selecting a different provider than the user configured for this mod.
    $environmentPath = Join-Path $companionRoot '.env'
    if (-not (Test-Path -LiteralPath $environmentPath -PathType Leaf)) {
        return
    }

    foreach ($line in Get-Content -LiteralPath $environmentPath) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#') -or -not $trimmed.Contains('=')) {
            continue
        }

        $name, $value = $trimmed.Split('=', 2)
        $name = $name.Trim()
        $value = $value.Trim()
        if ($value.Length -ge 2 -and
            (($value.StartsWith('"') -and $value.EndsWith('"')) -or
             ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        if ($name -match '^[A-Za-z_][A-Za-z0-9_]*$') {
            [Environment]::SetEnvironmentVariable($name, $value, 'Process')
        }
    }
}

function Rotate-CompanionLog {
    param([string]$Path, [long]$MaximumBytes = 10MB, [int]$Copies = 3)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or
        (Get-Item -LiteralPath $Path).Length -lt $MaximumBytes) {
        return
    }

    for ($index = $Copies; $index -ge 1; --$index) {
        $source = if ($index -eq 1) { $Path } else { "$Path.$($index - 1)" }
        $destination = "$Path.$index"
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            Move-Item -LiteralPath $source -Destination $destination -Force
        }
    }
}

$nodePath = Resolve-NodePath -ConfiguredPath $runtime.node_path
$versionText = (& $nodePath --version).Trim()
if ($versionText -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) {
    throw "AI Factory Copilot requires Node.js 20 or newer; found '$versionText' at '$nodePath'."
}

Import-CompanionEnvironment -Names (Get-EnvironmentNames)
if ($runtime.port) {
    $env:AIFACTORY_PORT = [string]$runtime.port
}

if (-not $env:AI_PROVIDER) {
    if ($env:ANTHROPIC_API_KEY -and $env:ANTHROPIC_MODEL) {
        $env:AI_PROVIDER = 'anthropic'
    }
    elseif ($env:OPENAI_API_KEY) {
        $env:AI_PROVIDER = 'openai'
    }
    elseif ($env:LOCAL_AI_MODEL) {
        $env:AI_PROVIDER = 'local'
    }
    else {
        $env:AI_PROVIDER = 'mock'
    }
}

if ($env:AI_PROVIDER -eq 'openai' -and -not $env:OPENAI_MODEL) {
    $env:OPENAI_MODEL = 'gpt-5.6-sol'
}
if ($env:AI_PROVIDER -eq 'openai' -and -not $env:OPENAI_WEB_SEARCH) {
    $env:OPENAI_WEB_SEARCH = 'true'
}

Rotate-CompanionLog -Path $logPath

Push-Location $companionRoot
try {
    & $nodePath (Join-Path $companionRoot 'server.mjs') *>> $logPath
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
