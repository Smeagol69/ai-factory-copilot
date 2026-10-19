# Local official REA

This directory contains the complete published `rea-agents@6.5.0` package and
its production dependencies, including the optional Frida binding. It is a
separate npm project; no global install or agent registration was performed.
`package-lock.json` pins the exact registry distribution and dependency tree.
The original README, MIT license, third-party notices, bridges, native helper,
and workflow skill remain in `node_modules/rea-agents/`.

From the Copilot home:

```powershell
node scripts/rea.mjs --help
node scripts/rea.mjs analyze-javascript-application C:/absolute/path/to/owned/app --format json
node scripts/rea.mjs mcp
node scripts/check-rea.mjs
```

With no arguments the wrapper starts the real MCP stdio server. It imports the
official dispatcher in the same process, avoiding an extra Windows wrapper
child. MCP clients and verification launchers start this process hidden.
CLI arguments and caller-relative paths keep their normal meanings. MCP's
working directory and default cache/temp/browser/output locations are inside
`state/rea/`. Explicit CLI destinations remain the caller's responsibility.
The environment excludes inherited API credentials and unrelated model config.

The normal check does not run a model, execute the fixture, access the game,
modify global agent settings, or decompile a native target. It performs an
actual MCP handshake, inventories the installed tool catalog, and statically
analyzes the owned fixture in `test/fixtures/rea/app`. Concise receipts and full
sanitized Evidence are written separately under `state/rea/`. Tool registration
alone does not prove external engines, device access, or runtime workflows work.

To reproduce npm installation, first run `npm ci --ignore-scripts --prefix
tools/rea --cache state/rea/npm-cache`. The only installed dependency install
script is Frida's reviewed `scripts/install.js`: it tries an official prebuilt
binding, then a local source build. After reviewing that script for the pinned
version, run `npm rebuild frida --prefix tools/rea --cache state/rea/npm-cache`.
The published REA prepare script only installs Husky when development source and
Husky are present; neither is part of this production installation.

## Portable native analysis

Official Ghidra 12.1.4 and Eclipse Temurin JDK 21.0.12.1+1 are extracted under
`tools/ghidra/` and `tools/java/`. Their archive URLs, sizes, official SHA-256
values and installed key-file hashes are recorded in
`tools/native-engines-lock.json`; licenses stay in the extracted distributions.
The wrapper sets project-local `GHIDRA_INSTALL_DIR` and `JAVA_HOME` only when
those pins match. Global PATH, registry, agent settings and Java settings are
unchanged. Status reads files/receipts; it does not start Java or decompile.

```powershell
node scripts/check-rea.mjs --native
```

This explicit check imports `state/rea/native-fixture/copilot-fixture.exe` with
Ghidra through the real MCP server and decompiles its exported `copilot_scale`.
The fixture was built from `test/fixtures/rea/native.c` with the local MSVC x64
compiler (`/c /Od /GS-`) and linker (`/entry:copilot_entry /subsystem:console
/nodefaultlib /machine:x64`). `state/rea/native-fixture/build.json` records the
source, binary, compiler and linker hashes. The target is analyzed as data and
never executed. The verified function returns `value * 3 + 7`. This verifies one
native PE workflow, not every native engine or arbitrary application.

`state/rea/latest-native-check.json` links its actual receipt and full sanitized
Evidence. Native tests are opt-in (`REA_NATIVE_SMOKE=1`); normal `npm test` does
not start Ghidra. There are no scheduled checks or autonomous polling loops.

The package's Windows Job Object launcher uses `CREATE_NO_WINDOW`. Its Java
LaunchSupport helper omitted Node's hide option, so this project's wrapper
forces `windowsHide:true` and `detached:false` for Windows child-process calls
before importing REA, including ESM consumers and promisified execFile. This
policy exists only inside the REA process and leaves the published package
bytes intact. Tests cover explicit false overrides and stdout/stderr contracts.
