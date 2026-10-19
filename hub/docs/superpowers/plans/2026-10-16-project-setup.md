# Satisfactory MCP Lab setup

The owner requested a new project using the existing MCP foundation, and
selected Satisfactory as the next game. This is an isolated project setup,
not a rewrite of the runtime or the existing game mod.

Use the verified Agent Pair runtime at commit
`b727bebede1c7cdd025cc1a7f57981b3e7720beb`, including the approved Managed
Agents tool fixes and Superpowers 7.0.0. Reference the existing Satisfactory
repository as the game adapter. Retain separate project memory and tasks.

1. Create project instructions, configuration and commands in this new Git
   repository. Keep runtime and game source in their current repositories;
   pin the runtime and fail clearly if its tracked source drifts.
2. Add tests before implementation for runtime drift rejection and companion
   health classification. Status must make only a fixed localhost GET and
   report an unavailable or unrelated service honestly. Never invoke a model,
   write to the game, install a service or copy credentials during status.
3. Reuse the existing stdio MCP and Superpowers servers through small verified
   launchers. Add project-local Codex/Claude configuration without changing
   global clients. Exercise real MCP connections and this project's context.
4. Reuse the existing read-only progress room on a separate port, with this
   project's own snapshot and ledger. Do not display another project's
   coordinator as this project's activity. Start it hidden without scheduling.
5. Run the project suite and real status/catalog checks, save the evidence,
   commit, and record a shared MCP handoff. The next game benchmark stays
   pending until the existing companion is reachable and a task is selected.

Files: `project.json`, `AGENTS.md`, `README.md`, `package.json`, `.gitignore`,
`.mcp.json`, `.codex/config.toml`, `lib/project.mjs`, small `scripts/` entry
points, `test/project.test.mjs`, `test/mcp.test.mjs`, `progress-state.json`,
and `docs/` evidence/handoff. No changes in the original Satisfactory,
Civ VI or runtime repositories are needed.

Review focus: drifted runtime must not launch; unrelated localhost responses
must not count as the game bridge; errors must not invent a loaded save;
stdio must stay protocol-clean; progress must use the new project ID.
