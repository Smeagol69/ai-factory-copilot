# Starts the hub (Team room, Design studio, conductor) at every logon, so the
# conductor keeps the models working around the clock. The conductor's own on/off
# switch and the game handoff are unchanged: this only keeps the hub running.
#   powershell -ExecutionPolicy Bypass -File hub\scripts\install-hub-autostart.ps1
#   powershell -ExecutionPolicy Bypass -File hub\scripts\install-hub-autostart.ps1 -Remove
param([switch]$Remove)
$name = 'AI Factory Copilot Hub'
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; "Removed '$name'"; return }
$hub = Split-Path -Parent $PSScriptRoot
$node = Join-Path $hub 'runtime\node\node.exe'
if (-not (Test-Path $node)) { throw "Node runtime not found at $node" }
$action = New-ScheduledTaskAction -Execute $node -Argument 'scripts\start-app.mjs' -WorkingDirectory $hub
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Restart if it stops; no time limit; also runs on battery.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'Starts the Satisfactory hub at logon (start-app.mjs reuses a running hub).' -Force | Out-Null
"Registered '$name': $node scripts\start-app.mjs in $hub at logon"
