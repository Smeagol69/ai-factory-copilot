[CmdletBinding()]
param(
    [string]$EngineRoot = 'D:\Modding\Satisfactory\UnrealEngine-CSS',
    [string]$StarterProjectPath = 'D:\Modding\Satisfactory\StarterProject-502094',
    [string]$GamePath = 'D:\SteamLibrary\steamapps\common\Satisfactory',
    [switch]$StageOnly
)

$ErrorActionPreference = 'Stop'

$runUat = Join-Path $EngineRoot 'Engine\Build\BatchFiles\RunUAT.bat'
$build = Join-Path $EngineRoot 'Engine\Build\BatchFiles\Build.bat'
$uproject = Join-Path $StarterProjectPath 'FactoryGame.uproject'
$plugin = Join-Path $StarterProjectPath 'Mods\AIFactoryCopilot\AIFactoryCopilot.uplugin'
$gameMods = Join-Path $GamePath 'FactoryGame\Mods'
$sourceDescriptorPath = Join-Path $PSScriptRoot '..\AIFactoryCopilot.uplugin'
$starterVersionPath = Join-Path $StarterProjectPath 'Source\FactoryGame\currentVersion.txt'
$gameVersionPath = Join-Path $GamePath 'Engine\Binaries\Win64\FactoryGameSteam-Win64-Shipping.version'

foreach ($requiredPath in @($runUat, $build, $uproject, $plugin, $gameMods, $sourceDescriptorPath, $starterVersionPath, $gameVersionPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required packaging path is missing: $requiredPath"
    }
}

$sourceDescriptor = Get-Content -Raw -LiteralPath $sourceDescriptorPath | ConvertFrom-Json
$starterChangelist = (Get-Content -Raw -LiteralPath $starterVersionPath).Trim()
$gameVersion = Get-Content -Raw -LiteralPath $gameVersionPath | ConvertFrom-Json
$gameChangelist = [string]$gameVersion.Changelist
if ($starterChangelist -notmatch '^\d+$' -or -not $gameChangelist) {
    throw "Unable to determine matching FactoryGame changelists from '$starterVersionPath' and '$gameVersionPath'."
}
if ($starterChangelist -ne $gameChangelist) {
    throw "Refusing to package with Starter Project CL $starterChangelist against installed Satisfactory CL $gameChangelist. Update or select the matching Starter Project first."
}
if ([string]$sourceDescriptor.GameVersion -ne ">=$gameChangelist") {
    throw "Refusing to package: source GameVersion '$($sourceDescriptor.GameVersion)' does not exactly target installed Satisfactory CL $gameChangelist."
}

$runningGame = Get-Process -Name 'FactoryGameSteam-Win64-Shipping' -ErrorAction SilentlyContinue
if ($runningGame -and -not $StageOnly) {
    throw "Satisfactory is running (PID $($runningGame.Id -join ', ')). Close it before packaging so the deployed DLL can be replaced safely."
}

$packageStartedAt = Get-Date

function Assert-NativeBaseRestoreBinary([string]$DllPath) {
    if (-not (Test-Path -LiteralPath $DllPath -PathType Leaf)) {
        throw "Native Shipping module is missing: $DllPath"
    }
    $bytes = [IO.File]::ReadAllBytes($DllPath)
    # Check both byte alignments: PE sections need not align each UTF-16 string
    # to the beginning of the file. These literals are used by the native loader,
    # while restore_base alone also exists in chat code without the dispatcher.
    $even = [Text.Encoding]::Unicode.GetString($bytes)
    $odd = [Text.Encoding]::Unicode.GetString($bytes, 1, $bytes.Length - 1)
    foreach ($marker in @('restore_base', 'aifactory.native-base/v1', 'base_restore_requires_no_build_cost_mode')) {
        if (-not ($even.Contains($marker) -or $odd.Contains($marker))) {
            throw "Shipping module lacks native restore marker '$marker': $DllPath. Force a fresh module rebuild; do not deploy this binary."
        }
    }
}

$shippingDllName = 'FactoryGameSteam-AIFactoryCopilot-Win64-Shipping.dll'
$builtShippingDll = Join-Path $StarterProjectPath "Mods\AIFactoryCopilot\Binaries\Win64\$shippingDllName"

# UAT can report a successful metadata-only build while retaining stale native
# objects. Build the runtime target explicitly and check its linked capability
# before allowing UAT's CopyToGameDirectory step to replace the installed mod.
& $build FactoryGameSteam Win64 Shipping "-Project=$uproject" -Module=AIFactoryCopilot -WaitMutex -NoHotReload -NoUBTMakefiles -MaxParallelActions=2
if ($LASTEXITCODE -ne 0) {
    throw "FactoryGameSteam module build failed with exit code $LASTEXITCODE."
}
Assert-NativeBaseRestoreBinary $builtShippingDll

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
    '-installed'
)
if (-not $StageOnly) { $arguments += "-CopyToGameDirectory_Windows=$GamePath" }

& $runUat @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Alpakit/UAT packaging failed with exit code $LASTEXITCODE."
}

$installedDescriptor = Join-Path $gameMods 'AIFactoryCopilot\AIFactoryCopilot.uplugin'
$installedIcon = Join-Path $gameMods 'AIFactoryCopilot\Resources\Icon128.png'
$archive = Join-Path $StarterProjectPath 'Saved\ArchivedPlugins\AIFactoryCopilot\AIFactoryCopilot-Windows.zip'
if (-not $StageOnly -and -not (Test-Path -LiteralPath $installedDescriptor -PathType Leaf)) {
    throw "Packaging completed but the game copy is missing: $installedDescriptor"
}
if (-not $StageOnly -and -not (Test-Path -LiteralPath $installedIcon -PathType Leaf)) {
    throw "Packaging completed but the SML icon is missing: $installedIcon"
}
if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
    throw "Packaging completed but the archive is missing: $archive"
}
$sourceIcon = Join-Path $PSScriptRoot '..\Resources\Icon128.png'
if (-not $StageOnly) {
    $deployedDescriptor = Get-Content -Raw -LiteralPath $installedDescriptor | ConvertFrom-Json
    if ($deployedDescriptor.SemVersion -ne $sourceDescriptor.SemVersion) {
        throw "Deployed version '$($deployedDescriptor.SemVersion)' does not match source version '$($sourceDescriptor.SemVersion)'."
    }
    if ($deployedDescriptor.GameVersion -ne $sourceDescriptor.GameVersion) {
        throw "Deployed game range '$($deployedDescriptor.GameVersion)' does not match source '$($sourceDescriptor.GameVersion)'."
    }
    if ((Get-FileHash -LiteralPath $installedIcon -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $sourceIcon -Algorithm SHA256).Hash) {
        throw 'The deployed SML icon does not match the source icon.'
    }
}
if ((Get-Item -LiteralPath $archive).LastWriteTime -lt $packageStartedAt.AddSeconds(-2)) {
    throw "The packaged archive timestamp was not refreshed by this run: $archive"
}

# The game auto-starts this bundled bridge, so its exact runtime dependencies
# must be in the archive. install-to-starter.ps1 builds the tree from the lock;
# assert the two required packages here rather than trusting a green UAT log.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archiveZip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    Assert-NativeBaseRestoreBinary $builtShippingDll
    $builtDllHash = (Get-FileHash -LiteralPath $builtShippingDll -Algorithm SHA256).Hash
    if (-not $StageOnly) {
        $deployedDll = Join-Path $gameMods "AIFactoryCopilot\Binaries\Win64\$shippingDllName"
        Assert-NativeBaseRestoreBinary $deployedDll
        if ((Get-FileHash -LiteralPath $deployedDll -Algorithm SHA256).Hash -ne $builtDllHash) {
            throw 'Deployed Shipping DLL differs from the built module.'
        }
    }
    $dllEntries = @($archiveZip.Entries | Where-Object { $_.FullName.Replace('\', '/').EndsWith("Binaries/Win64/$shippingDllName") })
    if ($dllEntries.Count -ne 1) {
        throw 'Archive must contain exactly one Copilot Shipping DLL.'
    }
    $dllStream = $dllEntries[0].Open()
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $archiveDllHash = [BitConverter]::ToString($sha.ComputeHash($dllStream)).Replace('-', '')
        if ($archiveDllHash -ne $builtDllHash) { throw 'Archived Shipping DLL differs from the built module.' }
    }
    finally { $sha.Dispose(); $dllStream.Dispose() }
    $archiveEntries = @($archiveZip.Entries.FullName | ForEach-Object { $_.Replace('\', '/') })
    if (-not ($archiveEntries | Where-Object { $_.EndsWith('companion/package-lock.json') })) {
        throw "Packaged archive is missing companion/package-lock.json: $archive"
    }
    foreach ($requiredDependency in @(
        'companion/node_modules/@etothepii/satisfactory-file-parser/build/index.js',
        'companion/node_modules/pako/index.js'
    )) {
        if (-not ($archiveEntries | Where-Object { $_.EndsWith($requiredDependency) })) {
            throw "Packaged archive is missing bundled companion dependency '$requiredDependency'. Run install-to-starter.ps1 before packaging."
        }
    }
}
finally {
    $archiveZip.Dispose()
}

Write-Host "Packaged archive: $archive"
if ($StageOnly) { Write-Host 'Archive verified; game installation was not changed.' }
else { Write-Host "Installed game mod $($deployedDescriptor.SemVersion): $installedDescriptor" }
