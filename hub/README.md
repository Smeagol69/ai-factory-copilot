# Copilot — Satisfactory MCP Lab

**Open Copilot.exe in this folder** for the single Windows entry point. It opens
the control room at <http://127.0.0.1:8795/> and reuses the same local server.
Keep the executable here; make a shortcut instead of moving it by itself.
The EXE compiled successfully. Its Node startup path and server reuse were
tested; automatic tool approval blocked direct EXE launch verification.

## Talk directly to your local model

Open Copilot and choose **Chat with HauhauCS**, or use
<http://127.0.0.1:8795/#local-chat>. Choose **New chat**, enter a message and
press **Send**. Conversations are saved locally; use the conversation selector
to return to one. **Stop** cancels the active local request. Failures and
interrupted requests stay visible and are never automatically replayed.

The installed local model is HauhauCS Qwen3.5 9B Q4_K_M through Ollama, with
project-local storage and a hidden server. It uses local hardware without an
API billing fallback. Startup and status refreshes do not run inference.

The project-local Claude and Codex MCP profiles also expose `local_model`:
`local_model_status`, `local_model_chat`, and `local_model_cancel`. Reconnect
their MCP clients to load the added server. They can delegate an explicit
request and continue the same conversation by ID. Within a request, HauhauCS
can read shared project context and record attributed handoffs for the team.
This is bounded collaboration; continuous autonomous work and source/game
editing are not enabled through the chat interface. See
[LOCAL-WORKER.md](docs/LOCAL-WORKER.md) for verification and limitations.

The control room shows dated model work, a captured-world Architect draft and
geometry audit, MCP connections, REA analysis, task claims and saved receipts.
The same startup also starts/reuses the bundled Satisfactory bridge quietly.
App startup makes zero paid model calls. A task claim records responsibility,
not proof of current reasoning. Explicit model jobs have run; a continuously
running project coordinator has not yet been configured.

All new application files live here:

```text
Copilot.exe                 one user-facing entry point
app/                        control room and launcher source
runtime/node/               bundled Node.js 24.12.0 with license
runtime/agent-pair/         reviewed MCP runtime and real local dependencies
runtime/satisfactory-companion/ game bridge and parser dependencies
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
npm run repair:runtime   # restore exact charter bytes after a fresh Windows clone
```

The next game test for our current multi-model MCP system. This is a new local
project with its own Git history, MCP memory, claims and progress page.

The foundation is the existing **Agent Pair** runtime pinned at
`b727bebede1c7cdd025cc1a7f57981b3e7720beb`. It includes the verified file-tool
repairs and the full **Superpowers 7.0.0** package. The lab bundles that exact
source with local dependencies under runtime/agent-pair, preserving its original
repository. Its game source checkout is `workspaces/architect/integration`;
the companion runtime is bundled separately under runtime/. The installed
Satisfactory mod remains in the game. No Civ VI game code is copied here.

```text
Claude / Codex
  -> Agent Pair MCP: tasks, memory, messages, review and recovery
  -> Superpowers MCP: planning, debugging, testing and verification skills
  -> this Satisfactory project: game-specific benchmark and evidence
  -> existing AI Factory Copilot companion/mod: authoritative game access
```

The companion on port 8142 is restored and the reviewed structural revisions
are deployed. A health reply alone does not prove a loaded save, successful
game action, API allowance or model reasoning quality.

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

## Architect progress and next step

Claude authored the structural adapter; Codex added typed revisions and action
gates; independent reviews passed and all 1,276 companion tests pass. Google
delivered eight acceptance cases through MCP after a bounded service-error
recovery. Full-world captured-data drafting works offline and reports its age.
The measured-box audit does not certify cave clearance or final game placement.

See [the implementation and acceptance plan](docs/AI-ARCHITECT-PLAN.md). The next
proof is an entrance shell placed and read back at a freshly measured test site.

Changes to the game repository require its own claim, branch and tests.
Existing working features must be preserved. Installing skills does not train
model weights; progress is tested tools, retained lessons and measured tasks.
