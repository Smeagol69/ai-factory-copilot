# Restore a saved base through Copilot

The native restore path imports every packaged player-built actor and active
lightweight piece at its recorded absolute world XYZ, rotation and scale.
The source save is not edited. Map actors and progression are not copied.

## In the game

After the updated mod and companion are installed, load the destination save.
Enable Copilot write actions. Saved-base transfers charge no materials and work
with no-build-cost mode turned off; they do not change that setting. The original
base region must be clear and the required mods must be installed.

In the Copilot panel:

```text
check base chatgpt
restore base chatgpt
```

The game's chat equivalents are `/ai base check chatgpt` and
`/ai base restore chatgpt`. A check runs preflight only. A restore is one
server-side transaction and supports the existing `undo` command. A destination
with a HUB already built refuses importing a second saved HUB.
Prepare with `--exclude-hub` to leave out the source HUB and its integrated parts
while keeping the destination HUB. The owner's installed `chatgpt` package uses
this option.

No selection, aim point, terrain snapping, recentering or offset is used.
Coordinates come from the installed package, never from the language model.
The game reports the real result; chat-command diagnostics are written to
Saved/AIFactoryCopilot/Diagnostics/latest-base-restore.json.

## Package preparation

```powershell
node scripts/prepare-copilot-base.mjs --save <source.sav> --snapshot <catalog.json> --output <new-prepared-directory>
node scripts/compile-copilot-base.mjs <prepared-directory> <source.sav> <new-native-directory>
```

Install the native directory as
Saved/AIFactoryCopilot/BaseTransfers/chatgpt containing restore.json, actors.sbp
and actors.sbpcfg. These private actor archives are loaded by the restore action;
they are not movable Build Gun Blueprints.

The optional preparation flag `--exclude-hub` records all omitted HUB assembly
actors. Other saved coordinates are unchanged. A retained connection into an
excluded assembly refuses preparation rather than silently dropping that link.

The compiler retains saved actor/component properties and connections, redirects
internal identities, and reparses the result to compare every property, special
payload, trailing byte and transform. It keeps double-precision original
transforms beside the native actor archive's float transform headers. Native
loading identifies each actor by its exact archived class/transform and applies
the original transform before BeginPlay. Ambiguous identities refuse packaging.

Lightweight records load through AddFromBuildableInstanceData, including full
customization and the saved beam-length dynamic struct. Other dynamic struct
formats refuse explicitly. Dismantled slots are excluded. The engine's Designer
collection blacklist exception is scoped to this restore and unwound afterwards.

## Validation and limits

The native action checks server authority, package checksums, required assets,
map/build, target region, and original miner nodes before writes. It verifies
every created actor/instance transform, lightweight customization and beam data,
miner node and both endpoints of each saved power wire. Missing/extra pieces
cause rollback of the created buildables. Readback records actual transforms.
Existing destination pieces are excluded from proof and rollback.

Native circuit IDs and Blueprint proxy IDs are rebuilt for the destination.
The source's absent HUB locker reference is left to native initialization.
Saved inventories/properties remain in the actor archive, but arbitrary mod
behavior and post-load side effects have not been live-verified. Immediate
readback does not establish save/reload persistence or delayed conversion.
Do not claim a proven exact transfer until the packaged game reports success
and a destination save/reload has also been checked.
