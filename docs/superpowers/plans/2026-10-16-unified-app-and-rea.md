# One Copilot application with REA

The owner's direction is one program and one filesystem home for the reusable
model team, now testing Satisfactory, with the complete official REA package.
This extends the existing setup rather than replacing working features.

Implementation choices: keep this directory as the canonical home; bundle the
reviewed Agent Pair source and Node runtime under runtime/; install the pinned
official rea-agents npm distribution under tools/rea/. A Windows Copilot.exe
opens one local control room. No installer wizard or admin rights are needed.
All new state, logs and future worker checkouts stay here. Existing game source,
active legacy checkouts and the shared live SQLite ledger remain authoritative
at their current paths; copying that ledger would split the team.

## Task 1: Install and exercise REA (delegated implementer)

Own tools/rea/, lib/rea.mjs, scripts/rea.mjs, scripts/check-rea.mjs,
test/rea.test.mjs and test/fixtures/rea/. Pin rea-agents 6.5.0 with its lockfile.
Inspect package scripts before installation. Preserve the full published package,
license and workflows. Export reaStatus() for version/installation/verified
capability evidence and runReaCheck() for a real bounded read-only static JS
analysis. The CLI wrapper forwards arguments to the local pinned package with
all cache/output directories inside this project and without printing secrets.
Test the actual MCP handshake and one real tool invocation. Discover exact
installed tool names instead of assuming README/main matches the release.
Engine availability must report unsupported/missing/unverified honestly.

## Task 2: Bundle the existing runtime and catalogue (primary implementer)

Copy the exact reviewed runtime commit into runtime/agent-pair/, with real local
dependencies rather than the original node_modules junction. Copy Node into
runtime/node/ and record its version/hash. Keep runtime source clean and pinned.
Update project-local profiles to use bundled Node and add REA. Retain the complete
Awesome-RE-MCP README at a pinned upstream commit and index all linked servers as
a catalogue, not installed engines. Test the bundled Agent Pair and Superpowers
MCP launchers from another working directory.

## Task 3: One launcher and visible control room (primary implementer)

Add app/server.mjs, app/public/, lib/app.mjs, scripts/start-app.mjs,
scripts/build-launcher.ps1 and launcher source. Copilot.exe launches the bundled
Node executable, reuses a verified same-project server, and opens its URL. Bind
only loopback; reject foreign Host/Origin and unsafe methods. HTTP commands are
fixed read-only checks, with bounded outputs and no arbitrary shell input.
Show MCP package readiness, REA tools/limitations, catalogue, Satisfactory bridge
health, project home, and recent actual checks. Do not represent idle models as
workers or claim a live world from bridge configuration health. Keep the old
progress-room command working. Test foreign-origin rejection, concurrent checks,
failure recording and same-project startup reuse on real local servers.

## Task 4: Verify and hand off

Run npm test, actual MCP tool calls, REA analysis and the real EXE startup twice.
Record evidence in state/ under this home. Obtain independent whole-change review
and fix material findings with reproducing tests. Document the one-click entry
and remaining native-engine/game limitations. No new schedules, inferred training,
automatic API fallback, unbounded paid work or destructive legacy cleanup.

Review focus: path spaces and foreign cwd; live ledger continuity; port occupied
by another service; no paid startup calls; third-party process cleanup on Windows;
catalogued versus usable engine status; truthful worker/game readiness.

## Owner's live correction

Repeated command prompt windows prevented the owner from using the computer.
Root stopped the owned app server, removed Git launches from refreshes, added
windowsHide to Git verification and restarted only the hidden control service.
Native installation/testing was interrupted immediately. Subsequent work must
stay quiet; REA's upstream Java helper also lacks a hidden-window flag, so the
local wrapper must enforce hidden launches before native engine testing resumes.
Tests use one Node process instead of test-runner child forks. No UI automation
or browser opening is part of ongoing background verification.
