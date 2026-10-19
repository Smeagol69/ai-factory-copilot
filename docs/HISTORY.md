# History: how the project got here

Read [STATUS.md](STATUS.md) first for where things stand now. This file is the
record: phases, who did what, and what happened to every branch and folder in
the 2026-10-18 consolidation.

## Who

- **Owner:** sets goals, approves releases, play-tests in the game.
- **Claude** (Claude Code) and **Codex** (OpenAI): built the mod, companion,
  Architect and hub. They coordinated through git, `docs/ai-collaboration.md`
  (the claim/handoff log since July), and from 2026-10-16 the Agent Pair ledger
  (exported to [history/ledger/](history/ledger/)).
- **Google (Gemini)** and the **local HauhauCS Qwen** model: reviewers in the hub's
  team work from 2026-10-17.

## Phases

| When | Commits | What |
|---|---|---|
| 2026-07 | 58 | First release (`1.0.0-beta.1`, 08-03): world scanner, versioned snapshots, localhost companion, deterministic production solvers, model routing, in-game panel |
| 2026-08 | 387 | `1.0.0-beta.2` (08-16). Blueprint reading and generation, native blueprint export contract, Build Gun preview, creative resource nodes, power topology, megabase design concepts |
| 2026-09 | 181 | Precision reference frame and build-gun axis rotation (owner live-verified 09-13), capture integrity, exact base transfer with a live 1307-piece restore (09-22), Architect previews, hall frames, enclosures, access portals, structural tools |
| 2026-10-01 → 10-16 | | Exact world transfer and combined AIO/clock package (10-11), typed structural Architect revisions (10-16). The **MCP Lab** started 10-16 as a separate repo: one control room, Agent Pair + Superpowers MCP, REA reverse engineering, HauhauCS local model |
| 2026-10-17 → 10-18 | | Native playtest validation and exact blueprint readback, reference traits and transport decoding, native force-save repair, then the **curved level tunnel POC** (see STATUS.md) |
| 2026-10-18 | | Consolidation into this one repo (below) |

The full commit list is `git log`; the per-change claims and handoffs are in
`docs/ai-collaboration.md` and the ledger export.

## Consolidation (2026-10-18)

Owner request: "make all the various files random folder all consolidated just
like we did for civ 6 one clean organized repo … send all to repo that need to
be there so anyone can open repo any model and know exactly whats going on
nothing missing". Design and plan:
[superpowers/specs/2026-10-18-one-repo-design.md](superpowers/specs/2026-10-18-one-repo-design.md),
[superpowers/plans/2026-10-18-one-repo.md](superpowers/plans/2026-10-18-one-repo.md).

### Before

- `Documents\satisfactory`: main clone of this repo, with 19 linked worktrees
  `Documents\satisfactory-*`, 63 remote branches.
- `Documents\satisfactory-mcp-lab`: separate repo (no remote), the hub, 33 GB
  with local data, plus 8 nested clones of this repo in `workspaces/architect/`.
  One of them (`blueprint-force-save`) held 11 tunnel commits never pushed.
- `Documents\satisfactory-mcp-lab-review`: a clone of the Lab.

### What was done

1. Every uncommitted change was committed in place as "WIP preserved during
   consolidation" (the Lab 68 files, `native-blueprint-designer` 16 files,
   `buildgun-axis-rotation` 5 files, `claude-transport-decode` 2 files).
2. Every branch tip, local and remote, got an `archive/<branch>` tag (81 tags).
3. Merged: `codex/blueprint-force-save-513885` (22 commits: force-save repair,
   reference traits, readback, playtests, explicit height, undo, curve refinement,
   lighting, fitted fixtures). Companion suite 1352/1352 after.
4. The Lab merged with its full history as `hub/`. The hub now reads the game
   source and Architect compiler from this repo. Its local data (runtime, models,
   state, SDK) moved beside it and stays gitignored. The missing REA package files
   were restored from the Lab's previous commit. Hub suite 168/168.
5. The Satisfactory part of the Agent Pair ledger was exported to `history/ledger/`.

### Every branch with work not in master before consolidation

| Branch | Decision | Why |
|---|---|---|
| `codex/blueprint-force-save-513885` (+11 local) | **merged** | the latest work |
| `codex/native-playtest-validation`, Lab `integration`, `claude/architect-reference-traits`, `codex/architect-reference-traits-review`, `codex/architect-transport-review`, `claude/architect-structural-adapter`, `codex/architect-structural-review` | contained | all their patches are in the merged branch |
| `claude/architect-transport-decode` WIP | superseded | earlier draft of the reviewed transport decoder and test in master |
| `codex/buildgun-axis-rotation` WIP | superseded | earlier, smaller draft of the rotation code master has (master's version is larger and has a contract test) |
| `codex/native-blueprint-designer` (+ WIP) | superseded | August beta.3 export draft; master has Build Gun preview and the full native export in `AIFactoryBlueprintExport.cpp` |
| `codex/buildgun-preview`, `codex/native-blueprint-export-contract` | contained | same changes in master under new hashes (`54f41ac`, `56aee63`) |
| `codex/creative-resource-node` | contained | all 30 files present in master |
| `codex/creative-node-runtime-compat` | contained | the geyser fix is in `AIFactoryNodeEdit.cpp` |
| `codex/blueprint-power-topology` | superseded | a one-line claim note, no code |
| other 55 remote branches | contained | ancestors of master |

Anything marked superseded is one `git checkout archive/<branch>` away.

### After

One folder, `Documents\satisfactory`, on branch `consolidate`. The old worktrees,
the Lab folder and its review clone were removed (Recycle Bin) after checking
nothing unique was left in them.
