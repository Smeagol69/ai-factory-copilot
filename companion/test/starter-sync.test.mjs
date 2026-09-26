import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyStarterSync } from "../../scripts/verify-starter-sync.mjs";

const native = "Source/AIFactoryCopilot/Private/Capture.cpp";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aifactory-sync-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const plugin = path.join(root, "starter", "Mods", "AIFactoryCopilot");
  const write = (base, relative, text = "same bytes") => {
    const file = path.join(base, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const files = ["AIFactoryCopilot.uplugin", "Source/AIFactoryCopilot/AIFactoryCopilot.Build.cs", native,
    "Config/Alpakit.ini", "Resources/Icon128.png", "Content/Test.uasset", "companion/server.mjs",
    "companion/package.json", "companion/package-lock.json", "companion/lib/router.mjs", "companion/data/catalog.json"];
  for (const file of files) { write(source, file); write(plugin, file); }
  return { source, plugin, write, files };
}

test("Starter sync accepts equal runtime content despite differing timestamps and generated files", (t) => {
  const { source, plugin, write, files } = fixture(t);
  fs.utimesSync(path.join(plugin, native), new Date(0), new Date(0));
  for (const file of ["Binaries/Win64/mod.dll", "Intermediate/build.obj", "Saved/cook.log", "companion/node_modules/parser/index.js", "companion/.env"]) write(plugin, file);
  assert.equal(verifyStarterSync(source, plugin).files, files.length);
});

test("Starter sync rejects stale native bytes even when file size and timestamp match", (t) => {
  const { source, plugin, write } = fixture(t);
  write(plugin, native, "evil bytes"); // Same length as the fixture's source.
  const time = fs.statSync(path.join(source, native)).mtime;
  fs.utimesSync(path.join(plugin, native), time, time);
  assert.throws(() => verifyStarterSync(source, plugin), /changed: Source.*Capture.cpp/);
  assert.equal(fs.readFileSync(path.join(plugin, native), "utf8"), "evil bytes");
});

test("Starter sync rejects missing headers and extra source files that Unity could still compile", (t) => {
  const { source, plugin, write } = fixture(t);
  write(source, "Source/AIFactoryCopilot/Private/NewHeader.h");
  write(plugin, "Source/AIFactoryCopilot/Private/OldFeature.cpp");
  assert.throws(() => verifyStarterSync(source, plugin), (error) =>
    /missing: .*NewHeader.h/.test(error.message) && /extra: .*OldFeature.cpp/.test(error.message));
});

test("Starter sync detects stale bundled bridge, catalog, config, assets and lockfile", (t) => {
  const { source, plugin, write } = fixture(t);
  for (const relative of ["companion/lib/router.mjs", "companion/data/catalog.json", "companion/package-lock.json", "Config/Alpakit.ini", "Content/Test.uasset", "Resources/Icon128.png"]) {
    write(plugin, relative, "stale");
    assert.throws(() => verifyStarterSync(source, plugin), (error) => error.message.includes(`changed: ${relative}`));
    write(plugin, relative);
  }
});

test("Starter sync refuses an empty or wrong source root", (t) => {
  const { plugin } = fixture(t);
  assert.throws(() => verifyStarterSync(path.join(plugin, "missing"), plugin), /Repository packaging input is missing/);
});

test("packaging verifier CLI exits unsuccessfully for stale input without changing it", (t) => {
  const { source, plugin, write } = fixture(t);
  const script = fileURLToPath(new URL("../../scripts/verify-starter-sync.mjs", import.meta.url));
  const args = [script, "--source-root", source, "--plugin-root", plugin];
  assert.equal(spawnSync(process.execPath, args, { encoding: "utf8" }).status, 0);
  write(plugin, native, "older source");
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /changed: .*Capture.cpp/);
  assert.equal(fs.readFileSync(path.join(plugin, native), "utf8"), "older source");
});
