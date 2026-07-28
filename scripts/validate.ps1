[CmdletBinding()]
param(
    [string]$StarterProjectPath = $env:AIFACTORY_STARTER_PROJECT
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$descriptorPath = Join-Path $root 'AIFactoryCopilot.uplugin'
$descriptor = Get-Content -Raw -LiteralPath $descriptorPath | ConvertFrom-Json
if ($descriptor.SemVersion -ne '0.3.0') {
    throw "Unexpected plugin SemVersion '$($descriptor.SemVersion)'."
}
if ($descriptor.GameVersion -ne '>=491125') {
    throw "Unexpected FactoryGame range '$($descriptor.GameVersion)'."
}
$smlDependency = $descriptor.Plugins | Where-Object Name -eq 'SML'
if (-not $smlDependency -or $smlDependency.SemVersion -ne '^3.12.0') {
    throw 'The plugin must depend on SML ^3.12.0.'
}

$requiredFiles = @(
    'Source\AIFactoryCopilot\AIFactoryCopilot.Build.cs',
    'Source\AIFactoryCopilot\Public\AIFactoryGameWorldModule.h',
    'Source\AIFactoryCopilot\Public\AIFactorySubsystem.h',
    'Source\AIFactoryCopilot\Public\AIFactoryDataProvider.h',
    'Source\AIFactoryCopilot\Private\AIFactorySnapshot.cpp',
    'Config\Alpakit.ini',
    'companion\server.mjs',
    'companion\lib\graph.mjs',
    'companion\lib\solvers.mjs',
    'companion\lib\tools.mjs',
    'companion\lib\sources.mjs',
    'scripts\package-local.ps1',
    'scripts\run-companion.ps1'
)
foreach ($relative in $requiredFiles) {
    $path = Join-Path $root $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required file is missing: $relative"
    }
}

$referenceCandidates = @(
    $StarterProjectPath,
    (Join-Path $root '.upstream\SatisfactoryModLoader'),
    'D:\Modding\Satisfactory\StarterProject'
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) }
$upstream = $referenceCandidates | Select-Object -First 1
if ($upstream) {
    $checks = @(
        @{ Path = 'Mods\SML\SML.uplugin'; Pattern = '"SemVersion": "3.12.0"' },
        @{ Path = 'Source\FactoryGame\currentVersion.txt'; Pattern = '491125' },
        @{ Path = 'Mods\SML\Source\SML\Public\Module\GameWorldModule.h'; Pattern = 'class SML_API UGameWorldModule' },
        @{ Path = 'Mods\SML\Source\SML\Public\Registry\ModContentRegistry.h'; Pattern = 'GetRegisteredRecipes' },
        @{ Path = 'Source\FactoryGame\Public\Buildables\FGBuildableManufacturer.h'; Pattern = 'GetCurrentRecipe' },
        @{ Path = 'Source\FactoryGame\Public\FGFactoryConnectionComponent.h'; Pattern = 'GetConnection' },
        @{ Path = 'Source\FactoryGame\Public\FGSchematicManager.h'; Pattern = 'GetAllPurchasedSchematics' },
        @{ Path = 'Source\FactoryGame\Public\FGRecipeManager.h'; Pattern = 'IsRecipeAvailable' },
        @{ Path = 'Source\FactoryGame\Public\FGRecipeManager.h'; Pattern = 'IsBuildingAvailable' },
        @{ Path = 'Source\FactoryGame\Public\FGInventoryComponent.h'; Pattern = 'HasItems' },
        @{ Path = 'Source\FactoryGame\Public\FGInventoryComponent.h'; Pattern = 'GetNoBuildCost' },
        @{ Path = 'Source\FactoryGame\Public\FGDismantleInterface.h'; Pattern = 'DropRefundOnGroundNoActor' },
        @{ Path = 'Source\FactoryGame\Public\FGPowerCircuit.h'; Pattern = 'GetPowerProductionCapacity' },
        @{ Path = 'Source\FactoryGame\Public\Buildables\FGBuildableConveyorBase.h'; Pattern = 'ITEM_SPACING' },
        @{ Path = 'Source\FactoryGame\Public\Buildables\FGBuildableResourceExtractor.h'; Pattern = 'GetExtractionPerMinute' },
        @{ Path = 'Source\FactoryGame\Public\Buildables\FGBuildableResourceExtractor.h'; Pattern = 'GetNumExtractedItemsPerCycleConverted' },
        @{ Path = 'Source\FactoryGame\Public\Buildables\FGBuildableResourceExtractorBase.h'; Pattern = 'GetResourceNode' },
        @{ Path = 'Source\FactoryGame\Public\FGVehicle.h'; Pattern = 'class FACTORYGAME_API AFGVehicle' }
    )
    foreach ($check in $checks) {
        $path = Join-Path $upstream $check.Path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Reference header missing: $($check.Path)"
        }
        if (-not (Select-String -LiteralPath $path -Pattern $check.Pattern -Quiet)) {
            throw "Reference API '$($check.Pattern)' missing from $($check.Path)"
        }
    }
    Write-Host 'SML 3.12.0 and FactoryGame 491125 header compatibility checks passed.'
}
else {
    Write-Warning 'Exact Starter Project headers are absent; skipping SML/FactoryGame symbol checks.'
}

Push-Location (Join-Path $root 'companion')
try {
    & node --test
    if ($LASTEXITCODE -ne 0) {
        throw "Companion tests failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

Write-Host 'AI Factory Copilot source validation passed.'
