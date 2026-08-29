# Installation and packaging

AI Factory Copilot is **one install**. The loopback-only Node companion that
runs the solvers ships inside the mod and starts itself when a world loads. The
public beta targets the Windows Steam/Epic client. Dedicated-server and Linux
targets are not claimed yet.

**Node.js 20 or newer must be on the system** — it is the only external
requirement. Without it the mod still loads and the panel says so in as many
words; sliders, selection, blueprint export, terrain scan and vision all work
without the bridge. Only the assistant's answers need it.

## Player installation

1. Install Satisfactory Mod Manager and SML using the
   [official installation guide](https://docs.ficsit.app/satisfactory-modding/latest/ForUsers/SatisfactoryModManager.html).
2. Install AI Factory Copilot through Mod Manager when its release is listed.
   Prereleases are not auto-downloaded; for a GitHub beta, use the packaged
   `AIFactoryCopilot-<version>-Windows.zip` and the
   [official manual-install directions](https://docs.ficsit.app/satisfactory-modding/latest/ManualInstallDirections.html).
3. Launch the game and press **Insert**.

That is the whole installation. The mod archive includes the bridge's
lock-pinned production dependency tree, so no manual `npm` command is needed
for a normal SML install. The bridge starts with the world and stops with it,
and the mod only ever stops a bridge it started — one you run yourself is left
alone.

Set `"autoStartCompanion": false` in `FactoryGame/Configs/AIFactoryCopilot.cfg`
to turn the automatic launch off.

## Optional: running the companion yourself

Only needed to run the bridge on another machine, to keep it alive between game
sessions, or to manage it as a service. Take
`AIFactoryCopilot-Companion-<version>-Windows.zip` from a release built with
`-SeparateCompanionArtifact`, extract it, open PowerShell there, and run:

   ```powershell
   ./scripts/install-companion.ps1
   ```

   Node.js 20 or newer is required. The installer materialises the exact
   lock-pinned dependency graph in a staging directory before replacing an
   existing runtime, then uses
   `%LOCALAPPDATA%\AI Factory Copilot\Companion` for a new install, preserves an
   already verified older location during upgrades, registers a limited-user
   logon task, verifies every runtime file by SHA-256, and waits for the health
   endpoint. It will not clean a directory it cannot prove belongs to this
   product and will not stop an unrelated process occupying port 8142.
4. Configure a provider. API key input is hidden and is written only to the
   installed private `.env`:

   ```powershell
   ./scripts/configure-companion.ps1 -Provider openai
   ```

   If an upgrade kept a previous location, the installer prints that exact path;
   the configurator resolves it from the verified scheduled task. Anthropic and
   local examples are:

   ```powershell
   ./scripts/configure-companion.ps1 -Provider anthropic -Model 'your-explicit-model-id'
   ./scripts/configure-companion.ps1 -Provider local -Model 'your-local-model-id'
   ```

   Advanced users can instead copy and edit the installed `.env.example`:

   ```powershell
   $companionDir = Join-Path $env:LOCALAPPDATA 'AI Factory Copilot\Companion'
   Copy-Item "$companionDir\.env.example" "$companionDir\.env"
   notepad "$companionDir\.env"
   ```

   Local OpenAI-compatible servers use `AI_PROVIDER=local`,
   `LOCAL_AI_BASE_URL`, and `LOCAL_AI_MODEL`. The local `.env` is the final
   authority over process, user, and machine variables. It is preserved across
   upgrades and is never copied back into the repository.
5. Restart the installed companion and verify it:

   ```powershell
   Stop-ScheduledTask -TaskName 'AI Factory Copilot Companion'
   Start-ScheduledTask -TaskName 'AI Factory Copilot Companion'
   Invoke-RestMethod http://127.0.0.1:8142/health
   ```

   Health must report `status: ok`, the selected provider as ready, and the same
   `bridge_version` as the installed mod. A mismatch is intentionally refused
   before any game action can execute.
6. Launch a save and press **Insert**. Ask a read-only question first, such as
   "what machines and resource nodes are near me?" Writes remain off by default.

The installed companion records question text and routing outcomes in
`%LOCALAPPDATA%\FactoryGame\Saved\AIFactoryCopilot\Diagnostics\routing.jsonl`.
This diagnostic is used to improve free deterministic routing. Set
`AIFACTORY_ROUTING_LOG=off` in the companion's private `.env` to disable it, or
set the value to a full path to redirect it. Isolated test servers do not write
to the player's log.

## Game configuration

The mod reads:

```text
<Satisfactory>\FactoryGame\Configs\AIFactoryCopilot.cfg
```

The release companion bundle includes `Config/AIFactoryCopilot.cfg`. Copy it to
that path only when the packaged mod has not already installed a config. Its
default bridge URL is `http://127.0.0.1:8142/v1/ask`.

World writes require an explicit opt-in:

```json
{ "allowWriteActions": true }
```

Keep writes off until read-only answers and dry-run action previews match the
loaded save. The native Creative Resource Node editor (`/ai node place copper
ore pure`) uses this same gate; it never silently bypasses it. Its live catalog
also accepts registered liquid, gas, and geothermal geyser descriptors; native
water-volume and fracking placement rules still apply to their own extractors.
In multiplayer, only a Satisfactory server admin can arm that editor, and its
universal Build Gun recipe becomes a persistent world-level unlock after the
first authorized use. `includeVisibleUiText` is also off by default because
another mod's rendered UI can contain private text.

## Source build environment

The descriptor targets SML 3.12.0 and FactoryGame changelist 502094. Use the
official Satisfactory Modding Starter Project and its Coffee Stain Unreal Engine
5.6.1-CSS installation. Do not package with a stock Epic engine.

The official guide calls for Visual Studio 2022 with .NET desktop development,
Desktop development with C++, Game development with C++, MSVC v143 14.38, .NET
8, and the .NET Framework 4.8.1 SDK.

Sync the repository into the Starter Project:

```powershell
./scripts/install-to-starter.ps1 `
  -StarterProjectPath 'D:\Modding\Satisfactory\StarterProject-502094' -Force
```

Then validate, build, package, and assemble public artifacts:

```powershell
./scripts/validate.ps1 `
  -StarterProjectPath 'D:\Modding\Satisfactory\StarterProject-502094'
./scripts/package-local.ps1 -StarterProjectPath 'D:\Modding\Satisfactory\StarterProject-502094'
./scripts/package-release.ps1
```

`package-local.ps1` refuses to deploy while Satisfactory holds the DLL open or
when the Starter Project, descriptor, and installed game changelists do not
match. It
builds the official editor target required for cooking, invokes UAT with
`-ScriptsForProject`, packages the Windows client, deploys it to the game, and
checks the deployed version and icon. `package-release.ps1` then refuses a stale
mod archive, creates separate mod and companion ZIPs in `dist`, verifies their
required contents, and writes SHA-256 checksums.

## Smoke test

After loading a save:

1. Press Insert and verify the live player position changes as you move.
2. Ask "what verified objects are nearby?" in diagnostic/mock mode.
3. Ask a solver-backed production or power question with the configured model.
4. Keep writes off and ask for a placement; verify the dry-run reports no world
   change.
5. Enable writes only in a disposable test save, then compare the returned
   action outcome with the world and
   `Saved/AIFactoryCopilot/Diagnostics/latest-bridge-response.json`.

The full public-beta construction matrix is tracked in
[COMPATIBILITY.md](COMPATIBILITY.md) and [CHANGELOG.md](../CHANGELOG.md). Do not
describe placement as production-ready until valid, blocked, unaffordable,
rotation, no-build-cost, rollback, refund, blueprint-proxy, belt, and modded
recipe cases have all been exercised in a packaged live game.

## Diagnostic startup self-test

`startupSelfTest` submits a real paid question after every save load and places
the result in the panel. Use it only for a deploy check, then turn it off:

```json
{
  "startupSelfTest": true,
  "startupSelfTestDelaySeconds": 10.0,
  "startupSelfTestQuestion": "Using only the authoritative snapshot, what should the player do next?"
}
```
