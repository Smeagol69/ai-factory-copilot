# AI-generated native Blueprints

This is the pipeline for creating a factory that does **not** already exist in
the world:

```text
live recipe/unlock snapshot
  -> deterministic production quantities
  -> measured/grid-aligned architecture and machine transforms
  -> aifactory.generated-blueprint/v1 (standalone) or /v2 (explicit topology)
  -> transient native actors in an empty real Blueprint Designer
  -> native SaveBlueprint + ReadBlueprintFromDisc
  -> vanilla Blueprint library and Build Gun hologram
```

It is separate from `export_native_blueprint`, which captures a factory the
player already built or selected. `generate_native_blueprint` receives a full
Blueprint-relative layout computed by the planners.

## Authority and validation

The companion accepts only finite transforms and exact recipes that the current
snapshot proves available. The game repeats the decision from live state:

- every build recipe must resolve to an unlocked building descriptor and
  unlocked buildable class;
- every selected production recipe must still be unlocked and compatible with
  the staged manufacturer;
- all staging actors use deferred spawning, `RF_Transient`, and
  `SetInsideBlueprintDesigner` only before `BeginPlay`;
- the staged buildable's native `FFGClearanceData`—the contract used by
  Satisfactory's hologram clearance system—is measured first. Registered
  colliding primitive bounds and then all registered primitive bounds are exact
  fallbacks for classes without clearance records. The result reports how many
  parts used each source. This matters for authoritative-server lightweight
  foundations, which have native clearance but no registered colliding render
  primitive. Machine/machine or machine/shell volumetric overlap refuses the
  archive, while native snapped structural contacts and a shallow machine/floor
  contact are explicitly classified;
- Designer membership is unwound and every staged actor is destroyed on every
  exit path;
- `SaveBlueprint` returning is not success. The native subsystem must refresh
  and read the named archive back from disk. For v2 it then loads that exact
  archive into Satisfactory's isolated Blueprint world and requires the same
  buildable count, configured manufacturer recipes, conveyor actors with exact
  reciprocal output-to-input component links, and physical power wires present
  in both endpoint components.

No world factory is placed during generation. The durable effect is a native
Blueprint file, so the action is a standalone committed write and is not placed
in the world undo journal.

For generated factory requests, production recursion stops at an item proven
to be extracted by a captured resource node/extractor or registered under the
catalog's `RawResources` descriptor path. An unlocked Converter recipe that can
also produce that item is not silently expanded. Existing surplus elsewhere in
the save is not subtracted from a Blueprint's requested standalone capacity.

## Placement

After game readback reports the generated file committed, ask:

```text
preview blueprint <exact generated name>
```

That uses the existing owning-client handoff to Satisfactory's normal Build
Gun. The player chooses the site, rotation, and final click in the vanilla
hologram. Terrain and external-factory collision are therefore tested at the
only meaningful time: against the actual destination.

## Topology contracts

Version 1 remains frozen and fail-closed. It serializes foundations, structural shell pieces, ordinary standalone
buildables, and configured manufacturers. It refuses rather than silently
drops all topology.

Version 2 adds:

- directed straight conveyor belts between two generated part ids. A missing
  connector name is allowed only when the source has exactly one free output
  and the destination exactly one free input. Endpoints must be collinear and
  facing each other; bends require explicit future poles/lifts rather than a
  guessed curve;
- physical power wires between generated part ids. Each endpoint must resolve
  to exactly one compatible circuit component with free capacity. Power poles
  are ordinary generated buildables, so a planner can explicitly fan out while
  the native component enforces its real connection limit.

Both are reconstructed from the saved file and read back before success. The
remaining fail-closed boundary is:

- pipes, pumps, junction topology, and fluids;
- conveyor lifts, poles, and non-collinear multi-leg routing;
- miners and Blueprint Resource Anchors;
- pieces whose validity depends on a separate snapped host.
