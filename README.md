# Satisfactory MCP Lab

The next game test for our current multi-model MCP system. This is a new local
project with its own Git history, MCP memory, claims and progress page.

The foundation is the existing **Agent Pair** runtime pinned at
`b727bebede1c7cdd025cc1a7f57981b3e7720beb`. It includes the verified file-tool
repairs and the full **Superpowers 7.0.0** package. The lab reuses that source
instead of forking it. Its game adapter is the existing AI Factory Copilot
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

Progress: <http://127.0.0.1:8794/>. The earlier runtime/Civ VI page remains on
8792. The new page reads this project's ledger; it deliberately does not label
the old coordinator's workers as a Satisfactory team. Shared MCP connection
heartbeats may still include other projects and are labelled accordingly.

Open this folder when starting future Satisfactory project work. Project-local
`.mcp.json` and `.codex/config.toml` point to the two tested launchers.
The launchers use absolute script paths so clients can start them from another
working directory. After moving this folder or changing Node installation,
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
