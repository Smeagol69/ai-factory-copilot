import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamState, milestonesForMemory } from '../lib/team-state.mjs';

const fresh = (now = () => 1792377000000) => { const root = mkdtempSync(join(tmpdir(), 'team-')); return { root, s: createTeamState(root, { now }) }; };

test('the owner adds, orders, activates and completes milestones, and they persist', () => {
  const { root, s } = fresh();
  s.changeMilestones({ action: 'add', title: 'Curved tunnel shell' });
  s.changeMilestones({ action: 'add', title: 'Tunnel lighting', notes: '6 lamps, 28 beams' });
  const [a, b] = s.milestones();
  s.changeMilestones({ action: 'update', id: a.id, status: 'active' });
  s.changeMilestones({ action: 'update', id: b.id, status: 'active' });
  let items = s.milestones();
  assert.deepEqual(items.map(m => m.status), ['planned', 'active'], 'only one milestone is active');
  s.changeMilestones({ action: 'update', id: a.id, status: 'complete' });
  s.changeMilestones({ action: 'move', id: b.id, by: -1 });
  items = createTeamState(root).milestones();
  assert.deepEqual(items.map(m => m.title), ['Tunnel lighting', 'Curved tunnel shell']);
  assert.ok(items[1].completedAt);
  s.changeMilestones({ action: 'remove', id: a.id });
  assert.equal(s.milestones().length, 1);
});

test('bad milestone input is refused with a reason', () => {
  const { s } = fresh();
  assert.throws(() => s.changeMilestones({ action: 'add', title: '  ' }), /Title is required/);
  assert.throws(() => s.changeMilestones({ action: 'add', title: 'x'.repeat(161) }), /longer than 160/);
  assert.throws(() => s.changeMilestones({ action: 'update', id: 'nope', status: 'active' }), /not found/);
  s.changeMilestones({ action: 'add', title: 'A' });
  assert.throws(() => s.changeMilestones({ action: 'update', id: s.milestones()[0].id, status: 'done' }), /Unknown milestone status/);
  assert.throws(() => s.changeMilestones({ action: 'move', id: s.milestones()[0].id, by: -1 }), /Cannot move/);
  assert.throws(() => s.changeMilestones({ action: 'explode' }), /Unknown milestone action/);
});

test('local models join with a role, once each, and can leave', () => {
  const { s } = fresh();
  s.changeRoster({ action: 'add', model: 'copilot-hauhau-game:latest' });
  assert.equal(s.roster().local[0].role, 'backup worker');
  assert.throws(() => s.changeRoster({ action: 'add', model: 'copilot-hauhau-game:latest' }), /already on the team/);
  assert.throws(() => s.changeRoster({ action: 'add', model: 'bad name; rm -rf' }), /unexpected characters/);
  assert.throws(() => s.changeRoster({ action: 'add', model: 'qwen3:8b', role: 'boss' }), /Unknown role/);
  s.changeRoster({ action: 'remove', model: 'copilot-hauhau-game:latest' });
  assert.equal(s.roster().local.length, 0);
});

test('a manual out-of-usage mark ends at its reset time', () => {
  let t = 1792377000000;
  const { s } = fresh(() => t);
  s.changeRoster({ action: 'mark-out', column: 'claude', until: t + 60000 });
  assert.ok(s.manualOut('claude'));
  t += 61000;
  assert.equal(s.manualOut('claude'), null);
  assert.throws(() => s.changeRoster({ action: 'mark-out', column: 'gemini' }), /Unknown column/);
  assert.throws(() => s.changeRoster({ action: 'mark-out', column: 'codex', until: t - 1 }), /future/);
});

test('a corrupt state file starts empty instead of guessing', () => {
  const root = mkdtempSync(join(tmpdir(), 'team-'));
  mkdirSync(join(root, 'state/team'), { recursive: true });
  writeFileSync(join(root, 'state/team/milestones.json'), '{not json');
  assert.deepEqual(createTeamState(root).milestones(), []);
});

test('models read milestones as plain text from shared memory', () => {
  assert.equal(milestonesForMemory([]), 'No milestones set by the owner yet.');
  const text = milestonesForMemory([{ title: 'Lighting', status: 'active', notes: 'power too' }, { title: 'Shell', status: 'complete', notes: '' }]);
  assert.match(text, /1\. \[▶ ACTIVE\] Lighting — power too/);
  assert.match(text, /2\. \[✓ complete\] Shell$/);
});

test('a state file saved with a byte-order mark still loads', () => {
  const root = mkdtempSync(join(tmpdir(), 'team-'));
  mkdirSync(join(root, 'state/team'), { recursive: true });
  writeFileSync(join(root, 'state/team/milestones.json'), '﻿' + JSON.stringify({ items: [{ id: 'a', title: 'Kept', status: 'active', notes: '' }] }));
  assert.equal(createTeamState(root).milestones()[0].title, 'Kept');
});
