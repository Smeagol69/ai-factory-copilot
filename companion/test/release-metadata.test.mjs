import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

async function json(relative) {
  return JSON.parse(await readFile(new URL(relative, root), "utf8"));
}

test("plugin and companion publish one exact semantic version", async () => {
  const [plugin, companion] = await Promise.all([
    json("AIFactoryCopilot.uplugin"),
    json("companion/package.json"),
  ]);

  assert.match(plugin.SemVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(plugin.Version, Number(plugin.SemVersion.split(".")[0]));
  assert.equal(plugin.VersionName, plugin.SemVersion);
  assert.equal(companion.version, plugin.SemVersion);
  assert.equal(plugin.IsBetaVersion, plugin.SemVersion.includes("-"));
});

test("SML metadata links users to this project and its support tracker", async () => {
  const plugin = await json("AIFactoryCopilot.uplugin");
  assert.equal(plugin.DocsURL, "https://github.com/Smeagol69/ai-factory-copilot#readme");
  assert.equal(plugin.SupportURL, "https://github.com/Smeagol69/ai-factory-copilot/issues");
  assert.equal(plugin.Plugins.find(({ name, Name }) => (name ?? Name) === "SML")?.SemVersion, "^3.12.0");
});

test("the public companion bundle includes secure configuration tooling", async () => {
  const [installer, configurator, packager] = await Promise.all([
    readFile(new URL("scripts/install-companion.ps1", root), "utf8"),
    readFile(new URL("scripts/configure-companion.ps1", root), "utf8"),
    readFile(new URL("scripts/package-release.ps1", root), "utf8"),
  ]);
  assert.match(installer, /configure-companion\.ps1/);
  assert.match(configurator, /Read-Host .* -AsSecureString/);
  assert.doesNotMatch(configurator, /Write-Host.*ApiKey/i);
  assert.match(packager, /configure-companion\.ps1/);
});
