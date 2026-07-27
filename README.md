# AI Factory Copilot for Satisfactory

AI Factory Copilot is an SML C++ mod plus a localhost companion process. The
mod reads authoritative runtime state from Satisfactory and sends a bounded,
evidence-bearing snapshot to a configurable AI provider. It never asks the
model to identify machines from screenshots or guess undisclosed game state.

This repository implements a working **read-only AI co-player**:

- an Insert-toggled in-game chat panel: type a question however you want to word
  it, Enter to send, Shift+Enter for a new line, with a transcript, a live
  elapsed indicator while the answer is being worked out, and a continuously
  updating exact player-position/current-focus status strip
- reasoning plus outside references: adaptive thinking, and web search
  restricted to the official wiki, modding docs, and forums, cited in the answer
- fresh whole-world capture for every panel message, including exact pawn,
  camera, crosshair hit, and Satisfactory cached interaction state
- SML 3.12.0 native root module and server-authoritative mod subsystem
- discovery of loaded mods and versions
- SML registry discovery for vanilla and modded items and recipes
- live buildable, resource-node, transform, bounds, blueprint membership,
  inventory, conveyor/pipe/power connection, recipe, production, boost,
  clocking, productivity, transport, power-circuit, player, vehicle, pickup,
  progression, and power-consumption scanning
- bounded Unreal reflection for additional non-transient mod properties
- an explicit `IAIFactoryDataProvider` adapter contract for custom semantics
- continuously changing world revisions based on live factory fingerprints
- authoritative JSON snapshot export
- natural in-game `/ai <question>` chat plus administrative commands
- an opt-in startup self-test that exercises the real SML command path and
  persists the bridge response for non-interactive diagnostics
- a loopback-only companion supporting diagnostic, OpenAI, and Anthropic modes
- local multi-turn conversation memory, per-save/player reset, and optional
  OpenAI web search for clearly labeled outside references
- strict context compaction that reports every omitted category

## Deterministic solvers

The model does not do factory arithmetic. It calls solvers that run on the same
snapshot it was shown, and answers that mix solver output with guesswork are
prevented by construction: a value the snapshot cannot support comes back as an
explicit unknown with the missing field named.

| Solver | Answers |
|---|---|
| `get_machine_rates` | exact per-minute inputs and outputs per machine |
| `get_item_balance` | production versus consumption per item, with surplus/deficit |
| `find_recipes` | recipes producing or consuming an item, ranked by rate |
| `get_transport_capacity` | belt and pipe capacity against supply and demand |
| `get_power_circuits` | capacity, headroom, fuse state, battery runtime |
| `diagnose_bottlenecks` | why a machine is stopped, and the upstream root cause |
| `get_build_cost` | construction cost against captured player inventories |
| `find_best_site` | ranks where to build, scoring resource access around every candidate |
| `get_unlock_status` | purchased schematics and tech tier |

Siting questions are computed, not eyeballed. Ask *"where should I put the HUB?"*
and `find_best_site` scores every usable resource node as a candidate centre by
resource diversity, purity-weighted node count, coverage of the resources you
named, and distance cost — returning exact coordinates, the runners-up, and the
per-factor breakdown. Occupied nodes and hand-mined `Deposit` nodes are excluded,
because a miner cannot be placed on either. Terrain flatness, obstructions, and
water access are **not** captured and are reported as unknown, so confirm the
winning spot is actually buildable before committing to it.

Rates come from each machine's live production cycle time, so overclocking is
never double-counted; production boost applies to products only; liquid and gas
registry amounts are converted to cubic metres before being compared with
pipeline flow limits. Stalls are classified as invalid, inefficient, or unknown,
and a starved machine's report names the upstream machine that actually has to
change.

Ask the whole report with no model involved:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8142/v1/analyze `
  -ContentType 'application/json' `
  -Body (Get-Content -Raw 'FactoryGame\Saved\AIFactoryCopilot\Snapshots\latest.json' |
    ForEach-Object { "{`"schema`":`"aifactory.analyze`",`"schema_version`":1,`"world_snapshot`":$_}" })
```

It does **not** yet place buildings, validate hypothetical holograms, generate
Blueprint Designer layouts, or mutate saves. Those operations must be built
on top of the verified scanner and executed through server-authoritative,
revalidated game actions.

## In-game commands

Press **Insert** in a loaded save to open or close the copilot panel. Type a
question and press Enter. The panel defaults to a whole-world snapshot; its
live status strip updates while open, and the exact state used for an answer is
captured when Send is pressed.

```text
/ai <question>
/ai all <question>
/ai reset
/ai status
/ai scan [radius_m]
/ai export [radius_m|all]
```

Examples:

```text
/ai what should I build here?
/ai is this machine connected correctly?
/ai Why are the manufacturers near me not producing?
/ai Which installed mod owns the machines in this area?
/ai all Where is the largest current bottleneck in my world?
```

The longer `/aifactory ask ...` syntax remains available for compatibility.

## Start the companion

Node.js 20 or newer is required. No packages need to be installed.

Diagnostic mode works without an API key:

```powershell
cd companion
$env:AI_PROVIDER = 'mock'
node server.mjs
```

Free and unlimited, using any OpenAI-compatible local server (Ollama, LM Studio,
llama.cpp, vLLM) — no key, no rate limits, no cost:

```powershell
cd companion
$env:AI_PROVIDER = 'local'
$env:LOCAL_AI_MODEL = 'qwen3'
node server.mjs
```

`LOCAL_AI_BASE_URL` defaults to Ollama's `http://127.0.0.1:11434/v1`. Pick a model
that supports tool calling, since the solvers are tools; with one that does not,
set `LOCAL_AI_TOOLS=false` and the bridge will label its numbers unverified rather
than passing them off as computed.

OpenAI:

```powershell
cd companion
$env:AI_PROVIDER = 'openai'
$env:OPENAI_API_KEY = 'your-key'
$env:OPENAI_MODEL = 'gpt-5.6-sol'
$env:OPENAI_WEB_SEARCH = 'true'
node server.mjs
```

Anthropic:

```powershell
cd companion
$env:AI_PROVIDER = 'anthropic'
$env:ANTHROPIC_API_KEY = 'your-key'
$env:ANTHROPIC_MODEL = 'an-explicit-model-id'
node server.mjs
```

The OpenAI bridge uses the Responses API with `store: false`; conversation
history stays in the local companion process. Web search is selected by the
model only when outside/current information is needed and adds cited URLs to
the answer. It can be disabled with `OPENAI_WEB_SEARCH=false`.

The Anthropic model is deliberately required instead of guessed. API keys stay
in the companion process and are never stored in the Unreal plugin.

Check the bridge:

```powershell
Invoke-RestMethod http://127.0.0.1:8142/health
```

The health response lists the solver tools the bridge will offer the model. Mock
mode runs the solvers too, so the deterministic analysis can be verified without
any API key.

## Outside references

Save state answers most questions. When one genuinely needs outside knowledge —
a recipe this save has not unlocked, a mod's documented behavior, a patch change,
a community technique — the copilot searches, and by default it may only search
the sources that are actually authoritative for Satisfactory:

`satisfactorygame.com`, `questions.satisfactorygame.com`, `docs.ficsit.app`,
`ficsit.app`, `satisfactory.wiki.gg`, `satisfactory.fandom.com`,
`satisfactory-calculator.com`, `satisfactorytools.com`, `reddit.com`,
`steamcommunity.com`

On Anthropic this is enforced by the API through the search tool's
`allowed_domains`, so an answer cannot cite anything off the list while the
restriction is on. Pages used are cited under the reply. Three rules hold
regardless of provider: the live save always outranks any page, the solvers
outrank the model's own arithmetic, and a search failure is stated in the answer
rather than passed off as a complete result.

Override with `AIFACTORY_SOURCE_DOMAINS`, loosen with
`AIFACTORY_RESTRICT_SOURCES=false`, or turn searching off entirely with
`AIFACTORY_WEB_SEARCH=false` — the copilot then says search is off instead of
answering from memory as though it were verified.

The clean local installation uses `scripts/run-companion.ps1`. It selects
OpenAI when `OPENAI_API_KEY` is available in the current user's environment,
Anthropic when both its key and an explicit model are configured, and mock
mode otherwise. API keys are never copied into this repository or its logs.

## Build the mod

This source targets:

- Satisfactory changelist `491125` or newer
- SML `3.12.0`
- the Coffee Stain `5.6.1-CSS` Unreal build used by the official Starter Project

Follow [docs/INSTALL.md](docs/INSTALL.md). A stock Epic Unreal installation is
not ABI-compatible with Satisfactory and must not be used to package the mod.

## Validate

```powershell
./scripts/validate.ps1
```

The companion tests can also be run directly:

```powershell
cd companion
npm test
```

## Design documents

- [Architecture](docs/ARCHITECTURE.md)
- [Installation and packaging](docs/INSTALL.md)
- [Compatibility contract](docs/COMPATIBILITY.md)
- [Current boundaries and roadmap](docs/ROADMAP.md)
- [Official documentation references](docs/OFFICIAL_REFERENCES.md)
