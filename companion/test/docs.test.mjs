// The start-here docs are how a newly connected model finds its way. Every
// relative link in them must resolve, or the next reader hits a dead end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const START_HERE = ["README.md", "AGENTS.md", "docs/STATUS.md", "docs/HISTORY.md", "docs/ARCHITECTURE.md",
  "docs/history/tunnel-milestone/README.md"];

export function brokenLinks(file, repo = REPO) {
  const text = readFileSync(join(repo, file), "utf8");
  const broken = [];
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
    const path = decodeURIComponent(target.split("#")[0]);
    if (!existsSync(resolve(repo, dirname(file), path))) broken.push(target);
  }
  return broken;
}

for (const file of START_HERE) {
  test(`every relative link in ${file} resolves`, () => {
    assert.deepEqual(brokenLinks(file), []);
  });
}

test("a missing link target is reported", () => {
  assert.deepEqual(brokenLinks("companion/test/fixtures-docs/broken.md"), ["nowhere.md"]);
});
