$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\..\..\runtime\agent-pair\deliverables\claude-key-entry\read-anthropic-key.ps1')
$tunnelSecure=ConvertTo-SecureString ([IO.File]::ReadAllText((Join-Path (Resolve-AgentPairSecretsDirectory) 'google.dpapi')))
try {$env:GEMINI_API_KEY=(New-Object Net.NetworkCredential('', $tunnelSecure)).Password; & node (Join-Path $PSScriptRoot 'review-clarification.mjs')}
finally {Remove-Item Env:GEMINI_API_KEY -ErrorAction SilentlyContinue;$tunnelSecure.Dispose()}
