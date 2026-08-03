# Mod compatibility

## Automatically discovered

Mods using standard Satisfactory content and base classes are discovered
without hard-coded mod names:

- registered items and recipes
- buildables derived from `AFGBuildable`
- manufacturers derived from `AFGBuildableManufacturer`
- attached inventory, factory, pipe, and power components
- resource nodes derived from the base resource-node classes
- other mod-owned runtime actors, labeled `mod_actor`, when their class owner
  is discoverable even if they do not inherit a standard factory base class
- reflected non-transient runtime properties

Each registry entry includes its owner and registrar mod reference. Each actor
includes the plugin that owns its class path.

## Explicit adapter

Custom behavior may not be semantically recoverable from ordinary fields.
Examples include wireless logistics, programmable networks, dynamic recipes,
custom farming simulations, or transfers stored in a private subsystem.

Such mods can implement `IAIFactoryDataProvider` on their actor:

```cpp
int32 GetAIFactorySchemaVersion() const;
FString GetAIFactoryAuthoritativeDataJson() const;
TArray<FName> GetAIFactoryCapabilityTags() const;
bool IsAIFactoryDataComplete() const;
```

The returned JSON is placed under the actor's `adapter.data` field and marked
`source = explicit_mod_adapter`. Invalid JSON is reported, never interpreted.

For mods that cannot depend on AI Factory Copilot, a separate optional adapter
plugin should depend on both projects. SML's optional dependency mechanism and
soft references should be used so the adapter is absent safely when the target
mod is not installed.

## Compatibility levels

- **Native:** standard FactoryGame APIs provide complete relevant behavior.
- **Discovered:** registry, components, and reflection provide the data used.
- **Adapted:** an explicit provider supplies otherwise hidden semantics.
- **Partial:** authoritative fields exist but required semantics are unknown.
- **Unsupported:** no safe way exists to retrieve required internal behavior.

The scanner never upgrades `Partial` to `Discovered` based on names, meshes, or
visual similarity.

## Installed-mod test matrix

The development machine currently has representative mods installed including
ContentLib, FicsIt-Networks, Circuitry/Wiremod, Refined Power, Industrial
Evolution/MkPlus, Smart!, and numerous content-only architecture mods. They are
useful runtime fixtures, but compatibility claims require an in-game snapshot
and, for custom systems, an adapter review.

## Public-beta live test status

Compilation and synthetic tests are necessary but do not replace observing the
packaged mod in the game. As of 2026-08-03:

| Case | Status |
|---|---|
| whole-world capture, Insert panel, bridge round trip | exercised in a live save |
| teleport, highlight, single-building commit | committed and read back in a live save |
| Windows Shipping compile, cook, archive, deploy | passed against the official local Starter Project |
| waypoint placement/readback | committed in a live save; the new dynamic distance label compiles but still needs visual observation |
| `give_item` commit and undo | synthetic/compile coverage only |
| direct belt-route and compact belted-module planning | deterministic tests only; no conveyor write action exists yet |
| blocked and unaffordable placement | live observation required |
| rotation snapping and no-build-cost placement | live observation required |
| multi-action rollback and undo refunds | live observation required |
| blueprint proxy placement/undo | live observation required |
| modded recipe placement and adapter semantics | live observation and per-mod review required |
| multiplayer client/host and dedicated server | not yet validated |

Until every relevant row is exercised, the release remains a Windows-client
beta and must not be described as production-ready placement automation.
