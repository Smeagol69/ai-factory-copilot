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
$nodePath = 'C:\Program Files\nodejs\node.exe'
$logRoot = Join-Path $companionRoot 'Logs'
$logPath = Join-Path $logRoot 'companion.log'

if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    throw "Node.js was not found at '$nodePath'."
}

New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

# A local .env file is optional. Process/user environment variables win so a
# scheduled task and an interactive launch behave the same without copying
# secrets into the repository.
$environmentPath = Join-Path $companionRoot '.env'
if (Test-Path -LiteralPath $environmentPath -PathType Leaf) {
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
        if ($name -match '^[A-Za-z_][A-Za-z0-9_]*$' -and
            -not [Environment]::GetEnvironmentVariable($name, 'Process')) {
            [Environment]::SetEnvironmentVariable($name, $value, 'Process')
        }
    }
}

if (-not $env:AI_PROVIDER) {
    if ($env:ANTHROPIC_API_KEY -and $env:ANTHROPIC_MODEL) {
        $env:AI_PROVIDER = 'anthropic'
    }
    elseif ($env:OPENAI_API_KEY) {
        $env:AI_PROVIDER = 'openai'
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

Push-Location $companionRoot
try {
    & $nodePath (Join-Path $companionRoot 'server.mjs') *>> $logPath
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
