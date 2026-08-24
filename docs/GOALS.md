# What we are building, and the rules for building it

For Claude and Codex both. Read this before starting a lane. The noticeboard
(`ai-collaboration.md`) is the running log; this is the destination and the
standing rules, and it changes far less often.

---

## The product, in the owner's words

> "I want to go on SML, download this mod, and have an AI assistant and the
> ability to place anything in a Blueprint Designer with no restrictions, as
> well as save mega blueprints with dismantle mode for mega bases instead of
> slicing them up and building them in sections — just one big mega base
> blueprint. All incorporated into the vanilla game UI, alongside the ones I
> can make in game as of now."

Four things, and the fourth is what makes it a mod rather than a tool:

1. **An AI assistant** for questions and for optimising efficiency at all costs.
2. **An unrestricted Blueprint Designer** — anything goes in, including miners,
   at any size.
3. **Mega blueprints from a dismantle-tool selection** — mark a whole megabase,
   get one native blueprint. No slicing it into sections.
4. **Native to the vanilla UI.** The result must appear in the game's own
   blueprint menu next to hand-made ones, and place with the real Build Gun:
   hologram, snapping, rotation, click to commit. Not a bespoke panel that
   spawns buildings.

It has to install from SML like any other mod and be useful to someone who is
not us.

---

## The end state

The four points above are the shippable mod. This is what it is *for*, in the
owner's words, 2026-08-20:

> "Real time viewing of everything visually, internally full read and write of
> game. You are the game master and you can create me beautiful blueprints and
> use your creative skills and extensive knowledge to build something I request,
> and also fix inefficiencies like starting location — maybe something like *'I
> see you placed your hub here, there's only 1 iron node in 300m, if you moved
> to these coordinates you will be set up better in later game'* — stuff like
> that, like you're sitting right beside me looking over my shoulder."

The operative phrase is **looking over my shoulder**. Not a query interface. A
second pair of eyes that already knows what it is looking at and speaks up
without being asked.

That decomposes into four capabilities. They are listed in dependency order:
each one is worthless without the one above it, which is also the order to
build them in.

### 1. SEE — read everything, continuously

Status: **badly incomplete, and it was invisible until measured.**

Of the 51 buildable classes in one of the owner's buildings, the snapshot could
see **11** and was blind to **40**. `AIFactorySnapshot.cpp` iterates
`TActorIterator<AFGBuildable>`, and foundations, walls, pillars, catwalks,
railings and roofs are not actors -- they are instance data owned by
`AFGLightweightBuildableSubsystem`. Every claim this mod has ever made about
"what is in your world" was made from the wiring while calling it the building.

This is the same blindness that made the blueprint export capture a building's
poles and ladders and none of its shell. That was fixed in the exporter on
2026-08-20; the snapshot fix is written and pending a build.

Still missing after that: measured production rates per machine (the snapshot
has `connections` and `inventories` but nothing that says "this smelter is
running at 84%"), and a structural `.sbp` parser so blueprints can be read as
geometry rather than counted as strings.

### 2. UNDERSTAND — know what the reading means

Status: **strong, and the strongest part of the project.**

Every snapshot carries 4,040 recipes and 3,692 items pulled live from the
owner's install, with `duration_seconds`, `ingredients`, `products` and
`produced_in`. Exact ratios are arithmetic on that, and being live means they
are correct for all 51 active mods -- which a hardcoded ratio table could never
be. `companion/lib/efficiency.mjs` does that derivation.

**What is hardcoded, and why only this:** `companion/data/efficiency.json`
holds what the game does *not* expose as structured data -- belt and lift
throughput (stated only as English prose inside item descriptions), the
overclock power curve (an engine constant that appears nowhere), and
manifold-versus-balancer practice (community knowledge that no recipe data
implies). The transport table was seeded from the owner's own install rather
than recalled, which is how Conveyor Belt Mk.6 at 1200/min got into it: a
modded tier that does not exist in vanilla and that any table written from
memory would have silently missed. A test cross-checks the table against those
descriptions every run, so a patch that changes a tier fails a test instead of
quietly producing wrong plans for months.

Machine footprints are deliberately **empty** rather than filled with recalled
numbers. Every buildable in a snapshot carries a real measured `bounds.extent`,
so they get derived from the owner's world -- modded machines included.

### 3. SPEAK UP — volunteer, do not wait to be asked

Status: **zero. This is the gap between what exists and what was asked for.**

Everything in this mod today is request-response. Nothing has ever volunteered
anything.

The nervous system is already built and unused: `AAIFactorySubsystem` runs
`ObserveWorld` on a timer, computes a `WorldFingerprint`, calls
`MarkWorldDirty()` when the world changes, and holds an `OnActorSpawned`
handler that fires on every single placement. It detects change and does
nothing with it. There is no brain attached to it.

The hub example is a good test case because it needs every layer at once:

    detect the placement          HandleActorSpawned          exists
    find nearby resource nodes    AFGResourceNodeBase in      exists
                                  the snapshot
    score this site vs others     assessMegabaseSite()        exists
                                  in megabase.mjs
    say it unprompted             -                           does not exist

Three of four already work. The missing piece is a channel that speaks without
being spoken to, plus the judgement to do it rarely -- an assistant that
comments on every foundation is one the owner turns off in a day. The bar:
**only speak when the observation is worth an interruption, and when it is
still cheap to act on.** A hub critique is worth it in the first hour and
worthless after fifty hours of building around it.

### 4. BUILD — write things worth looking at

Status: **the mechanism landed by accident, and has not been used yet.**

There are ~4,200 lines of planners already (`planStructure`, `planTower`,
`planEnclosedFactory`, `planCoalPower`, `planComposition`, `planModularShell`,
`megabaseFootprint`). They all emit *placement actions* -- one building at a
time through holograms -- which is the fragile path: clearance failures, Z
drift, and ad-hoc belts that still do not connect.

`FScopedMaterialisedInstances`, built on 2026-08-20 to fix the pillar bug, is
in substance *"spawn arbitrary buildables inside a designer and serialise
them"*. Point it at computed transforms instead of existing instance data and
it is a blueprint generator. That route has no holograms, no clearance checks,
no Z drift, undo is deleting a file, and **the game's own loader rewires the
belts on placement** -- which is already why belts inside blueprints work when
ad-hoc ones do not.

So: planner -> geometry -> spawn in designer -> `SaveBlueprint` -> the owner
places it with the vanilla Build Gun. Every planner should be rerouted through
that instead of through live placement.

**On "beautiful", honestly.** Efficiency is a solver problem and is close to
solved. Aesthetics is not, and pretending otherwise would be dishonest. Claude
cannot see the game and has no taste of its own to apply to it. What is
achievable is learning the owner's: their builds are genuinely well-made, and
once a `.sbp` can be parsed structurally their own library becomes the style
vocabulary -- spacing conventions, which beam goes with which wall, where
railings and catwalks run. That is imitating a taste that demonstrably exists,
not inventing one.

### The order, and why

1. **Snapshot sees lightweight** — written, pending a build. Nothing above it
   is worth doing while four fifths of the world is invisible.
2. **`.sbp` structural parser** — unlocks reading the owner's style *and*
   verifying generated output. Companion-side, no build cycle, no crash risk.
3. **One planner rerouted to blueprint output** — `planCoalPower` is the
   tightest and the easiest to check against known ratios.
4. **Measured rates, then the proactive channel** — advice that has never been
   checked against a running factory is arithmetic, not observation.

---

## The key architectural finding

Verified against the CL 502094 headers, and it is the reason this is possible:

**The blueprint restrictions are enforced at capture time, not at placement
time.**

- `AFGBlueprintHologram` validates nothing. No dimension check, no content
  check, no extractor check. Its surface is `SetBlueprintDescriptor()` and
  `LoadBlueprintToOtherWorld()`. It replays what the file says.
- `AFGBuildable` has **no** per-buildable "can be blueprinted" flag, and
  `FGResourceExtractorBase` does not opt out of anything.
- The miner "ban" is therefore not a blueprint rule at all. It is
  `FGCDNeedsResourceNode` plus the fact that there is no ore inside a Blueprint
  Designer box: you cannot *build* a miner in there, so you cannot capture one.
  Nothing forbids an `.sbp` from *containing* one.
- The size cap is `mDimensions` on the designer *buildable* — it bounds what
  fits in that physical box. Nothing consults it when placing.

So the work is in **writing the file**, not in defeating the game's rules.

### Active-session Blueprint truth

The disk library is intentionally broader than the game library: it can retain
blueprints from several saves, which is useful for read-only structural
inspection and style study. The native Build Gun is narrower: it may only arm a
descriptor registered by Satisfactory's `AFGBlueprintSubsystem` for the active
save session. The scanner reads and records that authoritative descriptor
registry without a stateful refresh on ordinary chat requests, so it cannot
replace the player's current Build Gun selection. The bridge refuses a
disk-only entry before it sends the Build Gun handoff; only the server and
owning client refresh immediately before the preview lookup the player asked
for. A partial registry is explicit unknown, never evidence of absence.

That means a blueprint from another session remains readable but is never
silently copied, fabricated, or claimed previewed. Explicit cross-session
import is a future, separately-confirmed file operation; it is not a side
effect of preview.

### The doors that are open

| What | Where | Why it matters |
|---|---|---|
| `FBlueprintArchiveObjectDataProxy` | `BlueprintArchiveObjectDataProxy.h` | `FACTORYGAME_API`, ctor `(FArchive&, UWorld*)` — the actual serialiser, usable from a mod |
| `AFGBlueprintSubsystem::WriteFileToDisk` | `FGBlueprintSubsystem.h:197` | generic `(name, extension, TArray<uint8>)` writer |
| `RefreshBlueprintsAndDescriptors()` | same, :146 | `BlueprintCallable` — makes the library notice a new file |
| `SetActiveBlueprintHologramDescriptor()` | same, :165 | `BlueprintCallable` — hands a descriptor to the hologram |
| `AFGBuildGun::SetDesiredBlueprint` / `GotoBuildState` | `FGBuildGun.h:403` / `:374` | puts a blueprint in the player's real Build Gun |
| `GetBuildablesInBlueprintDesigner()` | `FGBuildableBlueprintDesigner.h:161` | const getter; `mBuildables` at :236 has **no setter** |

### The one unknown that decides the shape of everything

**When `AFGBlueprintHologram` places a blueprint whose contents include a
miner, does the child extractor hologram bind to a real node underneath?**

If yes: mega blueprints with miners work exactly as the owner wants — position
over a node, click. If no: miners stay on the saved-design path and everything
else rides the Build Gun.

Nothing in the headers answers it. It needs one real `.sbp` containing a miner.
Answer this before building anything large on top of an assumption.

### Runtime placement evidence gate

The game now has a narrow evidence path for settling that question safely. Aim
at a *placed* native Blueprint proxy or an actor-backed member and ask
`audit this blueprint` (or ask whether its miner is bound). The scanner reads
the proxy's public readiness state, actor/lightweight member counts, and each
actor-backed extractor's actual `GetExtractableResource()` relationship. A
miner is reported **bound** only when the game supplies a valid extractable
interface and resource descriptor. A proxy still replicating is never treated
as an empty Blueprint, and a null client-side extractor binding remains
**unknown**, not "unbound". If the game's usable hit is the resource node under
a miner, the auditor preserves that normal target and uses the camera-visible
miner only as a separate read-only witness.

This is proof tooling, not a workaround: it never places, binds, repairs,
exports, imports, costs, or dismantles anything. A disposable real-miner
Blueprint placement still needs to pass this audit after a packaged live test
before the project can claim that miner Blueprint placement works.

### Experimental native Designer miner anchor (2026-08-23)

The missing Designer-side resource target now has a narrow source-level
extension: **Blueprint Resource Anchor**. It is not a generic bypass for
extractors.

- The anchor is a normal `AFGBuildable` root, so the Designer, native archive,
  proxy ownership, costs, dismantle path, and final Build Gun placement remain
  Satisfactory-owned.
- It creates a transient, real `AFGResourceNode` child configured with one
  explicitly chosen solid resource and purity. The native Miner Mk.1–Mk.3
  hologram still has to hit that node, satisfy its ordinary resource-form,
  occupancy, cost, and construct-disqualifier checks, then bind itself through
  Satisfactory's normal extractor setter.
- The persisted Blueprint holds configuration plus the exact anchor-to-miner
  object relationships. Before either native Blueprint archive writing or a
  normal world save it uses the engine's full
  `DisconnectExtractableResource()` path and verifies both the modern and
  legacy pointers read back null before recording a temporary restoration; it
  restores the live Designer binding afterward.
  On loading into a Designer or into the placed world, it recreates the
  transient node and rebinds only those recorded miners—never a nearest-node
  or nearest-miner guess.
- The Designer opt-in is limited to `Build_MinerMk1_C`, `Build_MinerMk2_C`, and
  `Build_MinerMk3_C`. It does not enable portable miners, pumps, oil extractors,
  fracking, or modded extractor classes.

The implementation has an exact CL 502094 Shipping compile and source-contract
coverage. It is deliberately **not yet called working**: the required packaged
disposable-save proof is Designer placement → Miner snap → archive write →
Designer reload → native Blueprint placement → extractor binding audit →
save/reload → dismantle, plus a host/client Designer check. The game must be
closed before the new DLL can be packaged and deployed for that test.

### Creative world-editor nodes

"Place a node anywhere" is possible safely only as **mod-owned creative
content**, not by moving Coffee Stain's map nodes. Vanilla resource nodes are
explicitly static replicated actors; moving one in place would violate their
replication and map-manager lifecycle. The editor therefore has two distinct
rules:

- Existing vanilla nodes can be inspected and can use the game's reversible
  resource-class override, but are never moved, deleted, or adopted.
- A future `AI Factory Copilot Creative Node` is a concrete mod-owned,
  saveable, replicated resource-node actor. It will be spawned at its final
  transform after terrain, collision, spacing, ownership, and resource-form
  checks; it will save its own resource/purity/amount configuration; and it
  can later be moved only by verified spawn-replacement or removed only when
  unoccupied.

The native Build Gun supports generic actor descriptors and holograms, so the
creative node can become a real hologram/click placement tool rather than a
chat-only spawn. That custom descriptor/recipe must be packaged and registered
before a save loads. There is no verified public way to inject dynamic nodes
into the vanilla `AFGResourceNodeManager` or resource scanner, so those remain
explicitly unsupported until independently proven; a Copilot marker is the
safe map fallback. The staged proof is: preview → one server-spawned node →
Miner Mk.1 attachment/output → save/reload → host/client replication → native
Build-Gun wrapper → actions/undo.

---

## Standing rules

These are not style preferences. Each one is here because breaking it cost us.

**Never guess an engine API.** Verify against the CL 502094 headers in
`D:\Modding\Satisfactory\StarterProject-502094`, then compile. Three separate
inventions — `FString::FindSubstring`, a `TSharedRef`/`nullptr` ternary, and a
resource-node clearance rule — each cost a build cycle or a wrong diagnosis.
The Starter Project's `.cpp` files are **stubs** (`{ return bool(); }`); only
the headers are real.

**The game is the authority.** Propose, let it adjudicate, report what it says.
Do not pre-refuse on an inferred rule. A clearance rule invented from one
misread failure turned a buildable design into an unbuildable one.

**Unknown stays unknown.** If something cannot be determined, say so. Never
fill a gap with a plausible number. `requested_z_reached` exists precisely so a
claim can be checked instead of asserted.

**Measure, do not remember.** The drift table was quoted from memory for weeks;
when finally measured, the figures were right but the *explanation* was wrong
twice over. `scripts/read-placement-drift.mjs` and
`scripts/explain-placement-drift.mjs` exist for this. So does
`routing.jsonl` — 512 real questions with an `answeredBy` on each, which found
more routing bugs in an hour than three sessions of reading patterns.

**Never erase progress.** Improve, optimise, add. Do not remove a working
feature unless explicitly asked. This applies to each other's work.

**Never touch `D:\Modding\Satisfactory\StarterProject-502094` while the game is
running, or while the other agent has claimed it.** Announce on the noticeboard
first. Two concurrent builds produce `LNK1104`.

**Watch the escape-collapse trap.** Writing source through a shell heredoc eats
backslashes: `\s+` becomes `s+`. It cost an entire route — `clear holograms`
never fired once. Two guards now exist (`collapsed-escapes.test.mjs` for the
deleted-backslash form, the control-character test for the 0x08 form). Write
through a file, or `String.fromCharCode(92)`.

**Work that cannot be reached does not exist.** Four solvers were written,
tested, exposed as tools, and unreachable by asking. `parseLibraryPageRequest`
was exported and never called. Four tests now guard this class:
`solver-coverage`, `capabilities`, the README phrase check, and the library
page's button check.

**Keep the bridge and the mod in lockstep.** A version mismatch is a live
outage. Re-fetch before changing a shared contract.

---

## Lanes

Claim on the noticeboard before starting. Do not edit another agent's file
without disclosing the crossing.

| Lane | Owner | State |
|---|---|---|
| Native `.sbp` exporter | Claude | **working** — 94 buildings exported and placed |
| Build Gun preview handoff | Codex | **integrated and contract-covered** — client-only native Build Gun handoff; visual in-game proof remains pending |
| Exact world-editor selection overlay | Codex | **source complete** — accurate actor + lightweight bounds to 2,048 pieces; above that, an exact selection volume and explicit condensed status rather than a deceptive partial preview |
| Unrestricted designer | open | may be unnecessary now the exporter works from the world |
| Router / companion | Claude | 710 tests; web library removed, box preview added |
| Placement C++ | Claude | Z fix proven live |
| SML packaging | open | last |

---

## Progress, and what is actually proven

**Proven live, measured.**

*Placement heights.* 974.7 cm of drift down to 1 cm, in the owner's save. A
Smelter whose terrain sat 13.8 cm below its requested height landed at
asked+1 rather than surface+1, so the override beat the trace. The residual
1 cm is a constant pivot offset, uniform, so relative heights are exact.
`snap_accepted` is false on every drifting placement, so snapping was never
the cause.

*Mega blueprints.* **94 buildings exported as one native `.sbp` through an
MK2 designer and placed with the vanilla Build Gun.** `adopted 94, skipped 0`,
`designer_left_empty: true`, `blueprint_readable_from_disc: true`,
save_version 2, changelist 502094. The size cap does not apply because the
buildings are never in the box — the designer is borrowed as a serialiser and
told to forget them again before the call returns.

*Belts inside blueprints.* Fixed by consequence, not by design. Internal
belts are serialised into the archive and rewired by the game's own loader,
so they never touch our `place_belt` path. That bug is bypassed rather than
fixed — but for the megabase workflow it is bypassed completely.

**Compiles and loads:** `1.0.0-beta.2` against CL 502094, clean, no ensures.

**Deployed but not exercised in a save:** the measured Z correction for
self-offsetting holograms, the box preview selection, the belt endpoint
diagnostics, `snapped_building`, the wall-hole ordering fix.

**Known open faults.**

- *Conveyor attachments mount a metre up.* A Conveyor Merger came back
  +101 cm twice with `snap_accepted: false` and `snapped_building: "none"` —
  a constant self offset, not a snap. A measured single-pass correction is
  deployed and untested.
- *A conveyor chain crash, unattributed.* `EXCEPTION_ACCESS_VIOLATION` in
  `AFGConveyorChainActor::Factory_Tick` on a worker thread, 34 minutes after
  an export, **no AIFactoryCopilot frame on the stack**. Could be the
  adopt/release cycle touching live belts, could be the placed blueprint's own
  wiring, could be one of 25 other mods. The test that separates them is an
  export from a selection containing no belts.
- *Ad-hoc belts* still fail with
  `constructed_belt_endpoints_did_not_match_requested_components`. Only
  belts *outside* a blueprint are affected.
- *Attachments needing a host* work when the host is in the same selection
  and ordered first; a wall hole whose host is absent has nothing to snap to.

**The archive records the designer's dimensions, not the content's** — 5x5x5
for 94 buildings. It placed correctly anyway, consistent with the hologram
validating nothing, so the field looks like menu metadata. Untested at larger
spreads.

**Two crashes caused by me, both recorded on the noticeboard rather than
tidied away.** `SetInsideBlueprintDesigner` is construction-time only and
asserts on a live buildable; it would also have written a `SaveGame` field
onto the owner's factory permanently. Public, matching signature, and a clean
compile told me nothing about *when* the call was legal.


## The rebase Codex needs to know about

All three Codex branches were 26–28 commits behind master. Merging them as-is
reverts the Z fix, the belt diagnostics and `snapped_building` —
`codex/buildgun-preview` shows `AIFactoryActions.cpp −138 lines`, which is
branch divergence, **not** deletion by Codex.

Two lanes are already rebased onto `integrate/codex-blueprint-lanes`:

- `native-blueprint-designer` — clean, lightweight proxy readback intact
- `native-blueprint-export-contract` — one noticeboard conflict, resolved by
  keeping both claim rows

The former `buildgun-preview` feature branch was deliberately not rebased: it
conflicted with the export contract in `companion/lib/actions.mjs` and
`companion/lib/tools.mjs`, because both lanes added an action kind to the same
enum and the same tool description. Its compatible runtime implementation is
now integrated with the export contract; the route, standalone-action guard,
and verified public-header/source contracts are covered by regression tests.
The two actions remain complementary:

    enum: [..., "place_blueprint", "preview_blueprint", "export_native_blueprint", ...]

An automated resolution was attempted and produced a syntax error in
`actions.mjs` — the generic "keep both sides" fallback duplicated a code block.
It was aborted rather than committed, and the tree is clean. This one wants a
human-scale merge of the two `actions.mjs` validators, not a script.
