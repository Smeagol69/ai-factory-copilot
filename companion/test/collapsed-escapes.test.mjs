/**
 * The other half of the escape-collapse trap.
 *
 * Writing source through a shell heredoc eats backslashes. The flavour this
 * repo already guards against turns `\b` into a 0x08 control character, which
 * is easy to spot. The other flavour just deletes the backslash: `\s+` becomes
 * `s+`, `\d` becomes `d`. Those are ordinary letters, the file still parses,
 * every test still passes, and the regex quietly matches something else.
 *
 * It cost a whole feature before anyone noticed. The "clear holograms" route --
 * added because a stuck hologram was following the owner's cursor -- shipped
 * with every `\s+` in its pattern collapsed:
 *
 *   /^(?:clear|remove|delete|get rid of)s+(?:thes+|anys+|alls+)?holo(?:gram)?s?$/
 *
 * It demanded literal s characters where spaces belonged, so it never once
 * fired. Nothing failed; the request simply went to a model instead.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const directories = ["lib", "test", "."].map((name) =>
  path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..", name),
);

const sourceFiles = () => {
  const files = new Set();
  for (const directory of directories) {
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) {
      if (/\.mjs$/.test(name)) files.add(path.join(directory, name));
    }
  }
  return [...files].sort();
};

// A regex literal. The leading character keeps a division sign or a URL from
// being read as the start of one.
const LITERAL =
  /(?:^|[=(,:[!&|?{;+\-*%~^]|\breturn\b|\btypeof\b)\s*\/((?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+)\/[gimsuyv]*/g;

// A bare escape-class letter directly after a group or alternation, followed by
// a quantifier. `(?:the)s+` is a collapsed `\s+`; `(?:pipes)+` would not be,
// because a real word ends in the letter and the quantifier applies to it --
// hence the requirement that a group or class close immediately precede it.
const COLLAPSED = /[)\]|](?<letter>[sbdwSBDW])(?=[+*?{])/;

test("no regex literal has lost a backslash from an escape class", () => {
  const damaged = [];
  for (const file of sourceFiles()) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      // Comment lines are skipped, because this very file quotes the broken
      // pattern in its own header in order to explain it. A regex sitting in
      // prose is not code that can misbehave.
      if (/^\s*(?:\*|\/\/|\/\*)/.test(line)) return;
      LITERAL.lastIndex = 0;
      let match;
      while ((match = LITERAL.exec(line)) !== null) {
        const hit = COLLAPSED.exec(match[1]);
        if (hit) {
          damaged.push(`${path.basename(file)}:${index + 1} looks like a collapsed \\${hit.groups.letter}: ${line.trim().slice(0, 120)}`);
        }
      }
    });
  }
  assert.deepEqual(damaged, [], `collapsed regex escapes:\n${damaged.join("\n")}`);
});

test("the detector actually catches the shape that got through", () => {
  // Guarding the guard: an assertion that never fires is not protection. This
  // is the exact pattern that shipped broken.
  const broken = String.raw`/^(?:clear|remove|delete|get rid of)s+(?:thes+|anys+)?holo(?:gram)?s?$/i`;
  LITERAL.lastIndex = 0;
  const match = LITERAL.exec(`if (${broken}.test(x))`);
  assert.ok(match, "the literal scanner should find the pattern at all");
  assert.ok(COLLAPSED.test(match[1]), "the detector should flag it");

  // And does not cry wolf over a word that legitimately ends in one of those
  // letters immediately before a quantifier.
  LITERAL.lastIndex = 0;
  const fine = LITERAL.exec(String.raw`const p = /^(?:pipes|belts)+\s+ok$/i;`);
  assert.ok(fine);
  assert.ok(!COLLAPSED.test(fine[1]));
});
