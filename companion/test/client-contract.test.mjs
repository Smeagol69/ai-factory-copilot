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
