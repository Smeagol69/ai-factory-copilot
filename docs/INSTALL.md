# Installation and packaging

## Required official environment

The current plugin descriptor targets SML 3.12.0 and FactoryGame changelist
491125. Use the official Satisfactory Modding Starter Project and its required
Coffee Stain Unreal Engine 5.6.1-CSS installation.

The official guide calls for Visual Studio 2022 with:

- .NET desktop development
- Desktop development with C++
- Game development with C++
- MSVC v143 14.38 toolchain
- .NET 8 runtime
- .NET Framework 4.8.1 SDK

Do not package with stock Unreal 5.7 or another Epic launcher engine.

## Add the plugin to the Starter Project

From this repository:

```powershell
./scripts/install-to-starter.ps1 -StarterProjectPath 'C:\Modding\Satisfactory'
```

The script validates `FactoryGame.uproject`, checks its engine association, and
copies the plugin to:

```text
<Starter Project>\Mods\AIFactoryCopilot
```

It refuses to overwrite an existing destination unless `-Force` is supplied.

Alternatively, clone this repository directly into that `Mods` directory.

## Build and package

1. Open the Starter Project through the Coffee Stain engine.
2. Allow Unreal to build the C++ module.
3. Open Alpakit Dev.
4. Confirm SML is the `^3.12.0` dependency.
5. Package AI Factory Copilot for Windows, Windows Server, and Linux Server as
   appropriate.
6. Use Alpakit's copy-to-mods-directory option for local testing.
7. Run at least single-player, host-and-play, and dedicated-server tests before
   release.

## Configuration

Copy `Config/AIFactoryCopilot.cfg` to:

```text
<Satisfactory>\FactoryGame\Configs\AIFactoryCopilot.cfg
```

The defaults expect the companion at:

```text
http://127.0.0.1:8142/v1/ask
```

## Companion

Install the localhost bridge as a clean, supervised runtime:

```powershell
./scripts/install-companion.ps1
```

By default this installs only the files required at runtime into
`D:\Modding\Satisfactory\Companion`, preserves a local `.env` and the `Logs`
directory, removes stale runtime files, verifies every copied file by SHA-256,
registers the `AI Factory Copilot Companion` logon task, and waits for
`http://127.0.0.1:8142/health` to report healthy. The installer refuses to clean
any destination whose leaf folder is not exactly `Companion`, and it refuses to
stop an unrelated process listening on the configured port.

The runner reads an optional `.env` in the installed directory. Existing
process or user environment variables take precedence. It selects Anthropic
when `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` are set, OpenAI when
`OPENAI_API_KEY` is set, and mock mode otherwise. Set `AI_PROVIDER` explicitly
to override that selection. Secrets are not copied from the repository.

For development without installing the task, run:

```powershell
./scripts/run-companion.ps1
```

Start the bridge before using `/aifactory ask`. The `status`, `scan`, and
`export` commands do not need it.

## Smoke test

After loading a save:

1. Run `/aifactory status`.
2. Run `/aifactory scan 250`.
3. Run `/aifactory export 250`.
4. Check `FactoryGame/Saved/AIFactoryCopilot/Snapshots/latest.json`.
5. Start the companion in mock mode.
6. Run `/aifactory ask What verified objects are nearby?`.

Mock mode must report the received actor, recipe, item, and mod counts without
making strategic claims.

## Non-interactive live self-test

For diagnostics when chat input cannot be automated, temporarily set these
values in `FactoryGame/Configs/AIFactoryCopilot.cfg`:

```json
{
  "startupSelfTest": true,
  "startupSelfTestDelaySeconds": 10.0,
  "startupSelfTestQuestion": "Using only the authoritative snapshot, what should the player do next?"
}
```

On the next save load, the mod executes `aifactory export 250` and
`aifactory ask ...` through SML's actual chat-command subsystem. It writes the
snapshot to `Saved/AIFactoryCopilot/Snapshots/latest.json` and the raw bridge
response to
`Saved/AIFactoryCopilot/Diagnostics/latest-bridge-response.json`. Set
`startupSelfTest` back to `false` after verification so it does not repeat.
