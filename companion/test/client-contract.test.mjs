import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("bundled HTTP clients send the bridge schema-version header", () => {
  const benchmark = fs.readFileSync(
    new URL("../../scripts/benchmark-provider.mjs", import.meta.url),
    "utf8",
  );
  const readme = fs.readFileSync(new URL("../../README.md", import.meta.url), "utf8");

  assert.match(benchmark, /"X-AIFactory-Schema":\s*"1"/);
  assert.match(readme, /-Headers @\{ 'X-AIFactory-Schema' = '1' \}/);
});

test("the game refuses stale or oversized action plans whole", () => {
  const subsystem = fs.readFileSync(
    new URL(
      "../../Source/AIFactoryCopilot/Private/AIFactorySubsystem.cpp",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(subsystem, /SupportedActionContractVersion\s*=\s*1/);
  assert.match(subsystem, /unsupported action contract/);
  assert.match(subsystem, /bridge\/mod version mismatch/);
  assert.match(subsystem, /action plan contains %d steps/);
  assert.match(subsystem, /game_actions_refused/);
  assert.doesNotMatch(subsystem, /Requested\.SetNum\(/);
});
