$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\..\..\runtime\agent-pair\deliverables\claude-key-entry\read-anthropic-key.ps1')
$tunnelSecret=Join-Path (Resolve-AgentPairSecretsDirectory) 'google.dpapi'
$tunnelItem=Get-Item -LiteralPath $tunnelSecret -Force
if($tunnelItem.PSIsContainer -or ($tunnelItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $tunnelItem.Length -gt 32768){throw 'Invalid credential file'}
$tunnelSecure=ConvertTo-SecureString ([IO.File]::ReadAllText($tunnelSecret))
try {
 $env:GEMINI_API_KEY=(New-Object Net.NetworkCredential('', $tunnelSecure)).Password
 & node (Join-Path $PSScriptRoot 'review.mjs')
} finally { Remove-Item Env:GEMINI_API_KEY -ErrorAction SilentlyContinue; $tunnelSecure.Dispose() }
