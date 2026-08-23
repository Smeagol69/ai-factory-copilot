[CmdletBinding()]
param(
    [string]$StarterProjectPath = $env:AIFACTORY_STARTER_PROJECT,
    [string]$GamePath = $env:AIFACTORY_GAME_PATH
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $StarterProjectPath) {
    $StarterProjectPath = 'D:\Modding\Satisfactory\StarterProject-502094'
}

$descriptorPath = Join-Path $root 'AIFactoryCopilot.uplugin'
$descriptor = Get-Content -Raw -LiteralPath $descriptorPath | ConvertFrom-Json
$packagePath = Join-Path $root 'companion\package.json'
$package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
$semVersion = [string]$descriptor.SemVersion
if ($semVersion -notmatch '^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$') {
    throw "Plugin SemVersion '$semVersion' is not a supported semantic version."
}
$semanticMajor = [int]$Matches[1]
if ([int]$descriptor.Version -ne $semanticMajor) {
    throw "Plugin Version '$($descriptor.Version)' must equal SemVersion major '$semanticMajor'."
}
if ([string]$descriptor.VersionName -ne $semVersion) {
    throw "Plugin VersionName '$($descriptor.VersionName)' must exactly equal SemVersion '$semVersion'."
}
if ([string]$package.version -ne $semVersion) {
    throw "Companion version '$($package.version)' must exactly equal plugin SemVersion '$semVersion'."
}
$isPrerelease = $semVersion.Contains('-')
if ([bool]$descriptor.IsBetaVersion -ne $isPrerelease) {
    throw "IsBetaVersion must be true exactly when SemVersion '$semVersion' is a prerelease."
}
foreach ($urlField in @('CreatedByURL', 'DocsURL', 'SupportURL')) {
    $url = [string]$descriptor.$urlField
    if ($url -notmatch '^https://github\.com/Smeagol69/ai-factory-copilot(?:$|[/#])') {
        throw "$urlField must point to the AI Factory Copilot GitHub project, found '$url'."
    }
}
$gameVersionMatch = [regex]::Match([string]$descriptor.GameVersion, '^>=(\d+)$')
if (-not $gameVersionMatch.Success) {
    throw "GameVersion '$($descriptor.GameVersion)' must be an explicit minimum FactoryGame changelist."
}
$expectedGameChangelist = $gameVersionMatch.Groups[1].Value
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
    'Resources\Icon128.png',
    'companion\server.mjs',
    'companion\package-lock.json',
    'companion\lib\blueprints.mjs',
    'companion\lib\graph.mjs',
    'companion\lib\solvers.mjs',
    'companion\lib\tools.mjs',
    'companion\lib\sources.mjs',
    'scripts\package-local.ps1',
    'scripts\package-release.ps1',
    'scripts\install-companion.ps1',
    'scripts\configure-companion.ps1',
    'scripts\run-companion.ps1',
    'CHANGELOG.md',
    'LICENSE'
)
foreach ($relative in $requiredFiles) {
    $path = Join-Path $root $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required file is missing: $relative"
    }
}

$iconPath = Join-Path $root 'Resources\Icon128.png'
$iconBytes = [IO.File]::ReadAllBytes($iconPath)
if ($iconBytes.Length -lt 24 -or
    $iconBytes[0] -ne 0x89 -or
    $iconBytes[1] -ne 0x50 -or
    $iconBytes[2] -ne 0x4e -or
    $iconBytes[3] -ne 0x47) {
    throw 'Resources\Icon128.png is not a valid PNG.'
}
$iconWidth = [BitConverter]::ToUInt32([byte[]]@(
    $iconBytes[19], $iconBytes[18], $iconBytes[17], $iconBytes[16]), 0)
$iconHeight = [BitConverter]::ToUInt32([byte[]]@(
    $iconBytes[23], $iconBytes[22], $iconBytes[21], $iconBytes[20]), 0)
if ($iconWidth -ne 128 -or $iconHeight -ne 128) {
    throw "Resources\Icon128.png must be 128x128, but is ${iconWidth}x${iconHeight}."
}

$referenceCandidates = @(
    $StarterProjectPath,
    (Join-Path $root '.upstream\SatisfactoryModLoader'),
    'D:\Modding\Satisfactory\StarterProject'
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) }
$upstream = $referenceCandidates | Select-Object -First 1
if ($upstream) {
    $starterVersionPath = Join-Path $upstream 'Source\FactoryGame\currentVersion.txt'
    $starterChangelist = (Get-Content -Raw -LiteralPath $starterVersionPath).Trim()
    if ($starterChangelist -ne $expectedGameChangelist) {
        throw "Starter Project FactoryGame CL '$starterChangelist' does not match this mod's GameVersion '$($descriptor.GameVersion)'."
    }
    $checks = @(
        @{ Path = 'Mods\SML\SML.uplugin'; Pattern = '"SemVersion": "3.12.0"' },
        @{ Path = 'Mods\SML\Source\SML\Public\Module\GameWorldModule.h'; Pattern = 'class SML_API UGameWorldModule' },
        @{ Path = 'Mods\SML\Source\SML\Public\Registry\ModContentRegistry.h'; Pattern = 'GetRegisteredRecipes' },
        @{ Path = 'Source\FactoryGame\Public\Buildables\FGBuildableManufacturer.h'; Pattern = 'GetCurrentRecipe' },
        @{ Path = 'Source\FactoryGame\Public\Buildables\FGBuildableManufacturer.h'; Pattern = 'void SetRecipe' },
        @{ Path = 'Source\FactoryGame\Public\Buildables\FGBuildableManufacturer.h'; Pattern = 'GetAvailableRecipes' },
        @{ Path = 'Source\FactoryGame\Public\Buildables\FGBuildable.h'; Pattern = 'FBox GetCachedBounds' },
        @{ Path = 'Source\FactoryGame\Public\FGLightweightBuildableSubsystem.h'; Pattern = 'GetAllLightweightBuildableInstances' },
        @{ Path = 'Source\FactoryGame\Public\FGRecipe.h'; Pattern = 'static bool IsProducedIn' },
        @{ Path = 'Source\FactoryGame\Public\FGFactoryConnectionComponent.h'; Pattern = 'GetConnection' },
        @{ Path = 'Source\FactoryGame\Public\FGSchematicManager.h'; Pattern = 'GetAllPurchasedSchematics' },
        @{ Path = 'Source\FactoryGame\Public\FGSchematicManager.h'; Pattern = 'GetActiveSchematic' },
        @{ Path = 'Source\FactoryGame\Public\FGRecipeManager.h'; Pattern = 'IsRecipeAvailable' },
        @{ Path = 'Source\FactoryGame\Public\FGRecipeManager.h'; Pattern = 'IsItemDescriptorAvailable' },
        @{ Path = 'Source\FactoryGame\Public\FGRecipeManager.h'; Pattern = 'IsBuildingAvailable' },
        @{ Path = 'Source\FactoryGame\Public\FGTutorialIntroManager.h'; Pattern = 'GetCurrentOnboardingStep' },
        @{ Path = 'Source\FactoryGame\Public\FGOnboardingStep.h'; Pattern = 'TArray< FText > Objectives' },
        @{ Path = 'Source\FactoryGame\Public\FGGamePhaseManager.h'; Pattern = 'GetCurrentGamePhase' },
        @{ Path = 'Source\FactoryGame\Public\FGPlayerState.h'; Pattern = 'GetPrivateTodoList' },
        @{ Path = 'Source\FactoryGame\Public\FGInventoryComponent.h'; Pattern = 'HasItems' },
        @{ Path = 'Source\FactoryGame\Public\FGInventoryComponent.h'; Pattern = 'GetNoBuildCost' },
        @{ Path = 'Source\FactoryGame\Public\FGInventoryComponent.h'; Pattern = 'bool IsEmpty' },
        @{ Path = 'Source\FactoryGame\Public\FGDismantleInterface.h'; Pattern = 'DropRefundOnGroundNoActor' },
        @{ Path = 'Source\FactoryGame\Public\Hologram\FGHologram.h'; Pattern = 'SpawnHologramFromRecipe' },
        @{ Path = 'Source\FactoryGame\Public\Hologram\FGHologram.h'; Pattern = 'ValidatePlacementAndCost' },
        @{ Path = 'Source\FactoryGame\Public\Hologram\FGHologram.h'; Pattern = 'GetConstructDisqualifiers' },
        @{ Path = 'Source\FactoryGame\Public\Hologram\FGBlueprintHologram.h'; Pattern = 'SetBlueprintDescriptor' },
        @{ Path = 'Source\FactoryGame\Public\Equipment\FGBuildGun.h'; Pattern = 'void GotoBuildState' },
        @{ Path = 'Source\FactoryGame\Public\Equipment\FGBuildGun.h'; Pattern = 'void SetDesiredBlueprint' },
        @{ Path = 'Source\FactoryGame\Public\FGRemoteCallObject.h'; Pattern = 'GetOwnerPlayerCharacter' },
        @{ Path = 'Mods\SML\Source\SML\Public\Module\GameInstanceModule.h'; Pattern = 'TArray<TSubclassOf<class UFGRemoteCallObject>> RemoteCallObjects' },
        @{ Path = 'Source\FactoryGame\Public\FGBlueprintSettings.h'; Pattern = 'mBlueprintRecipeClass' },
        @{ Path = 'Source\FactoryGame\Public\FGBlueprintProxy.h'; Pattern = 'CollectBuildables' },
        @{ Path = 'Source\FactoryGame\Public\FGBuildableSubsystem.h'; Pattern = 'GetNewNetConstructionID' },
        @{ Path = 'Source\FactoryGame\Public\FGPowerCircuit.h'; Pattern = 'GetPowerProductionCapacity' },
        @{ Path = 'Source\FactoryGame\Public\Buildables\FGBuildableConveyorBase.h'; Pattern = 'ITEM_SPACING' },
        @{ Path = 'Source\FactoryGame\Public\Buildables\FGBuildableResourceExtractor.h'; Pattern = 'GetExtractionPerMinute' },
        @{ Path = 'Source\FactoryGame\Public\Buildables\FGBuildableResourceExtractor.h'; Pattern = 'GetNumExtractedItemsPerCycleConverted' },
        @{ Path = 'Source\FactoryGame\Public\Buildables\FGBuildableResourceExtractorBase.h'; Pattern = 'GetResourceNode' },
        @{ Path = 'Source\FactoryGame\Public\FGVehicle.h'; Pattern = 'class FACTORYGAME_API AFGVehicle' }
        @{ Path = '..\UnrealEngine-CSS\Engine\Source\Runtime\Engine\Classes\GameFramework\PlayerController.h'; Pattern = 'struct FInputModeUIOnly' }
        @{ Path = '..\UnrealEngine-CSS\Engine\Source\Runtime\Engine\Classes\GameFramework\Controller.h'; Pattern = 'SetIgnoreMoveInput' }
        @{ Path = '..\UnrealEngine-CSS\Engine\Source\Runtime\Slate\Public\Framework\Application\SlateApplication.h'; Pattern = 'SetAllUserFocus' }
        @{ Path = '..\UnrealEngine-CSS\Engine\Source\Runtime\UMG\Public\Blueprint\WidgetBlueprintLibrary.h'; Pattern = 'GetAllWidgetsOfClass' }
        @{ Path = '..\UnrealEngine-CSS\Engine\Source\Runtime\UMG\Public\Blueprint\WidgetTree.h'; Pattern = 'GetAllWidgets' }
        @{ Path = '..\UnrealEngine-CSS\Engine\Source\Runtime\UMG\Public\Components\TextBlock.h'; Pattern = 'FText GetText' }
        @{ Path = '..\UnrealEngine-CSS\Engine\Source\Runtime\Core\Public\Math\Transform.h'; Pattern = 'GetTypeHash\(const TTransform' }
        @{ Path = '..\UnrealEngine-CSS\Engine\Source\Runtime\Json\Public\Dom\JsonObject.h'; Pattern = 'TryGetNumberField\(FStringView FieldName, int32& OutNumber\)' }
        @{ Path = '..\UnrealEngine-CSS\Engine\Source\Runtime\Engine\Classes\Components\LineBatchComponent.h'; Pattern = 'void DrawLines\(TArrayView<FBatchedLine> InLines\)' }
        @{ Path = '..\UnrealEngine-CSS\Engine\Source\Runtime\Engine\Classes\Components\LineBatchComponent.h'; Pattern = 'ClearBatch\(uint32 InBatchID\)' }
        @{ Path = 'Mods\SML\Source\SML\Private\ModLoading\ModLoadingLibrary.cpp'; Pattern = 'Resources/Icon128.png' }
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
    Write-Host "SML 3.12.0 and FactoryGame $expectedGameChangelist header compatibility checks passed."
}
else {
    Write-Warning 'Exact Starter Project headers are absent; skipping SML/FactoryGame symbol checks.'
}

$defaultGamePath = 'D:\SteamLibrary\steamapps\common\Satisfactory'
if ($GamePath) {
    if (-not (Test-Path -LiteralPath $GamePath -PathType Container)) {
        throw "Requested game directory does not exist: $GamePath"
    }
    $gameRoot = (Resolve-Path -LiteralPath $GamePath).Path
}
elseif (Test-Path -LiteralPath $defaultGamePath -PathType Container) {
    $gameRoot = $defaultGamePath
}
else {
    $gameRoot = $null
}
if ($gameRoot) {
    $gameVersionPath = Join-Path $gameRoot 'Engine\Binaries\Win64\FactoryGameSteam-Win64-Shipping.version'
    if (-not (Test-Path -LiteralPath $gameVersionPath -PathType Leaf)) {
        throw "Installed-game version manifest is missing: $gameVersionPath"
    }
    $gameVersion = Get-Content -Raw -LiteralPath $gameVersionPath | ConvertFrom-Json
    $gameChangelist = [string]$gameVersion.Changelist
    if ($gameChangelist -ne $expectedGameChangelist) {
        throw "Installed Satisfactory CL '$gameChangelist' does not match this mod's GameVersion '$($descriptor.GameVersion)'. Update the Starter Project and rebuild before packaging."
    }
    Write-Host "Installed Satisfactory CL $gameChangelist matches the mod and Starter Project target."
}

Push-Location (Join-Path $root 'companion')
try {
    $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
    if (-not $nodeCommand) {
        throw 'Node.js 20 or newer is required to validate the companion dependency lockfile.'
    }
    $nodeVersion = (& $nodeCommand.Source --version).Trim()
    if ($nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) {
        throw "AI Factory Copilot requires Node.js 20 or newer; found '$nodeVersion' at '$($nodeCommand.Source)'."
    }
    $npmPath = Join-Path (Split-Path -Parent $nodeCommand.Source) 'npm.cmd'
    if (-not (Test-Path -LiteralPath $npmPath -PathType Leaf)) {
        throw "npm.cmd was not found beside Node.js at '$($nodeCommand.Source)'. Install the complete Node.js distribution."
    }
    # Tests exercise a static native-blueprint parser import. Materialise its
    # exact lock-pinned dependency graph first so validation cannot pass only
    # because a developer happened to retain an old node_modules directory.
    & $npmPath ci --ignore-scripts --no-audit --fund=false
    if ($LASTEXITCODE -ne 0) {
        throw "npm ci failed with exit code $LASTEXITCODE while validating the companion."
    }
    & node --test
    if ($LASTEXITCODE -ne 0) {
        throw "Companion tests failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

Write-Host 'AI Factory Copilot source validation passed.'
