[CmdletBinding()]
param(
    [string]$StarterProjectPath = 'D:\Modding\Satisfactory\StarterProject-502094',
    [string]$OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist'),

    # The companion ships inside the mod zip now. This emits the old
    # standalone bundle as well, for running the bridge on another machine.
    [switch]$SeparateCompanionArtifact
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$descriptorPath = Join-Path $root 'AIFactoryCopilot.uplugin'
$descriptor = Get-Content -Raw -LiteralPath $descriptorPath | ConvertFrom-Json
$version = [string]$descriptor.SemVersion
$sourceModArchive = Join-Path $StarterProjectPath 'Saved\ArchivedPlugins\AIFactoryCopilot\AIFactoryCopilot-Windows.zip'

foreach ($requiredPath in @(
    $sourceModArchive,
    (Join-Path $root 'companion\server.mjs'),
    (Join-Path $root 'scripts\install-companion.ps1'),
    (Join-Path $root 'scripts\configure-companion.ps1'),
    (Join-Path $root 'scripts\run-companion.ps1'),
    (Join-Path $root 'docs\INSTALL.md'),
    (Join-Path $root 'LICENSE')
)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Release input is missing: $requiredPath"
    }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$sourceZip = [IO.Compression.ZipFile]::OpenRead($sourceModArchive)
try {
    $pluginEntry = $sourceZip.Entries |
        Where-Object { $_.FullName -match '(^|/)AIFactoryCopilot\.uplugin$' } |
        Select-Object -First 1
    if (-not $pluginEntry) {
        throw "The packaged mod does not contain AIFactoryCopilot.uplugin: $sourceModArchive"
    }
    $reader = [IO.StreamReader]::new($pluginEntry.Open())
    try {
        $packagedDescriptor = $reader.ReadToEnd() | ConvertFrom-Json
    }
    finally {
        $reader.Dispose()
    }
    if ([string]$packagedDescriptor.SemVersion -ne $version) {
        throw "Packaged mod version '$($packagedDescriptor.SemVersion)' does not match source '$version'. Run package-local.ps1 first."
    }
}
finally {
    $sourceZip.Dispose()
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$resolvedOutput = (Resolve-Path -LiteralPath $OutputDirectory).Path
$modArtifact = Join-Path $resolvedOutput "AIFactoryCopilot-$version-Windows.zip"
$companionArtifact = Join-Path $resolvedOutput "AIFactoryCopilot-Companion-$version-Windows.zip"
$checksumsPath = Join-Path $resolvedOutput "SHA256SUMS-$version.txt"
$stageParent = [IO.Path]::GetTempPath()
$stageRoot = Join-Path $stageParent "AIFactoryCopilot-release-$([guid]::NewGuid().ToString('N'))"

try {
    New-Item -ItemType Directory -Path $stageRoot | Out-Null
    foreach ($directory in @('companion', 'scripts', 'docs', 'Config')) {
        New-Item -ItemType Directory -Path (Join-Path $stageRoot $directory) | Out-Null
    }

    Copy-Item -LiteralPath (Join-Path $root 'companion\server.mjs') -Destination (Join-Path $stageRoot 'companion')
    Copy-Item -LiteralPath (Join-Path $root 'companion\package.json') -Destination (Join-Path $stageRoot 'companion')
    Copy-Item -LiteralPath (Join-Path $root 'companion\.env.example') -Destination (Join-Path $stageRoot 'companion')
    Copy-Item -LiteralPath (Join-Path $root 'companion\lib') -Destination (Join-Path $stageRoot 'companion') -Recurse
    foreach ($script in @('install-companion.ps1', 'configure-companion.ps1', 'run-companion.ps1')) {
        Copy-Item -LiteralPath (Join-Path $root "scripts\$script") -Destination (Join-Path $stageRoot 'scripts')
    }
    Copy-Item -LiteralPath (Join-Path $root 'docs\INSTALL.md') -Destination (Join-Path $stageRoot 'docs')
    Copy-Item -LiteralPath (Join-Path $root 'Config\AIFactoryCopilot.cfg') -Destination (Join-Path $stageRoot 'Config')
    foreach ($file in @('README.md', 'CHANGELOG.md', 'LICENSE')) {
        Copy-Item -LiteralPath (Join-Path $root $file) -Destination $stageRoot
    }

    Copy-Item -LiteralPath $sourceModArchive -Destination $modArtifact -Force

    # Refuse to publish a mod zip that does not carry its own bridge. This is
    # the whole point of the single-artifact release, and it is exactly the
    # kind of thing that silently stops working when a Build.cs line is
    # dropped -- the package still builds, and every install is broken.
    $requiredModEntries = @(
        'companion/server.mjs',
        'companion/package.json',
        'companion/lib/narrate.mjs',
        'companion/lib/survey.mjs',
        'companion/data/efficiency.json'
    )
    $modZip = [IO.Compression.ZipFile]::OpenRead($modArtifact)
    try {
        $modEntries = @($modZip.Entries.FullName | ForEach-Object { $_.Replace('\', '/') })
        foreach ($entry in $requiredModEntries) {
            if (-not ($modEntries | Where-Object { $_.EndsWith($entry) })) {
                throw "The mod archive is missing '$entry'. The companion is not bundled; check RuntimeDependencies in AIFactoryCopilot.Build.cs."
            }
        }
        # Entries are relative -- "companion/server.mjs", no leading slash -- so an
        # anchored pattern is required. The first version asked for "/companion/"
        # and reported 0 files for a bundle that was entirely correct.
        $companionFileCount = @($modEntries | Where-Object { $_ -match '(^|/)companion/' }).Count
        Write-Host "Bundled companion: $companionFileCount files inside the mod archive."
    }
    finally {
        $modZip.Dispose()
    }
    if ($SeparateCompanionArtifact) {
        Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $stageRoot -Force).FullName `
            -DestinationPath $companionArtifact -CompressionLevel Optimal -Force
    }

    $expectedCompanionEntries = @(
        'companion/server.mjs',
        'companion/.env.example',
        'scripts/install-companion.ps1',
        'scripts/configure-companion.ps1',
        'docs/INSTALL.md',
        'LICENSE'
    )
    if ($SeparateCompanionArtifact) {
    $companionZip = [IO.Compression.ZipFile]::OpenRead($companionArtifact)
    try {
        $entryNames = @($companionZip.Entries.FullName | ForEach-Object { $_.Replace('\', '/') })
        foreach ($entry in $expectedCompanionEntries) {
            if ($entry -notin $entryNames) {
                throw "Companion release is incomplete; missing '$entry'."
            }
        }
    }
    finally {
        $companionZip.Dispose()
    }
    }

    $produced = @($modArtifact)
    if ($SeparateCompanionArtifact) { $produced += $companionArtifact }
    $produced | ForEach-Object {
        $hash = Get-FileHash -LiteralPath $_ -Algorithm SHA256
        "$($hash.Hash.ToLowerInvariant())  $([IO.Path]::GetFileName($_))"
    } | Set-Content -LiteralPath $checksumsPath -Encoding ascii
}
finally {
    $resolvedStage = [IO.Path]::GetFullPath($stageRoot)
    $temporaryPrefix = [IO.Path]::GetFullPath($stageParent).TrimEnd('\') + '\'
    if ($resolvedStage.StartsWith($temporaryPrefix, [StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $resolvedStage -PathType Container)) {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}

Write-Host ""
Write-Host "Single-file release (mod + bundled companion):"
Write-Host "  $modArtifact"
if ($SeparateCompanionArtifact) {
    Write-Host "Standalone companion (optional, for a second machine):"
    Write-Host "  $companionArtifact"
}
Write-Host "Checksums: $checksumsPath"
