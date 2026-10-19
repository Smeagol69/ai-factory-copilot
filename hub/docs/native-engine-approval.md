# Ghidra removal and approval requirement

The owner requested uninstalling Ghidra completely until it is needed again.
Automatic approval review rejected both the bounded removal and a narrower
literal-path removal. The portable folder and installer are still present;
removal is incomplete. The exact targets are `tools/ghidra/` and
`state/rea/downloads/ghidra_12.1.4_PUBLIC_20260921.zip` in this application home.
Saved analysis, project work and unrelated Java installations are retained.

A subsequent audit found a separate global launcher actually running:
`C:/Users/roesl/.local/bin/ghidra-mcp.exe` (PID 23616), started by Claude Code
(PID 5960). Its global `mcpServers.ghidra` entry in
`C:/Users/roesl/.claude.json` configured automatic startup with
`--ghidra-server http://127.0.0.1:8081/`. That exact entry was removed while
preserving the other three MCP registrations, and the verified launcher process
was stopped. Its embedded Python path points to an absent uv tool environment;
`uv tool list` reports no installed tools. Automatic approval review also
rejected deletion of this separate launcher. The executable therefore remains
on disk, with no current registration in the inspected client configurations.
The saved entry and verification receipt are under `state/native-engines/`.

The existing one-click RE workflow previously selected Ghidra automatically for
native game inspection. Two earlier native attempts timed out; retained receipts
show those attempts. An earlier audit found no running Ghidra, Java or decompiler
process and no Ghidra scheduled startup task; the subsequent Claude launcher
finding above supersedes that earlier process inventory. It establishes an
automatic launcher, not proof that the Ghidra analysis engine itself was running.

Native check requests return `user-approval-required` before starting a child.
The project REA launch policy rejects Ghidra/headless/JVM commands, including the
promisified launch path. Inherited environment or a model request cannot grant
permission. A future installation/launch requires a new explicit user request.
Nothing in routine model-team or Architect instructions overrides that choice.

This is enforcement for this application's managed launch paths, not an
operating-system restriction on unrelated programs the user starts manually.
