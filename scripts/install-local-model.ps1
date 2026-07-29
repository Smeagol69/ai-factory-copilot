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
    [string] $ModelDirectory = '',
    # Short by default: the GPU is shared with the game.
    [string] $KeepAlive = '60s',
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


<#
    Ollama reads OLLAMA_MODELS when its server process starts, not per command.
    Setting the variable and pulling immediately therefore writes to the default
    location on C: anyway — which matters here, because C: is the small drive.
    Relocating means moving the directory and restarting the server, so this
    does both rather than leaving a 9 GB surprise on the wrong disk.
#>
<#
    How long the model stays resident in VRAM after answering.

    This is the setting that decides whether the copilot fights the game for
    video memory. Ollama's default holds the weights for five minutes, which on
    a 16 GB card means Satisfactory is competing for what is left long after the
    question was answered. A short value releases the VRAM promptly at the cost
    of reloading on the next question.
#>
function Set-OllamaKeepAlive {
    param([string] $KeepAlive)
    if (-not $KeepAlive) { return }
    [Environment]::SetEnvironmentVariable('OLLAMA_KEEP_ALIVE', $KeepAlive, 'User')
    $env:OLLAMA_KEEP_ALIVE = $KeepAlive
    Write-Host "Model stays loaded for $KeepAlive after each answer."
}

function Set-OllamaModelDirectory {
    param([string] $Path, [string] $OllamaPath)

    if (-not $Path) { return }
    $current = [Environment]::GetEnvironmentVariable('OLLAMA_MODELS', 'User')
    $default = Join-Path $env:USERPROFILE '.ollama\models'
    New-Item -ItemType Directory -Path $Path -Force | Out-Null

    # Move anything already pulled, so the change does not orphan existing models.
    if ((Test-Path $default) -and -not (Test-Path (Join-Path $Path 'blobs'))) {
        $size = (Get-ChildItem $default -Recurse -File -ErrorAction SilentlyContinue |
                 Measure-Object Length -Sum).Sum
        if ($size -gt 0) {
            Write-Host ("Moving {0:N1} GB of existing models to {1}..." -f ($size / 1GB), $Path)
            Get-Process -Name 'ollama*' -ErrorAction SilentlyContinue | Stop-Process -Force
            Start-Sleep -Seconds 2
            Get-ChildItem $default -Force | Move-Item -Destination $Path -Force
        }
    }

    if ($current -ne $Path) {
        [Environment]::SetEnvironmentVariable('OLLAMA_MODELS', $Path, 'User')
    }
    $env:OLLAMA_MODELS = $Path

    # Restart so the server actually reads the new location.
    Get-Process -Name 'ollama*' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    Start-Process -FilePath $OllamaPath -ArgumentList 'serve' -WindowStyle Hidden
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Seconds 1
        try { Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2 | Out-Null; break } catch { }
    }
    Write-Host "Models directory: $Path"
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

Set-OllamaKeepAlive -KeepAlive $KeepAlive
Set-OllamaModelDirectory -Path $ModelDirectory -OllamaPath $ollamaPath

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
