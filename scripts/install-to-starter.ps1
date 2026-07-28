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
    Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
}

Write-Host "Installed AI Factory Copilot source to '$destination'."
Write-Host "Open FactoryGame.uproject with 5.6.1-CSS and package through Alpakit."
