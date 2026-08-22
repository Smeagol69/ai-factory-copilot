import assert from "node:assert/strict";
import test from "node:test";
import { narrateFindings } from "../lib/narrate.mjs";

const machine = (id, name, causes, extra = {}) => ({
  actor_id: id,
  name,
  class_path: `x.${name}`,
  healthy: causes.length === 0,
  local_causes: causes.map((cause) => ({ cause })),
  ...extra,
});

/** The owner's actual case: one tripped circuit, symptoms all over it. */
function trippedCircuit() {
  const reports = [];
  for (let i = 0; i < 7; i += 1) {
    const causes = ["power_fuse_triggered"];
    if (i < 6) causes.push("machine_reports_error_status");
    if (i < 2) causes.push("producing_below_full_productivity");
    reports.push(machine(`a${i}`, i < 4 ? "Build_SmelterMk1_C_1" : "Build_ConstructorMk1_C_1", causes));
  }
  return { reports, reported_machine_count: 7 };
}

test("the headline is a consequence, not a category", () => {
  const out = narrateFindings(trippedCircuit(), { circuit_count: 1 });
  assert.match(out.text, /Your power has tripped/);
  assert.doesNotMatch(out.text.split("\n")[0], /power_fuse_triggered/);
});

test("symptoms of a tripped fuse are demoted, not listed as peer problems", () => {
  const out = narrateFindings(trippedCircuit(), { circuit_count: 1 });
  // One problem, not four.
  assert.equal(out.problem_count, 1);
  assert.equal(out.leading, "power_fuse_triggered");
  assert.match(out.text, /downstream of the above, not separate faults/);
});

test("machines are named so there is somewhere to walk to", () => {
  const out = narrateFindings(trippedCircuit(), { circuit_count: 1 });
  assert.match(out.text, /Smelter/);
  assert.match(out.text, /Constructor/);
});

test("a symptom on a machine the parent cause does not touch survives as its own fault", () => {
  // This is the failure mode of demotion: hiding a real second problem.
  const data = trippedCircuit();
  data.reports.push(machine("elsewhere", "Build_AssemblerMk1_C_1", ["producing_below_full_productivity"]));
  const out = narrateFindings(data, { circuit_count: 2 });
  assert.equal(out.problem_count, 2, "the unrelated slow machine must not be swallowed");
  assert.match(out.text, /running below full rate/);
});

test("a healthy factory is told so plainly", () => {
  const out = narrateFindings({ reports: [machine("ok", "Build_SmelterMk1_C_1", [])] }, { circuit_count: 1 });
  assert.equal(out.problem_count, 0);
  assert.equal(out.leading, null);
  assert.match(out.text, /Nothing is stalled/);
});

test("causes are ordered so the one to fix first comes first", () => {
  const data = {
    reports: [
      machine("a", "Build_SmelterMk1_C_1", ["producing_below_full_productivity"]),
      machine("b", "Build_ConstructorMk1_C_1", ["no_recipe_selected"]),
    ],
  };
  const out = narrateFindings(data, { circuit_count: 1 });
  assert.equal(out.leading, "no_recipe_selected", "a broken machine outranks a slow one");
  assert.ok(
    out.text.indexOf("no recipe set") < out.text.indexOf("running below full rate"),
    "the invalid finding must be written first",
  );
});

test("an unrecognised cause is surfaced, never silently dropped", () => {
  const data = { reports: [machine("a", "Build_SmelterMk1_C_1", ["some_future_cause"])] };
  const out = narrateFindings(data, { circuit_count: 1 });
  assert.match(out.text, /some_future_cause/);
  assert.match(out.text, /nothing here knows what they mean yet/);
});

test("every claim is marked as read rather than estimated", () => {
  const out = narrateFindings(trippedCircuit(), { circuit_count: 1 });
  assert.match(out.text, /from captured state — not estimated/);
});

test("the game's own spelling of a class is not shoved at the player", () => {
  const out = narrateFindings(trippedCircuit(), { circuit_count: 1 });
  assert.doesNotMatch(out.text, /Build_/);
  assert.doesNotMatch(out.text, /_C_\d/);
});
