import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioStore, nextStep, validatePieces, MAX_ROUNDS } from '../lib/studio-store.mjs';

const F = '/Game/FactoryGame/Buildable/Building/Foundation/ConcreteSet/Build_Foundation_Concrete_8x2.Build_Foundation_Concrete_8x2_C';
const pieces = n => Array.from({ length: n }, (_, i) => ({ class_path: F, transform: { translation_cm: { x: i * 800, y: 0, z: 0 }, rotation_quat: { x: 0, y: 0, z: 0, w: 1 }, scale3d: { x: 1, y: 1, z: 1 } } }));
const store = () => { let t = 1000; return createStudioStore(mkdtempSync(join(tmpdir(), 'studio-')), { now: () => ++t }); };

test('piece lists are checked before they become candidates', () => {
  assert.equal(validatePieces(pieces(2)).length, 2);
  assert.throws(() => validatePieces([]), /non-empty/);
  assert.throws(() => validatePieces([{ class_path: 'Foundation', transform: {} }]), /game class path/);
  assert.throws(() => validatePieces([{ class_path: F, transform: { translation_cm: { x: 0, y: 0, z: 0 }, rotation_quat: { x: 1, y: 1, z: 0, w: 0 } } }]), /normalised/);
});

test('the design runs candidate → critique by the other model → agree → build → verify → done', () => {
  const s = store(); let job = s.create({ brief: 'Sweeping 90 tunnel joined to the walled tunnel' });
  assert.deepEqual(nextStep(job), { worker: 'codex', kind: 'candidate' });
  s.addCandidate(job.id, 'codex', { title: 'Sweep A', rationale: 'Matches the walled profile', pieces: pieces(3) });
  assert.deepEqual(nextStep(s.get(job.id)), { worker: 'claude', kind: 'critique', candidate: 1 });
  assert.throws(() => s.addCritique(job.id, 'codex', { candidate: 1, verdict: 'agree', critique: 'mine is great' }), /other model/);
  s.addCritique(job.id, 'claude', { candidate: 1, verdict: 'revise', critique: 'Joint at the join is stepped' });
  s.addCandidate(job.id, 'claude', { title: 'Sweep B', rationale: 'Shared panel angles', pieces: pieces(4) });
  assert.deepEqual(nextStep(s.get(job.id)), { worker: 'codex', kind: 'critique', candidate: 2 });
  job = s.addCritique(job.id, 'codex', { candidate: 2, verdict: 'agree', critique: 'Joints are clean now' });
  assert.equal(job.status, 'agreed');
  assert.equal(job.agreedCandidate, 2);
  assert.deepEqual(nextStep(job), { worker: 'codex', kind: 'build', candidate: 2 });
  assert.throws(() => s.addCandidate(job.id, 'codex', { title: 'x', rationale: 'y', pieces: pieces(1) }), /closed/);
  s.startBuild(job.id);
  s.reportBuild(job.id, 'codex', { summary: 'Saved and placed 4 pieces', blueprint_name: 'AI Sweep B' });
  assert.deepEqual(nextStep(s.get(job.id)), { worker: 'claude', kind: 'verify', candidate: 2 });
  job = s.addCritique(job.id, 'claude', { candidate: 'build', verdict: 'agree', critique: 'Placed poses match the agreed candidate' });
  assert.equal(job.status, 'done');
  assert.equal(nextStep(job), null);
  assert.equal(s.piecesOf(job.id, 2).length, 4);
});

test('a revise without a variant goes back to the author', () => {
  const s = store(), job = s.create({ brief: 'Factory floor' });
  s.addCandidate(job.id, 'codex', { title: 'A', rationale: 'r', pieces: pieces(1) });
  s.addCritique(job.id, 'claude', { candidate: 1, verdict: 'revise', critique: 'Too narrow' });
  assert.deepEqual(nextStep(s.get(job.id)), { worker: 'codex', kind: 'candidate', revising: 1 });
});

test('after the round cap the owner decides, and can pick a candidate', () => {
  const s = store(), job = s.create({ brief: 'Base', firstDesigner: 'claude' });
  let author = 'claude';
  for (let i = 0; i < MAX_ROUNDS * 2; i++) {
    const c = s.addCandidate(job.id, author, { title: `C${i}`, rationale: 'r', pieces: pieces(1) });
    const critic = author === 'claude' ? 'codex' : 'claude';
    if (s.get(job.id).status !== 'designing') break;
    s.addCritique(job.id, critic, { candidate: c.n, verdict: 'revise', critique: 'no' });
    author = critic;
  }
  const stuck = s.get(job.id);
  assert.equal(stuck.status, 'needs-owner');
  assert.equal(nextStep(stuck), null);
  const picked = s.pick(job.id, 2);
  assert.equal(picked.status, 'agreed');
  assert.match(picked.events.at(-1).text, /Owner picked candidate 2/);
});

test('stop ends the job and notes are kept for the next prompt', () => {
  const s = store(), job = s.create({ brief: 'Tunnel' });
  s.note(job.id, 'Keep the floor flush with the walled tunnel');
  assert.equal(s.get(job.id).notes[0].text, 'Keep the floor flush with the walled tunnel');
  assert.equal(nextStep(s.stop(job.id)), null);
  assert.throws(() => s.get('not-a-job'), /Unknown job/);
  assert.equal(s.list().length, 1);
});
