/**
 * Every solver needs a way in.
 *
 * Four solvers were found written, tested, exposed to the model as tools, and
 * unreachable by asking in words — `solveBuildCost`, `solveRecipeOptions`,
 * `solveMachineRates` and `solveTransportCapacity`. So "how much does a smelter
 * cost" went to a model answering from training while the catalogue in the
 * capture sat unread.
 *
 * That is the quietest way a feature can be missing: everything about it looks
 * present. Nothing failed, nothing warned, the tests were green — the work
 * simply never reached a player. This test makes it loud.
 *
 * Being routed is not the same as being *reachable by every phrasing*, which no
 * test can promise. It only catches the whole-solver case, which is the one
 * that kept happening.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import * as solvers from "../lib/solvers.mjs";

const routerSource = fs.readFileSync(new URL("../lib/router.mjs", import.meta.url), "utf8");

test("no solver is left with nothing calling it", () => {
  const unreached = Object.keys(solvers)
    .filter((name) => name.startsWith("solve"))
    .filter((name) => !routerSource.includes(`${name}(`))
    .sort();

  assert.deepEqual(
    unreached,
    [],
    "these solvers exist and no route calls them, so nobody can ask for them:\n" +
      unreached.map((name) => `  ${name}`).join("\n"),
  );
});

test("the check would notice a solver going unrouted", () => {
  // Guarding the guard: a name the router genuinely does not mention must come
  // back as unreached, or the assertion above proves nothing.
  assert.ok(!routerSource.includes("solveSomethingNobodyWrote("));
});
