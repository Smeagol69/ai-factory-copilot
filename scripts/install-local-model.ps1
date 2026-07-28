<#
.SYNOPSIS
    Sets up a free local model for the copilot bridge, sized for its payload.

.DESCRIPTION
    The bridge can run against any OpenAI-compatible local server. Ollama is the
    default. Two things make a naive setup fail quietly, and this script handles
    both:

    1. **Context length.** A whole-world request is the lean snapshot plus the
       tool schemas plus the system prompt — around 29k tokens on a real save at
       the shipped defaults. Ollama's default context is far smaller, and an
       over-long prompt is *silently truncated* rather than refused, so the model
       answers confidently from a snapshot it only half received. This script
       derives a model with an explicit num_ctx and trims the payload to match.

    2. **Tool calling.** The solvers are tools. A model that cannot call them
       will produce numbers it made up. The default here supports tool calling;
       if you substitute one that does not, set LOCAL_AI_TOOLS=false so the
       bridge labels its numbers unverified instead of passing them off as
       computed.

.EXAMPLE
    ./scripts/install-local-model.ps1
    ./scripts/install-local-model.ps1 -BaseModel 'qwen3:14b' -ContextLength 40960
#>
[CmdletBinding()]
param(
    [string] $BaseModel = 'qwen3:4b',
    [string] $DerivedModel = '',
    [int]    $ContextLength = 32768,
    # Keep the request comfortably inside ContextLength. 30000 characters of
    # snapshot leaves room for the tool schemas, the prompt, and the answer.
    [int]    $LeanMaxCharacters = 30000,
    [int]    $LeanMaxActors = 30,
    [switch] $SkipPull
)

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 wraps a native executable's stderr in ErrorRecords, so
# a tool that writes progress there (ollama does) trips $ErrorActionPreference
# = 'Stop' even when it exits 0. Run native commands through this instead of
# calling them directly, and judge them by their exit code.
function Invoke-Native {
    param([string] $FilePath, [string[]] $Arguments, [string] $What)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $FilePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$What failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        $ErrorActionPreference = $previous
    }
}

if (-not $DerivedModel) {
    # Keep the base model untouched so other tools that use it are unaffected.
    $DerivedModel = ($BaseModel -replace ':', '-') + '-copilot'
}

$ollama = Get-Command ollama -ErrorAction SilentlyContinue
$ollamaPath = if ($ollama) { $ollama.Source } else { Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe' }
if (-not (Test-Path -LiteralPath $ollamaPath -PathType Leaf)) {
    throw "Ollama was not found. Install it from https://ollama.com/download, then re-run this script."
}

$apiRoot = if ($env:LOCAL_AI_BASE_URL) { ($env:LOCAL_AI_BASE_URL -replace '/v1/?$', '') } else { 'http://127.0.0.1:11434' }
try {
    Invoke-RestMethod "$apiRoot/api/tags" -TimeoutSec 5 | Out-Null
}
catch {
    throw "Ollama is installed but not responding at $apiRoot. Start it, then re-run this script."
}

if (-not $SkipPull) {
    Write-Host "Pulling $BaseModel (this is a one-time download)..."
    Invoke-Native -FilePath $ollamaPath -Arguments @('pull', $BaseModel) -What "ollama pull $BaseModel"
}

# Ollama's OpenAI-compatible endpoint has no per-request context parameter, so
# the context length has to be baked into a derived model.
$modelfile = Join-Path ([System.IO.Path]::GetTempPath()) "aifactory-$DerivedModel.Modelfile"
@"
FROM $BaseModel
PARAMETER num_ctx $ContextLength
"@ | Set-Content -LiteralPath $modelfile -Encoding utf8

Write-Host "Creating '$DerivedModel' with num_ctx=$ContextLength..."
Invoke-Native -FilePath $ollamaPath -Arguments @('create', $DerivedModel, '-f', $modelfile) -What "ollama create $DerivedModel"
Remove-Item -LiteralPath $modelfile -Force -ErrorAction SilentlyContinue

# Persist at User scope so the logon task picks it up; run-companion.ps1 reads
# this scope explicitly rather than relying on the environment it inherited.
[Environment]::SetEnvironmentVariable('AI_PROVIDER', 'local', 'User')
[Environment]::SetEnvironmentVariable('LOCAL_AI_MODEL', $DerivedModel, 'User')
[Environment]::SetEnvironmentVariable('AIFACTORY_LEAN_MAX_CHARS', "$LeanMaxCharacters", 'User')
[Environment]::SetEnvironmentVariable('AIFACTORY_LEAN_MAX_ACTORS', "$LeanMaxActors", 'User')

Write-Host ''
Write-Host 'Configured:'
Write-Host "  AI_PROVIDER               = local"
Write-Host "  LOCAL_AI_MODEL            = $DerivedModel"
Write-Host "  AIFACTORY_LEAN_MAX_CHARS  = $LeanMaxCharacters"
Write-Host "  AIFACTORY_LEAN_MAX_ACTORS = $LeanMaxActors"

# Prove the model can actually call a tool before declaring success. A model
# that cannot is worse than no model: it answers with invented numbers.
Write-Host ''
Write-Host 'Checking tool calling...'
$probe = @{
    model    = $DerivedModel
    stream   = $false
    messages = @(@{ role = 'user'; content = 'Call get_power_circuits. Reply only with the tool call.' })
    tools    = @(@{
            type     = 'function'
            function = @{
                name        = 'get_power_circuits'
                description = 'Power capacity, headroom, fuse state, and battery runtime.'
                parameters  = @{ type = 'object'; properties = @{}; additionalProperties = $false }
            }
        })
} | ConvertTo-Json -Depth 12 -Compress

try {
    $answer = Invoke-RestMethod -Method Post -Uri "$apiRoot/v1/chat/completions" `
        -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($probe)) -TimeoutSec 180
    $calls = $answer.choices[0].message.tool_calls
    if ($calls -and $calls.Count -gt 0) {
        Write-Host "  tool calling works ($($calls[0].function.name))." -ForegroundColor Green
    }
    else {
        Write-Warning "  '$DerivedModel' answered without calling the tool. The solvers will not be used."
        Write-Warning "  Either pick a tool-capable model, or set LOCAL_AI_TOOLS=false so the bridge"
        Write-Warning "  labels its numbers unverified rather than presenting them as computed."
    }
}
catch {
    Write-Warning "  Tool-calling probe failed: $($_.Exception.Message)"
}

Write-Host ''
Write-Host 'Restart the bridge to pick this up:'
Write-Host '  Stop-ScheduledTask -TaskName "AI Factory Copilot Companion"; Start-ScheduledTask -TaskName "AI Factory Copilot Companion"'
