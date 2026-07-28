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

$runningGame = Get-Process -Name 'FactoryGameSteam-Win64-Shipping' -ErrorAction SilentlyContinue
if ($runningGame) {
    throw "Satisfactory is running (PID $($runningGame.Id -join ', ')). Close it before packaging so the deployed DLL can be replaced safely."
}

$packageStartedAt = Get-Date

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
$installedIcon = Join-Path $gameMods 'AIFactoryCopilot\Resources\Icon128.png'
$archive = Join-Path $StarterProjectPath 'Saved\ArchivedPlugins\AIFactoryCopilot\AIFactoryCopilot-Windows.zip'
if (-not (Test-Path -LiteralPath $installedDescriptor -PathType Leaf)) {
    throw "Packaging completed but the game copy is missing: $installedDescriptor"
}
if (-not (Test-Path -LiteralPath $installedIcon -PathType Leaf)) {
    throw "Packaging completed but the SML icon is missing: $installedIcon"
}
if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
    throw "Packaging completed but the archive is missing: $archive"
}
$sourceDescriptor = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '..\AIFactoryCopilot.uplugin') | ConvertFrom-Json
$sourceIcon = Join-Path $PSScriptRoot '..\Resources\Icon128.png'
$deployedDescriptor = Get-Content -Raw -LiteralPath $installedDescriptor | ConvertFrom-Json
if ($deployedDescriptor.SemVersion -ne $sourceDescriptor.SemVersion) {
    throw "Deployed version '$($deployedDescriptor.SemVersion)' does not match source version '$($sourceDescriptor.SemVersion)'."
}
if ((Get-FileHash -LiteralPath $installedIcon -Algorithm SHA256).Hash -ne
    (Get-FileHash -LiteralPath $sourceIcon -Algorithm SHA256).Hash) {
    throw 'The deployed SML icon does not match the source icon.'
}
if ((Get-Item -LiteralPath $archive).LastWriteTime -lt $packageStartedAt.AddSeconds(-2)) {
    throw "The packaged archive timestamp was not refreshed by this run: $archive"
}

Write-Host "Packaged archive: $archive"
Write-Host "Installed game mod $($deployedDescriptor.SemVersion): $installedDescriptor"
