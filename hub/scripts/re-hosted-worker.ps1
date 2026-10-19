param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
try {
  $root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
  $base = Join-Path $root 'state\local-game-re\models'
  $requestFile = [IO.Path]::GetFullPath($RequestPath)
  if (-not $requestFile.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase) -or $requestFile -notmatch 'claude-[a-f0-9-]{36}\.request\.json$') { throw 'Invalid fixed RE request path' }
  for ($current = $requestFile; $current -and $current.StartsWith($root, [StringComparison]::OrdinalIgnoreCase); $current = [IO.Path]::GetDirectoryName($current)) {
    $item = Get-Item -LiteralPath $current -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'RE files require literal project storage' }
  }
  $requestItem = Get-Item -LiteralPath $requestFile
  if ($requestItem.PSIsContainer -or $requestItem.Length -gt 32768) { throw 'Invalid bounded RE request' }
  $request = [IO.File]::ReadAllText($requestFile) | ConvertFrom-Json
  # The existing project policy is read before touching the encrypted key store.
  $policy = [IO.File]::ReadAllText((Join-Path $root 'settings\reverse-engineering.json')) | ConvertFrom-Json
  if ($request.purpose -ne 'reverse-engineering' -or $policy.schema -ne 'copilot.re-policy/v1' -or $policy.purpose -ne 'reverse-engineering' -or $policy.hostedModelsAllowed -ne $true -or $null -ne $policy.maxCostUsd -or $policy.gameRequestsPaidFallback -ne $false -or $policy.automaticPromptPolling -ne $false) { throw 'Hosted usage is authorized only for reverse-engineering' }
  if ($request.schema -ne 'copilot.re-hosted-request/v1' -or $request.root -ne $root -or $request.runId -notmatch '^[a-z0-9][a-z0-9_-]{0,79}$' -or [IO.Path]::GetDirectoryName($requestFile) -ne (Join-Path $base $request.runId) -or $request.prompt.Length -gt 8000 -or $request.maxOutputTokens -lt 1 -or $request.maxOutputTokens -gt 16384 -or $request.timeoutMs -lt 1 -or $request.timeoutMs -gt $policy.phaseTimeoutMs) { throw 'Invalid RE worker request' }
  $env:PSModulePath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules') + ';' + (Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules')
  . (Join-Path $root 'runtime\agent-pair\deliverables\claude-key-entry\read-anthropic-key.ps1')
  $secret = Get-AgentPairAnthropicKey
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
  try {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = Join-Path $root 'runtime\node\node.exe'
    $start.Arguments = '"' + (Join-Path $root 'scripts\re-hosted-worker.mjs') + '" "' + $requestFile + '"'
    $start.WorkingDirectory = $root
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    foreach ($name in @($start.EnvironmentVariables.Keys)) {
      if ($name -match '(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|CREDENTIAL)|^ANTHROPIC_|^NODE_OPTIONS$') { $start.EnvironmentVariables.Remove($name) }
    }
    $start.EnvironmentVariables['ANTHROPIC_API_KEY'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $process = [Diagnostics.Process]::Start($start)
    $start.EnvironmentVariables.Remove('ANTHROPIC_API_KEY')
  } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secret.Dispose() }
  $process.WaitForExit()
  exit $process.ExitCode
} catch { [Console]::Error.WriteLine('RE secure hosted worker failed before a complete receipt.'); exit 1 }
