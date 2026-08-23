import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

async function json(relative) {
  return JSON.parse(await readFile(new URL(relative, root), "utf8"));
}

test("plugin and companion publish one exact semantic version", async () => {
  const [plugin, companion, lockfile] = await Promise.all([
    json("AIFactoryCopilot.uplugin"),
    json("companion/package.json"),
    json("companion/package-lock.json"),
  ]);

  assert.match(plugin.SemVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(plugin.Version, Number(plugin.SemVersion.split(".")[0]));
  assert.equal(plugin.VersionName, plugin.SemVersion);
  assert.equal(companion.version, plugin.SemVersion);
  assert.equal(plugin.IsBetaVersion, plugin.SemVersion.includes("-"));
  assert.equal(plugin.GameVersion, ">=502094");
  assert.equal(companion.dependencies["@etothepii/satisfactory-file-parser"], "4.1.2");
  assert.equal(lockfile.packages[""].dependencies["@etothepii/satisfactory-file-parser"], "4.1.2");
});

test("SML metadata links users to this project and its support tracker", async () => {
  const plugin = await json("AIFactoryCopilot.uplugin");
  assert.equal(plugin.DocsURL, "https://github.com/Smeagol69/ai-factory-copilot#readme");
  assert.equal(plugin.SupportURL, "https://github.com/Smeagol69/ai-factory-copilot/issues");
  assert.equal(plugin.Plugins.find(({ name, Name }) => (name ?? Name) === "SML")?.SemVersion, "^3.12.0");
});

test("the public companion bundle installs its lock-pinned parser transactionally", async () => {
  const [installer, configurator, packager, starterInstaller, moduleRules] = await Promise.all([
    readFile(new URL("scripts/install-companion.ps1", root), "utf8"),
    readFile(new URL("scripts/configure-companion.ps1", root), "utf8"),
    readFile(new URL("scripts/package-release.ps1", root), "utf8"),
    readFile(new URL("scripts/install-to-starter.ps1", root), "utf8"),
    readFile(new URL("Source/AIFactoryCopilot/AIFactoryCopilot.Build.cs", root), "utf8"),
  ]);
  assert.match(installer, /configure-companion\.ps1/);
  assert.match(installer, /package-lock\.json/);
  assert.match(installer, /npm\.cmd/);
  assert.match(installer, /\bci\b/);
  assert.match(installer, /satisfactory-file-parser[\\/]build[\\/]index\.js/);
  assert.match(configurator, /Read-Host .* -AsSecureString/);
  assert.doesNotMatch(configurator, /Write-Host.*ApiKey/i);
  assert.match(packager, /configure-companion\.ps1/);
  assert.match(packager, /package-lock\.json/);
  assert.match(packager, /satisfactory-file-parser[\\/]build[\\/]index\.js/);
  assert.match(starterInstaller, /node_modules/);
  assert.match(starterInstaller, /\bci\b/);
  assert.match(moduleRules, /companion\/node_modules\/\.\.\./);
});

test("source packaging refuses a mismatched game and Starter Project", async () => {
  const [validator, localPackager] = await Promise.all([
    readFile(new URL("scripts/validate.ps1", root), "utf8"),
    readFile(new URL("scripts/package-local.ps1", root), "utf8"),
  ]);
  assert.match(validator, /FactoryGameSteam-Win64-Shipping\.version/);
  assert.match(validator, /Starter Project FactoryGame CL/);
  assert.match(localPackager, /FactoryGameSteam-Win64-Shipping\.version/);
  assert.match(localPackager, /Starter Project CL .* installed Satisfactory CL/);
  assert.match(localPackager, /source GameVersion/);
});
