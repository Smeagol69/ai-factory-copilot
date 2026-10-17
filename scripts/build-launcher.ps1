$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The Windows .NET Framework C# compiler is unavailable.' }
$source = Join-Path $projectRoot 'app\Launcher.cs'
$output = Join-Path $projectRoot 'Copilot.exe'
& $compiler /nologo /target:winexe /optimize+ "/out:$output" /reference:System.Windows.Forms.dll $source
if ($LASTEXITCODE -ne 0) { throw 'Launcher compilation failed.' }
Get-FileHash -LiteralPath $output -Algorithm SHA256 | Select-Object Path, Hash
