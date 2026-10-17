# Copilot — Satisfactory MCP Lab

**Open Copilot.exe in this folder** for the single Windows entry point. It opens
the control room at <http://127.0.0.1:8795/> and reuses the same local server.
Keep the executable here; make a shortcut instead of moving it by itself.
The EXE compiled successfully. Its Node startup path and server reuse were
tested; automatic tool approval blocked direct EXE launch verification.

The control room shows MCP connections, REA analysis, engine readiness, task
claims and dated results. App startup makes zero paid model calls. A task claim
records responsibility, not proof of current reasoning. An autonomous project
coordinator has not yet been configured.

All new application files live here:

```text
Copilot.exe                 one user-facing entry point
app/                        control room and launcher source
runtime/node/               bundled Node.js 24.12.0 with license
runtime/agent-pair/         reviewed MCP runtime and real local dependencies
tools/rea/                  complete official REA package and locked dependencies
tools/ghidra/, tools/java/  portable native engines, when installed and verified
catalog/                   complete pinned Awesome-RE-MCP list and index
state/                     new logs, caches and dated analysis/check receipts
workspaces/                future worker and review checkouts
```

The live shared ledger and encrypted credentials remain in their existing
Windows app-data stores so current clients stay connected. Legacy game repos
and other agents' work are preserved. Consolidation covers this new application
and future checkouts, rather than blindly moving those existing repositories.

## Reverse engineering

The complete official [REA](https://github.com/morluto/rea) npm distribution is
installed as **rea-agents 6.5.0**, pinned by package-lock. Its real MCP handshake
exposed **207 tools**. A static JavaScript analysis recovered the owned fixture's
modules and import relationship, preserving explicit limitations and unknowns.
Findings are saved in `state/rea/`. A tool definition does not prove an optional
engine or live device/browser workflow is installed or usable.

REA's MCP and CLI share `scripts/rea.mjs`; default caches/temp/output stay in this
home and inherited API credentials are removed. Its complete published workflow
is `tools/rea/node_modules/rea-agents/skills/reverse-engineer-anything/SKILL.md`.

[Awesome-RE-MCP](https://github.com/crowdere/Awesome-RE-MCP) is a catalogue,
not an executable server. The entire original README is bundled at commit
`e400b882965ef61302718c7fe7c4f1e2861bd664`, with all **28 linked RE servers**
searchable in the app. They are labelled as requiring setup.

Developer commands:

```powershell
npm start                # same application startup without the EXE
npm run check:rea         # real bounded REA static analysis through MCP
npm run rea -- --help     # full installed REA CLI
npm run build:launcher    # rebuild the Windows launcher
```

The next game test for our current multi-model MCP system. This is a new local
project with its own Git history, MCP memory, claims and progress page.

The foundation is the existing **Agent Pair** runtime pinned at
`b727bebede1c7cdd025cc1a7f57981b3e7720beb`. It includes the verified file-tool
repairs and the full **Superpowers 7.0.0** package. The lab bundles that exact
source with local dependencies under runtime/agent-pair, preserving its original
repository. Its game adapter is the existing AI Factory Copilot
mod/companion in `../satisfactory`; no Civ VI game code is copied here.

```text
Claude / Codex
  -> Agent Pair MCP: tasks, memory, messages, review and recovery
  -> Superpowers MCP: planning, debugging, testing and verification skills
  -> this Satisfactory project: game-specific benchmark and evidence
  -> existing AI Factory Copilot companion/mod: authoritative game access
```

The last arrow is the next connection checkpoint. The companion on port 8142
was unavailable during setup. A health reply alone will not prove a loaded
save, successful game action, API allowance or model reasoning quality.

## Use it

From this directory:

```powershell
npm test             # local tests and real MCP catalog/context checks
npm run verify       # verify runtime/package; do not contact the game bridge
npm run status       # also read the existing bridge's localhost /health
npm run start:room   # start/reuse this project's hidden read-only progress room
```

The earlier read-only progress view remains at <http://127.0.0.1:8794/> for
compatibility. Routine use needs only the app on 8795. The runtime/Civ VI page remains on
8792. The new page reads this project's ledger; it deliberately does not label
the old coordinator's workers as a Satisfactory team. Shared MCP connection
heartbeats may still include other projects and are labelled accordingly.

Open this folder when starting future Satisfactory project work. Project-local
`.mcp.json` and `.codex/config.toml` register Agent Pair, Superpowers and REA
using bundled Node and their project-local launchers.
The launchers use absolute script paths so clients can start them from another
working directory. Restart native clients to pick up configuration. After moving this folder,
run `npm run configure` to regenerate those local paths. Global client settings
are unchanged. Codex loads project configuration for trusted projects, as
described in the [official OpenAI MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
The setup checks exercise MCP transport directly; a new native model session's
project-config uptake is a separate observation.

This project uses the existing shared Agent Pair database, partitioned by
`satisfactory-mcp-lab`; it creates no competing ledger. Credentials stay in the
existing secure store. Status and MCP startup do not issue paid inference,
deploy the mod, alter a save, install a scheduled task or start autonomous work.

## What comes next

1. Restore the existing Satisfactory companion connection without replacing
   another agent's work. Read the game's current collaboration notes first.
2. Pick one bounded task with an actual implementer, an independent reviewer,
   a fixed baseline and observable success checks.
3. Run it through our existing workflow, keep real usage and failure receipts,
   and distinguish offline checks from game-authoritative readbacks.

Changes to the game repository require its own claim, branch and tests.
Existing working features must be preserved. Installing skills does not train
model weights; progress is tested tools, retained lessons and measured tasks.
