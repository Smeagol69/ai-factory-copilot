# Architecture

## Trust boundary

The game is the authority. The model is not.

```text
Satisfactory / SML
  -> authoritative scanner
  -> exact player/camera/interaction grounding
  -> versioned JSON snapshot captured per message
  -> localhost companion
  -> deterministic solvers over the cached production graph
  -> configured model API, which calls the solvers as tools
     (+ optional labeled web references)
  -> advisory in-game panel/chat response
```

Every snapshot declares:

```json
{
  "data_policy": "authoritative_or_explicitly_unknown",
  "world_revision": 42,
  "completeness": {
    "actor_limit_reached": false,
    "unknown_policy": "Unknown custom behavior is never inferred; an explicit adapter is required."
  }
}
```

The bridge rejects snapshots without that data policy. When it must shrink a
snapshot to fit an API context, it reports the omitted categories in the
response. The model prompt requires missing data to remain unknown.

## Unreal/SML lifecycle

`UAIFactoryGameWorldModule` is a native SML `UGameWorldModule` with
`bRootModule = true`. SML discovers native root modules through its loaded-class
scan. During the construction lifecycle the module registers:

- `AAIFactorySubsystem`
- `AAIFactoryChatCommand`

The subsystem uses `SpawnOnServer`. This keeps factory state and future write
operations on the authoritative side and also works in single-player.

## Snapshot sources

| Snapshot data | Authoritative source |
|---|---|
| Loaded mods and versions | `UModLoadingLibrary` |
| Items and ownership | `UModContentRegistry::GetLoadedItemDescriptors` |
| Recipes and ownership | `UModContentRegistry::GetRegisteredRecipes` |
| Ingredients/products/duration/producers | `UFGRecipe` accessors |
| World buildables | live `AFGBuildable` actors |
| Machine state | `AFGBuildableFactory` accessors |
| Selected recipe | `AFGBuildableManufacturer` |
| Inventories | attached `UFGInventoryComponent` objects |
| Conveyor connections | `UFGFactoryConnectionComponent` |
| Pipe connections | `UFGPipeConnectionComponent` |
| Power connectivity | `UFGPowerConnectionComponent` and power info |
| Resource nodes | `AFGResourceNodeBase` and `AFGResourceNode` |
| Players, vehicles, and pickups | live FactoryGame actor classes |
| Exact player/camera pose | command sender's `AFGPlayerController` and pawn |
| Current usable target | `AFGCharacterPlayer::GetCachedUseState` |
| Crosshair fallback | authoritative Unreal visibility trace from the camera |
| Purchased progression | `AFGSchematicManager` |
| Additional mod properties | Unreal `FProperty` reflection |
| Custom nonstandard behavior | `IAIFactoryDataProvider` adapter |

Reflection output records the declaring class, C++ type, property flags,
exported value, source, and certainty. Transient, deprecated, editor-only, and
explicitly skipped properties are excluded. Values and counts are bounded by
configuration to prevent accidental multi-gigabyte payloads.

## Continuous observation

Actor creation and destruction update the world revision immediately. A
configurable main-thread observer fingerprints:

- actor identity and transform
- construction recipe
- production state and potential
- manufacturer recipe

Fast-changing inventory counts are read fresh in every snapshot but deliberately
do not invalidate the structural world revision. Otherwise every transferred
item would make every pending plan stale.

The observer does not run inside `Factory_Tick`; the official documentation
warns that factory ticks may run on worker threads and that many Unreal
operations are main-thread-only.

## Deterministic solver layer

The model is not trusted with factory arithmetic. `companion/lib/graph.mjs`
builds a cached production graph from the snapshot and `companion/lib/solvers.mjs`
answers questions about it:

| Solver tool | Answers |
|---|---|
| `get_machine_rates` | exact per-minute inputs and outputs per machine |
| `get_item_balance` | production versus consumption per item |
| `find_recipes` | recipes producing or consuming an item, ranked by rate |
| `get_transport_capacity` | belt and pipe capacity against supply and demand |
| `get_power_circuits` | capacity, headroom, fuse, battery runtime |
| `diagnose_bottlenecks` | why a machine is stopped, and the upstream root cause |
| `get_build_cost` | construction cost against captured player inventories |
| `find_best_site` | ranked build locations scored by surrounding resource access |
| `get_unlock_status` | purchased schematics and tech tier |

Three rules keep the layer honest:

1. **Solvers see exactly what the model sees.** The graph is built from the
   *compacted* snapshot, after bridge omissions. A solver can never cite data the
   model was not given.
2. **Derived values carry their basis.** Rates come from each machine's live
   `production_cycle_seconds`, which already includes overclocking, so potential
   is never multiplied in twice. Liquid and gas registry amounts are divided by
   1000 before being compared with pipeline flow limits. Conveyor throughput is
   `reported_speed / 2` by documented engine convention and is labelled
   `calculated_from_convention` with the raw value alongside it.
3. **Unknowns are returned, not filled in.** A machine with no derivable rate
   appears in `unresolved_machines` with the missing field named. Recipe unlock
   state is reported as `not_determinable_from_snapshot`. Bounded tool results
   declare their own truncation so omitted rows stay unknown rather than reading
   as absent.

Root-cause analysis classifies each cause as `invalid` (cannot work as built),
`inefficient` (works but below potential), or `unknown` (not enough captured
evidence). Causes that propagate — a starved input — are walked upstream through
the belt graph so the report names the machine that actually has to change;
causes that do not propagate, such as a power deficit or a disconnected port,
stop the walk.

`POST /v1/analyze` returns the whole report with no model involved, and mock mode
runs the solvers, so both are verifiable without an API key.

## AI provider isolation

The companion listens on `127.0.0.1` only. It accepts the versioned
`aifactory.ask` schema and:

1. validates the no-guessing policy;
2. compacts oversized snapshots in a deterministic order;
3. includes the exact omission list;
4. calls the selected provider;
5. returns a versioned answer with the source world revision.

Provider credentials are process environment variables. They never enter the
game mod, save file, snapshot, or chat history.

OpenAI requests use native message roles with `store: false`. The companion
keeps bounded local history keyed by map, save session, and player. The current
snapshot always overrides historic target/position references. Optional web
search is for outside references only; URLs are returned with the answer and
cannot override the live snapshot.

Both providers run a bounded solver loop. Because `store: false` means the
provider retains nothing, the companion resends the model's own tool calls with
each round; Anthropic gets the equivalent `tool_use`/`tool_result` turns. The loop
stops after `AIFACTORY_MAX_SOLVER_ROUNDS` rounds rather than looping forever, and
every solver call is reported back to the game in `solver_calls`.

## Write-action architecture

Future placement must not expose arbitrary Unreal mutation to the model. It
will use typed proposals:

```text
model proposal
  -> schema validation
  -> plan/world revision comparison
  -> server authority check
  -> hologram placement validation
  -> material/unlock validation
  -> player confirmation
  -> FactoryGame construction call
  -> read-back verification
```

Blueprint compilation follows the same rule: generate a plan, validate it
inside the designer volume, populate it through supported game systems, then
read the resulting blueprint back and compare it with the plan.
