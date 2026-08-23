[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$StarterProjectPath,

    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$sourceRoot = Split-Path -Parent $PSScriptRoot
$resolvedStarter = (Resolve-Path -LiteralPath $StarterProjectPath).Path
$uprojectPath = Join-Path $resolvedStarter 'FactoryGame.uproject'
if (-not (Test-Path -LiteralPath $uprojectPath -PathType Leaf)) {
    throw "FactoryGame.uproject was not found at '$resolvedStarter'."
}

$uproject = Get-Content -Raw -LiteralPath $uprojectPath | ConvertFrom-Json
if ($uproject.EngineAssociation -ne '5.6.1-CSS') {
    throw "Expected EngineAssociation 5.6.1-CSS, found '$($uproject.EngineAssociation)'."
}

$smlDescriptor = Join-Path $resolvedStarter 'Mods\SML\SML.uplugin'
if (-not (Test-Path -LiteralPath $smlDescriptor -PathType Leaf)) {
    throw "The official SML plugin was not found at '$smlDescriptor'."
}
$sml = Get-Content -Raw -LiteralPath $smlDescriptor | ConvertFrom-Json
if ($sml.SemVersion -ne '3.12.0') {
    throw "This source targets SML 3.12.0, but the Starter Project has '$($sml.SemVersion)'."
}

$destination = Join-Path $resolvedStarter 'Mods\AIFactoryCopilot'
if (Test-Path -LiteralPath $destination) {
    if (-not $Force) {
        throw "Destination '$destination' exists. Re-run with -Force only if it is safe to replace."
    }
    $resolvedDestination = (Resolve-Path -LiteralPath $destination).Path
    $resolvedMods = (Resolve-Path -LiteralPath (Join-Path $resolvedStarter 'Mods')).Path
    if (-not $resolvedDestination.StartsWith($resolvedMods, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to replace a destination outside the Starter Project Mods directory."
    }
    Remove-Item -LiteralPath $resolvedDestination -Recurse -Force
}

New-Item -ItemType Directory -Path $destination | Out-Null
$included = @(
    'AIFactoryCopilot.uplugin',
    'Source',
    'Config',
    'Resources',
    'README.md',
    'docs',
    'companion'
)
foreach ($name in $included) {
    $source = Join-Path $sourceRoot $name
    if ($name -ne 'companion') {
        Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
        continue
    }

    # The companion's lockfile belongs in the packaged plugin, but a local
    # developer's node_modules never does. Runtime installation materialises the
    # exact lock-pinned graph below; copying local dependencies here would make
    # archives depend on whichever machine last ran npm.
    $companionDestination = Join-Path $destination 'companion'
    New-Item -ItemType Directory -Path $companionDestination -Force | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $source -Force | Where-Object { $_.Name -ne 'node_modules' }) {
        Copy-Item -LiteralPath $item.FullName -Destination $companionDestination -Recurse -Force
    }
}

# The game auto-starts the companion from the packaged mod, so UAT needs a real
# production dependency tree in the Starter Project. Materialise it only after
# copying clean source: it is reproducible from package-lock.json and never
# inherits an arbitrary repository node_modules directory.
$nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw 'Node.js 20 or newer is required to stage the bundled companion dependencies.'
}
$nodeVersion = (& $nodeCommand.Source --version).Trim()
if ($nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) {
    throw "AI Factory Copilot requires Node.js 20 or newer to stage the bundled companion; found '$nodeVersion' at '$($nodeCommand.Source)'."
}
$npmPath = Join-Path (Split-Path -Parent $nodeCommand.Source) 'npm.cmd'
if (-not (Test-Path -LiteralPath $npmPath -PathType Leaf)) {
    throw "npm.cmd was not found beside Node.js at '$($nodeCommand.Source)'. Install the complete Node.js distribution."
}
$companionDestination = Join-Path $destination 'companion'
Push-Location $companionDestination
try {
    & $npmPath ci --omit=dev --ignore-scripts --no-audit --fund=false
    if ($LASTEXITCODE -ne 0) {
        throw "npm ci failed with exit code $LASTEXITCODE while staging the bundled companion."
    }
}
finally {
    Pop-Location
}
$parserEntry = Join-Path $companionDestination 'node_modules\@etothepii\satisfactory-file-parser\build\index.js'
if (-not (Test-Path -LiteralPath $parserEntry -PathType Leaf)) {
    throw "The bundled companion dependency was not materialised: $parserEntry"
}

Write-Host "Installed AI Factory Copilot source to '$destination'."
Write-Host "Open FactoryGame.uproject with 5.6.1-CSS and package through Alpakit."
