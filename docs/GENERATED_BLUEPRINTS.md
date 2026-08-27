# AI-generated native Blueprints

This is the pipeline for creating a factory that does **not** already exist in
the world:

```text
live recipe/unlock snapshot
  -> deterministic production quantities
  -> measured/grid-aligned architecture and machine transforms
  -> aifactory.generated-blueprint/v1
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
- native colliding-component bounds are measured after construction scripts
  have run; machine/machine or machine/shell volumetric overlap refuses the
  archive, while native snapped structural contacts and a shallow machine/floor
  contact are explicitly classified;
- Designer membership is unwound and every staged actor is destroyed on every
  exit path;
- `SaveBlueprint` returning is not success. The native subsystem must refresh
  and read the named archive back from disk.

No world factory is placed during generation. The durable effect is a native
Blueprint file, so the action is a standalone committed write and is not placed
in the world undo journal.

## Placement

After game readback reports the generated file committed, ask:

```text
preview blueprint <exact generated name>
```

That uses the existing owning-client handoff to Satisfactory's normal Build
Gun. The player chooses the site, rotation, and final click in the vanilla
hologram. Terrain and external-factory collision are therefore tested at the
only meaningful time: against the actual destination.

## Initial topology boundary

Version 1 serializes foundations, structural shell pieces, ordinary standalone
buildables, and configured manufacturers. It refuses rather than silently
drops:

- conveyor belts/lifts and their component references;
- pipes, pumps, junction topology, and fluids;
- physical power wires;
- miners and Blueprint Resource Anchors;
- pieces whose validity depends on a separate snapped host.

Those are staged follow-ups. The existing native `.sbp` parser can already read
back conveyor, pipe, and power-wire topology, so each generator extension has a
clear acceptance gate: create native references, serialize, parse the resulting
file, and prove the exact reciprocal endpoints before exposing that topology to
normal factory requests.
