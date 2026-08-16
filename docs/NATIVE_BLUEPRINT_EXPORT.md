# Native whole-factory blueprint export

This is the contract for taking an existing factory and asking Satisfactory to
write a real native `.sbp` / `.sbpcfg` blueprint from it. It is deliberately
different from both existing features:

| Feature | Source | Result | Extractors / lightweight parts |
|---|---|---|---|
| Saved design | Bridge snapshot | JSON replay list | Can describe an extractor placement, but is not a native `.sbp` |
| `place_blueprint` | Existing `.sbp` | Native Blueprint Hologram placement | The game's loader owns its contents and internal wiring |
| `export_native_blueprint` | Exact dismantle-tool selection | Request for the game to write a new native archive | The executor must preserve them or explicitly refuse; it must never silently drop them |

## Player flow

1. Switch to Satisfactory's **Dismantle** tool.
2. Mark every actor that belongs in the factory. This only selects; it does not
   dismantle anything.
3. Ask, for example: `export this factory as blueprint Northern Steel Works`.
4. Read the action result. A request is not a completed export: only the game
   may report that it wrote an `.sbp`, name the descriptor it registered, and
   list anything it could not package.

There is intentionally no radius fallback and no “everything near the
crosshair” mode. A radius is a guess at a factory boundary, which is especially
unsafe for a megabase with adjacent power, train, and architecture systems.

## Bridge action contract (v1)

The companion accepts this one typed write action. `commit` is false unless a
caller explicitly sets it; the natural-language imperative above sets it true.

```json
{
  "action": "export_native_blueprint",
  "blueprint_name": "Northern Steel Works",
  "selection_source": "dismantle_selection",
  "selected_actor_ids": [
    "/Game/FactoryGame/Map/GameLevel01.Persistent_Level.Build_SmelterMk1_C_7",
    "/Game/FactoryGame/Map/GameLevel01.Persistent_Level.Build_ConstructorMk1_C_12"
  ],
  "selected_actor_count": 2,
  "captured_selection_bounds_cm": {
    "minimum": { "x": 1000, "y": -400, "z": 200 },
    "maximum": { "x": 9200, "y": 5600, "z": 3800 },
    "units": "unreal_centimeters"
  },
  "commit": true,
  "expect_world_revision": "731",
  "require_unchanged_world": false
}
```

`selected_actor_ids` must be the complete, duplicate-free set reported by the
current `interaction_context.dismantle_selection`. The bridge rejects a
subset, addition, replacement, unavailable selection state, missing selected
actor, non-buildable member, or member with uncaptured bounds. That prevents a
model from turning “this factory” into an arbitrary actor list.

`captured_selection_bounds_cm` is **evidence only**. The bridge computes it as
the union of the selected actors’ captured `GetActorBounds` boxes so a response
can diagnose drift. It is not an instruction to the game. The C++ executor
must re-resolve the actor paths and recompute all bounds immediately before
serialising.

No field accepts a radius, a fixed designer size, or a maximum selected-actor
count. The action remains one plan step whether it contains two actors or a
whole megabase. Transport, memory, archive, replication, and native serializer
limits are real system constraints, but they must be measured and returned as
an explicit game result rather than disguised as an arbitrary bridge cap.

## Required game-side executor behaviour

The companion **does not write files**. The native executor must:

1. Enforce the ordinary server/write/revision gates and parse every typed field.
2. Re-read the live dismantle selection; resolve every submitted actor ID; and
   reject a changed, missing, duplicate, non-buildable, or partial selection.
3. Recompute the live union bounds and native blueprint origin/dimensions. Do
   not trust the bridge envelope for placement or size calculations.
4. Expand native proxy groups correctly. Lightweight foundations/walls and
   proxy-owned parts cannot be treated as ordinary `AFGBuildable` actors.
5. Treat extractors as resource anchors. A portable archive cannot truthfully
   claim a miner is valid at every destination node; preserve a verified anchor
   mapping/sidecar or refuse with a named reason. Never silently omit a miner.
6. Use Satisfactory's `AFGBlueprintSubsystem` archive/config/disk/refresh path,
   then re-read its descriptor/header before returning success.
7. Refuse an existing output name unless a future, separately designed
   replace-and-backup contract explicitly authorizes it. A failed archive must
   leave no partial `.sbp`/`.sbpcfg` pair behind.

The action is a durable file write, not an `undo_last` transaction. A committed
native export must be a single action in its plan, and its final result must
say either `blueprint_written` with the registered name/path/header facts or a
specific refusal reason. The bridge route deliberately says only that it
**submitted** an export request until that readback arrives.

## Native placement remains native

Export is not a replacement for the Blueprint Designer or the build gun. Once
the game has created and registered an archive, `place_blueprint` (and the
local build-gun preview workflow) remains the placement path, so Satisfactory
owns hologram rotation, snapping, cost, proxy grouping, and internal belt/pipe
connections. The export path must not reimplement those systems in the bridge.
