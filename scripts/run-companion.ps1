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

if (-not $env:AI_PROVIDER) {
    if ($env:OPENAI_API_KEY) {
        $env:AI_PROVIDER = 'openai'
    }
    elseif ($env:ANTHROPIC_API_KEY -and $env:ANTHROPIC_MODEL) {
        $env:AI_PROVIDER = 'anthropic'
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
