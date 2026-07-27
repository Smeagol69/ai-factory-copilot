[CmdletBinding()]
param(
    [string]$EngineRoot = 'D:\Modding\Satisfactory\UnrealEngine-CSS',
    [string]$StarterProjectPath = 'D:\Modding\Satisfactory\StarterProject',
    [string]$GamePath = 'D:\SteamLibrary\steamapps\common\Satisfactory'
)

$ErrorActionPreference = 'Stop'

$runUat = Join-Path $EngineRoot 'Engine\Build\BatchFiles\RunUAT.bat'
$build = Join-Path $EngineRoot 'Engine\Build\BatchFiles\Build.bat'
$uproject = Join-Path $StarterProjectPath 'FactoryGame.uproject'
$plugin = Join-Path $StarterProjectPath 'Mods\AIFactoryCopilot\AIFactoryCopilot.uplugin'
$gameMods = Join-Path $GamePath 'FactoryGame\Mods'

foreach ($requiredPath in @($runUat, $build, $uproject, $plugin, $gameMods)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required packaging path is missing: $requiredPath"
    }
}

# A clean source install has no editor module binary. PackagePlugin cooks through
# UnrealEditor-Cmd, so build the official FactoryEditor target before invoking
# UAT even though the packaged runtime target is FactoryGameSteam Shipping.
& $build FactoryEditor Win64 Development "-Project=$uproject" -WaitMutex -MaxParallelActions=2
if ($LASTEXITCODE -ne 0) {
    throw "FactoryEditor build failed with exit code $LASTEXITCODE."
}

$arguments = @(
    "-ScriptsForProject=$uproject",
    'PackagePlugin',
    "-project=$uproject",
    '-clientconfig=Shipping',
    '-serverconfig=Shipping',
    '-utf8output',
    '-DLCName=AIFactoryCopilot',
    '-build',
    '-platform=Win64',
    '-Target=FactoryGameSteam',
    '-ubtargs=-MaxParallelActions=2',
    '-nocompileeditor',
    '-installed',
    "-CopyToGameDirectory_Windows=$GamePath"
)

& $runUat @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Alpakit/UAT packaging failed with exit code $LASTEXITCODE."
}

$installedDescriptor = Join-Path $gameMods 'AIFactoryCopilot\AIFactoryCopilot.uplugin'
$archive = Join-Path $StarterProjectPath 'Saved\ArchivedPlugins\AIFactoryCopilot\AIFactoryCopilot-Windows.zip'
if (-not (Test-Path -LiteralPath $installedDescriptor -PathType Leaf)) {
    throw "Packaging completed but the game copy is missing: $installedDescriptor"
}
if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
    throw "Packaging completed but the archive is missing: $archive"
}

Write-Host "Packaged archive: $archive"
Write-Host "Installed game mod: $installedDescriptor"
