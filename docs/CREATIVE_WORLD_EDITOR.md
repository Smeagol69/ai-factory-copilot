# Creative Resource Nodes — native world-editor foundation

This is the first deliberate world-editor capability in AI Factory Copilot. It
lets a player create a **new, mod-owned infinite solid resource node** anywhere
the normal Satisfactory Build Gun accepts its hologram. It is not a shortcut
that spawns an invisible actor, and it never moves, replaces, registers, or
deletes a vanilla map node.

## Player workflow

In native Satisfactory chat, or directly in the Copilot panel opened with
Insert, use:

```
/ai node place copper ore pure
```

The final purity word is optional (`impure`, `normal`, or `pure`; normal is the
default). This is a real world write, so `allowWriteActions` must be enabled in
the mod configuration first. In multiplayer, only a Satisfactory server admin
can arm the shared editor. The server validates the selected live resource
descriptor, then asks the requesting client's normal Build Gun to enter the
Creative Resource Node recipe. The player still sees Satisfactory's own
green/red hologram and must confirm placement normally. A placement only occurs
through the Build Gun's normal server construction route.

The Insert panel forwards only this exact `/ai node place …` form through SML's
existing reliable server chat-command RPC, then closes so the Build Gun can take
over. It does not execute commands locally, forward any other slash command, or
claim that placement succeeded; Satisfactory's native chat reports the server's
actual arming result.

The existing `/ai node <resource>` command uses the same world-editor
write/admin gate before it changes either a previously created Creative
Resource Node or an ordinary, unoccupied vanilla map node. It explicitly
refuses deposits, geysers, fracking nodes, and transient Blueprint Resource
Anchor runtime nodes: those actors have their own game or saved-Anchor
configuration and must never be retargeted through the generic override path.

`/ai node` lists registered solid resources. The list comes from the live
Recipe Manager's complete descriptor catalogue, so it includes installed mods
and does not depend on a matching map node being nearby. If two descriptors
have the same display name, their unqualified alias is deliberately withheld;
the list supplies a class-qualified choice instead of choosing one by iteration
order.

For an unoccupied Creative Resource Node already in the world, aim at it and
use the existing command:

```
/ai node <resource>
```

That reconfigures the node through its own saved configuration and retains its
chosen purity. `original` remains deliberately unavailable for a creative node:
there is no vanilla map original to restore.

## What the game validates

The implementation uses the exact non-buildable native seam:

```
UFGBuildDescriptor → AFGHologram → normal Build Gun server construction
```

The constructed actor is a concrete `AFGResourceNode` child. It has a
mod-owned collision root, clearance bounds, deposit visual, saveable
configuration, replication, and a post-load readback. Its resource, purity and
infinite amount must all survive Satisfactory's own getters before it becomes
mineable. A malformed saved or replicated configuration becomes inert rather
than silently producing a resource.

The editor accepts only resource descriptors that are:

- registered by the running game;
- `UFGResourceDescriptor` subclasses with solid form; and
- supplied with a real deposit mesh.

That last check is intentional: a modded descriptor with no deposit mesh is
refused rather than creating an invisible mineable box. Hologram clearance and
an additional resource-node separation check reject invalid/overlapping sites
before server construction. Re-arming the same universal recipe updates the
current local hologram rather than reusing its previous resource choice. If
the player has already clicked a placement and its normal construction message
is pending, the editor deliberately leaves that clicked placement alone: wait
for it to complete, then re-arm the Build Gun. A new command must never mutate
a placement already in flight.

Every successful creative node is already present in the ordinary authoritative
snapshot as `kind: resource_node`, with its exact actor id, class/owner mod,
XYZ, resource, purity, amount type and occupancy. Existing solvers therefore
see it as a normal miner-hostable node without special guesswork.

## Boundaries of this first layer

- Nodes are static after placement, just like Satisfactory's resource-node
  contract. They are not draggable world-editor handles.
- This layer supports solid extractor nodes only. Water, oil, gas, fracking,
  map/scanner registration, and map representations have distinct engine
  systems and are not claimed here.
- Generic `/ai node <resource>` retargeting is limited to ordinary,
  unoccupied vanilla `Node` actors. It does not alter deposits, geysers,
  fracking actors, or Blueprint Resource Anchor runtime nodes. A creative node
  keeps its own saveable configuration, while an Anchor is configured only by
  its saved buildable root.
- There is no delete/undo command yet. It will be limited to unoccupied,
  mod-owned creative nodes and require an explicit confirmation; it will never
  be widened into vanilla-node deletion.
- The first UI is the chat-to-native-Build-Gun handoff. A Build Gun category,
  resource/purity picker, and direct Copilot-panel action are follow-on UX,
  not hidden behind a claim that they already exist.
- Remote-client receipt of a newly granted recipe/schematic must be live tested.
  The server chat response says the client arming was *requested*, not that it
  succeeded, until the player sees the actual hologram.
- The universal recipe/schematic availability is persisted at world/save scope
  after its first authorized use; it is not a per-player entitlement. The
  command gate is intentionally explicit: writes must be enabled, and server
  admins arm the editor in multiplayer. This layer must not be repurposed as a
  general player-permission system.

## Required live proof before release

The source and Node tests are not a substitute for a packaged game test. When
the game is closed, build and package the branch, then prove in a disposable
save:

1. Place a Copper Ore normal node on clear terrain; verify exact snapshot XYZ,
   class/owner, resource, purity, infinite amount and a Miner Mk.1 snap.
2. Re-run the command with a different resource/purity while its hologram is
   active; prove it changes the existing preview rather than placing the old
   selection.
3. Attempt an overlap/blocked placement and prove the native hologram rejects
   it without spawning an actor.
4. With writes disabled, prove `/ai node place` has zero schematic, recipe, or
   actor effect. In multiplayer, prove a non-admin is refused, then prove a
   server admin can arm and place the node.
5. Save/reload and prove the node's configuration, visible deposit, miner
   behaviour, and the world-level recipe availability remain intact.
6. Click a placement, immediately request a different resource, and verify the
   already-clicked node retains its original resource while the later re-arm
   works only after the Build Gun is idle. Also cancel a freshly armed preview,
   switch recipes, and unequip the Build Gun before placement; then arm it
   again and prove no stale local choice survives.
7. Retarget an unoccupied creative node and verify `original` refuses; retarget
   an ordinary vanilla node and restore it. Attempt the generic command on a
   Blueprint Anchor runtime node, deposit, geyser, and fracking node; each must
   refuse without changing its saved/resource configuration.

Until all seven are recorded from the packaged build, this is a verified source
implementation awaiting live proof—not a claim of a shipped editor.
