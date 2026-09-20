# Exact base restoration through AI Copilot

The owner wants one Copilot request to spawn the player-built base from
chatgpt.sav into another world, at every original absolute world transform.
Ordinary movable Blueprints and external save-editor imports do not satisfy
this request. Map actors, player state and progression are excluded.

## Current implementation boundary

`scripts/prepare-copilot-base.mjs` prepares the complete saved build set and
`companion/lib/base-transfer.mjs` validates its coordinate contract. **There is
no native restore executor yet. These files cannot currently spawn the base.**
The manifest deliberately says `can_spawn: false`. Preparation changes no game
files, source saves or destination saves. Do not register a model tool claiming
this is an implemented write action.

Preparation uses the existing pinned local parser:

```powershell
node scripts/prepare-copilot-base.mjs --save <chatgpt.sav> --snapshot <captured-catalog.json> --output <new-directory>
```

Outputs are `source-manifest.json` and `saved-build-state.json`. Each placed
piece has its original class, source identity, XYZ, quaternion and scale.
IEEE-754 double bytes accompany readable numbers, preserving signed zero and
detecting rounding. Source and saved-state payloads have SHA-256 hashes.
Owned components, referenced proxies and complete power circuits are retained.
Map references stay external identities. Missing references are reported.
Deleted lightweight slots are excluded even when their old transforms remain.

The earlier SCIM tooling is a development cross-check of the save scan, not the
requested delivery workflow. Its local artifacts remain separate. No `.cbp`
import is required or proposed for the Copilot feature.

## Native work required

1. Validate manifest, state digest, game/map/mod dependencies and destination
   occupancy server-side before any write. Resolve miners to recorded resource
   identities; never create replacement map nodes.
2. Serialize/restore the complete build graph. The CL502094 SDK constructor in
   `FGBlueprintSubsystem.cpp` lists Blueprint Designers among
   `mBlacklistedBlueprintCollectClasses`; the source contains one. Ordinary
   ExportSelection cannot be assumed to preserve the complete set. HUB ownership
   and the unresolved HUB locker reference need explicit handling.
3. Preserve native properties, component connections, customization and mod-owned
   assembly references. A recipe/coordinate loop is insufficient.
4. Apply saved transforms without recentering, terrain snapping, grid rounding
   or relative offsets. LoadStoredBlueprint exposes post-serialize and
   pre-BeginPlay callbacks, but their ordering and index meaning need native
   verification before relying on them for exact mapping.
5. Track every created actor/lightweight instance. Roll back incomplete restores
   without touching pre-existing destination pieces. Keep existing server,
   write, commit, revision and journal gates.
6. Read back the complete created set, including construction-generated pieces,
   and compare full transforms with multiplicity. verifyBaseSpawn rejects
   missing/extra pieces, duplicate runtime identities, rounded values and wrong
   coordinates. It proves geometry only; properties/connections need separate
   checks. Recheck after lightweight conversion and save/load.

Native writes are not implemented, compiled, deployed or live-verified by this
checkpoint. Offline parsing is not evidence of a working restore.
