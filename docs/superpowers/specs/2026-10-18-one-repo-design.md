# One clean Satisfactory repo — design

Date: 2026-10-18 · Project 1 of 3 (2 = Team room portal, 3 = creative Architect research)

## Why

The owner wants Satisfactory to be "one clean organized repo, just like we did for
Civ 6": no gaps, no guesswork, and any model that plugs in later (Claude, Codex, a
local Ollama Qwen) can read one place and know exactly where the latest progress is.
Today the work is spread over ~20 folders in two unrelated Git histories, with
Codex's newest tunnel work sitting in a nested checkout that isn't on GitHub. The
owner also wants old folders that bloat the PC removed, Civ 6 included, **only when
nothing in them is still needed**.

This repo is also the foundation for project 2: the Team room portal and shared MCP
will live in it and point every model at it.

## Goals

1. One Git repo, `Smeagol69/ai-factory-copilot`, whose `master` holds every piece of
   unique work: the mod, the companion, and the MCP Lab (portal, MCP wiring, local
   model runner).
2. Start-here docs in the Civ 6 style, so a newly connected model can pick up the
   work cold.
3. One folder on disk for Satisfactory work, with the large local-only data kept
   beside the code and out of Git.
4. Every old Satisfactory and Civ 6 folder that is proven redundant goes to the
   Recycle Bin, so the space comes back once the owner empties it.
5. Everything that worked before still works afterwards: the hub, the four MCP
   servers, the game bridge, the mod build and all tests.

## Non-goals

- No new portal features. That's project 2. The existing hub only has to keep
  working from its new location.
- No rewriting or "improving" code while merging. Merges resolve conflicts and
  nothing more.
- No changes to the shared Agent Pair ledger or the encrypted credentials in
  AppData. They stay where they are.

## Anti-goals: failure even if it "works"

- Any lost work: an uncommitted file, an unpushed commit, a branch, or a save
  backup that existed nowhere else.
- Breaking a session Codex is actively running. Codex is running right now.
- Permanently deleting data. Claude only sends to the Recycle Bin; the owner empties it.
- Committing secrets, models, the SDK or game saves into Git.

## Current state (measured 2026-10-18)

**Mod repo (`ai-factory-copilot`), main clone `Documents/satisfactory`**
- 63 remote branches: 55 already contained in `origin/master`, 8 not.
- 19 linked worktrees under `Documents/satisfactory-*` (2–40 MB each).
- Uncommitted work: `satisfactory-codex-native-blueprints` (16 changed files),
  `satisfactory-hud-axis-rotation` (5 new untracked files: build-gun axis
  rotation).
- Separate clones inside the Lab at `workspaces/architect/*` (8 checkouts).
  `blueprint-force-save` has **11 commits not on GitHub** (tonight's tunnel work).
  `claude-transport-decode` has 2 changed files. Two clones use the local
  `integration` checkout as their origin.

**MCP Lab, `Documents/satisfactory-mcp-lab`** (separate history, no remote)
- Branch `codex/reference-learning-view`, 68 uncommitted changes (Codex's live work).
- `satisfactory-mcp-lab-review` is a clone of it and holds nothing unique.
- Size 33 GB, almost all local-only data:
  - `tools/satisfactory-sdk-513885`: 14 GB. Needed for mod builds.
  - `state/local-game-re/wwise-cache`: 13 GB. A Wwise SDK download cache.
  - `models/ollama`: 6.1 GB. The HauhauCS Qwen 3.5 9B the Lab chat uses.
  - Also `tools/java` (329 MB), `state/rea` (322 MB), and playtest evidence in
    `state/live-architect` (47 MB).
- Client configs (`.mcp.json`, `.codex/config.toml`, Copilot.exe) use absolute
  paths into this folder.

**Civ 6**
- `civ6-copilot` (master) is already the consolidated repo.
- 5 other clones (28 MB each); `civ6-copilot-claude-api` has 3 uncommitted files.
- `civ6-save-backup-20261014` is a save backup with no Git.

**Honest size note:** the old repo folders total under 1 GB. The real space is the
13 GB Wwise cache and possible duplicate models.

## Decided by the owner

- Follow the Civ 6 pattern: merge everything unique into one `master`, add
  STATUS/HISTORY/ARCHITECTURE/FEATURES docs, tidy the tree.
- Portal, MCP and model setup live in this repo (Satisfactory only for now).
- Old folders are removed once proven not needed, for both Satisfactory and Civ 6.
- Team for now: Claude and Codex on the owner's subscriptions, plus local Qwen as
  the backup. Paid API models are an "add later" option.

## The design

### 1. Coordinate before touching anything
Tell Codex through Agent Pair that consolidation is starting. Claim the
consolidation task. Wait for Codex to commit or hand off its in-flight work: the
68 Lab changes and anything else it reports. Work that Codex hasn't committed
gets committed on its own branch, with Codex as author context, before any merge.

### 2. Secure every piece of unique work first
- Commit each dirty checkout's changes to its existing branch as a "WIP preserved
  during consolidation" commit. This covers native-blueprints, hud-axis-rotation,
  claude-transport-decode and the Lab.
- Fetch all 8 Lab architect clones into the main clone as branches.
- Tag every branch tip as `archive/<branch>` before anything moves, so nothing can
  be lost even if a merge decision is wrong.

### 3. Merge into one master (the Civ 6 method)
- On a `consolidate` branch from `origin/master`, classify each branch:
  - **contained**: an ancestor of master, or its patches are already in it
    (`git cherry`).
  - **unique**: real work that isn't in master yet.
- Merge each unique branch, newest lineage first, starting with
  `codex/blueprint-force-save-513885`. It already contains
  `native-playtest-validation`.
- A branch whose work is clearly superseded by a later branch isn't merged. It's
  recorded in HISTORY with its archive tag and the reason.
- Bring in the Lab with its history: `git merge --allow-unrelated-histories` into
  a `hub/` folder (subtree style). The Lab's `docs/` merge into the repo `docs/`,
  its `AGENTS.md` into the root one.
- After every merge: run the companion test suite and the Lab test suite. They
  must stay green.

### 4. Layout

```text
satisfactory/                 (Documents/satisfactory, the one folder)
  README.md  AGENTS.md  CHANGELOG.md  Start Copilot.cmd
  Source/ Config/ Resources/ AIFactoryCopilot.uplugin    the mod
  companion/                  game bridge + blueprint tooling
  hub/                        portal app, MCP launchers, local model runner (was the Lab)
  scripts/                    install, build, validate, gen-docs, export-ledger
  docs/  STATUS.md HISTORY.md ARCHITECTURE.md FEATURES.md history/ superpowers/
  .local/                     gitignored: sdk/, models/, tools/, state/, runtime/
```

- The Lab's heavy folders move (same-drive rename) into `.local/`. Configs and the
  launcher stop using absolute paths. They resolve from the repo root, so the
  folder can move again later without breaking.
- The tunnel milestone evidence (`state/live-architect/tunnel-milestone`) is
  kept in `.local/state`. Its key proof files are summarised in
  `docs/history/tunnel-milestone.md`.

### 5. Docs (Civ 6 style)
- **STATUS.md:** start here. Latest progress (the tunnel POC: what's verified,
  what isn't), next steps in order, open owner decisions, the owner's rules, and
  the environment (game CL 513885, SDK, ports 8791/8792/8795, Ollama).
- **HISTORY.md:** phases, who did what, the consolidation record (every branch:
  merged / contained / superseded plus its archive tag), and an export of the
  Satisfactory Agent Pair ledger with claim tokens removed and personal paths
  and e-mails masked.
- **ARCHITECTURE.md / FEATURES.md:** generated from file comments and the action
  catalog, with a test that keeps them complete.

### 6. Reconnect everything
- Rewrite `.mcp.json` and `.codex/config.toml` for the new paths. Update
  Claude Code's and Codex's user-level MCP entries that point at the old Lab
  path, and rebuild or point Copilot.exe at the new location.
- Verify: the hub opens on 8795, the four MCP servers handshake (agent_pair,
  superpowers, rea, local_model), the bridge starts, the local model answers,
  the mod builds with the SDK at its new path, and all suites pass.

### 7. Clean up the PC
Only after steps 2–6 pass:
- `git worktree remove` each Satisfactory worktree. Send the 19 worktree
  folders, `satisfactory-mcp-lab-review` and the emptied Lab folder to the
  Recycle Bin.
- Civ 6: prove each of the 5 extra clones is contained in `civ6-copilot` master
  (same method; commit `civ6-copilot-claude-api`'s 3 files and merge them if
  unique), then send them to the Recycle Bin.
- **Kept:** `civ6-save-backup-20261014` (a save backup, irreplaceable) and the
  game's own save and blueprint folders.
- Anything too large for the Recycle Bin (Windows would delete it permanently)
  isn't deleted by Claude. It's listed for the owner to delete.

### 8. Publish
Push `master` and the `archive/*` tags to GitHub, then delete the merged remote
branches. This step only happens after the owner says yes, since it's outward-facing.

## Claude's calls (owner may override)

- The one folder stays `Documents/satisfactory`, the existing main clone. It isn't
  renamed.
- The Lab goes in as `hub/` with its Git history kept, rather than as a flat copy.
- Large data lives inside the repo folder under a gitignored `.local/`, not in a
  separate data folder, so there's one folder on disk.
- Branches that a later branch has superseded are archived as tags, not merged.
- Save backups are never auto-deleted.

## Open questions for the owner

1. **The 13 GB Wwise download cache:** delete it? It can be downloaded again
   later, but the mod build might want it if the SDK's Wwise plugin is ever
   reinstalled.
2. **Codex is running right now:** should Claude message it to pause and hand
   off before starting, or wait until it's idle?
3. **The HauhauCS model (6.1 GB):** keep it next to your main Ollama's Qwen 3 8B
   models, or drop it and use one Qwen?

## Notes from the builder check

- The Lab's `runtime/satisfactory-companion` and `runtime/agent-pair` are reviewed
  copies, not the repo's live `companion/`. Project 1 keeps that arrangement
  unchanged and only moves them to `.local/runtime`. Switching the hub to the
  repo's own companion is project 2's call.
- The hidden Ollama server and the hub on 8795 run from the Lab folder. Stop both
  before moving data, and restart them from the new location in step 6.
- `workspaces/` (the 8 nested clones) is emptied by step 2 and isn't recreated
  under `.local/`. Future worker checkouts are project 2's design.

## Left to the builder
Merge order within a lineage, conflict resolution, the exact names of WIP
commits, how the docs generator is implemented, and how `.local/` paths are
resolved.
