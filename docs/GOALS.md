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
| Build Gun preview handoff | Codex | **needs a manual merge** — conflicts with the export contract |
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

`buildgun-preview` is **not** rebased. It conflicts with the export contract in
`companion/lib/actions.mjs` and `companion/lib/tools.mjs`, because both lanes
add an action kind to the same enum and the same tool description. The two
actions are complementary and both belong:

    enum: [..., "place_blueprint", "preview_blueprint", "export_native_blueprint", ...]

An automated resolution was attempted and produced a syntax error in
`actions.mjs` — the generic "keep both sides" fallback duplicated a code block.
It was aborted rather than committed, and the tree is clean. This one wants a
human-scale merge of the two `actions.mjs` validators, not a script.
