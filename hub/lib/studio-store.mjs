// Design studio jobs: the owner's brief, every candidate (piece list + render),
// every critique, the agreed design and the build report. One JSON file per job
// under state/studio/jobs/<id>/, written atomically. The turn order lives in
// nextStep(): pure, so the rules are easy to read and test.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ineligible } from './game-catalog.mjs';

export const WORKERS = ['codex', 'claude'];
export const MAX_ROUNDS = 4; // critiques per worker before the owner decides
const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const other = w => w === 'codex' ? 'claude' : 'codex';
const text = (v, max, field) => { if (typeof v !== 'string' || !v.trim()) throw bad(`${field} is required`); const s = v.trim(); if (s.length > max) throw bad(`${field} is longer than ${max} characters`); return s; };

export function validatePieces(pieces) {
  if (!Array.isArray(pieces) || !pieces.length) throw bad('A candidate needs a non-empty piece list');
  if (pieces.length > 2000) throw bad('Up to 2000 pieces per candidate');
  return pieces.map((p, i) => {
    const t = p?.transform?.translation_cm, q = p?.transform?.rotation_quat, s = p?.transform?.scale3d ?? { x: 1, y: 1, z: 1 };
    if (typeof p?.class_path !== 'string' || !/^\/(Game|Script|[A-Za-z_]+)\//.test(p.class_path) || p.class_path.length > 300) throw bad(`Piece ${i}: class_path must be a game class path`);
    // Only what the game itself can place: no invented assets (owner rule, 2026-10-19).
    const why = ineligible(p.class_path);
    if (why) throw bad(`Piece ${i} (${p.class_path.split('.').pop()}): ${why}. Use only classes from hub/catalog/game-buildables.json`);
    const nums = [t?.x, t?.y, t?.z, q?.x, q?.y, q?.z, q?.w, s.x, s.y, s.z];
    if (!nums.every(Number.isFinite)) throw bad(`Piece ${i}: transform needs translation_cm, rotation_quat and scale3d numbers`);
    if (Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) > 0.001) throw bad(`Piece ${i}: rotation_quat must be normalised`);
    return { class_path: p.class_path, transform: { translation_cm: { x: t.x, y: t.y, z: t.z }, rotation_quat: { x: q.x, y: q.y, z: q.z, w: q.w }, scale3d: { x: s.x, y: s.y, z: s.z } } };
  });
}

// What actually happened, for the owner: brief → proposed → agreed → saved → placed → verified.
export function stageOf(job) {
  if (job.status === 'stopped') return 'stopped';
  if (job.status === 'done') return 'verified';
  if (job.build?.built) return job.build.placed ? 'placed' : job.build.saved ? 'saved' : 'agreed';
  if (job.agreedCandidate) return 'agreed';
  return job.candidates.length ? 'proposed' : 'brief';
}

// Whose turn is it, and to do what? null means nobody: waiting on the owner or finished.
export function nextStep(job) {
  if (!job || ['stopped', 'done', 'needs-owner'].includes(job.status)) return null;
  const cands = job.candidates, crits = job.critiques;
  if (job.status === 'designing') {
    if (!cands.length) return { worker: job.firstDesigner, kind: 'candidate' };
    const last = cands.at(-1);
    const designCrits = crits.filter(c => c.candidate !== 'build'), lastCrit = designCrits.at(-1);
    // Round cap: after MAX_ROUNDS critiques each without agreement, the owner decides.
    if (designCrits.length >= MAX_ROUNDS * 2) return null;
    // The newest candidate is critiqued by the model that did not make it.
    if (!crits.some(c => c.candidate === last.n && c.author !== last.author)) return { worker: other(last.author), kind: 'critique', candidate: last.n };
    // A "revise" without a newer variant goes back to the candidate's author.
    if (lastCrit?.verdict === 'revise' && lastCrit.candidate === last.n) return { worker: last.author, kind: 'candidate', revising: last.n };
    return null;
  }
  if (job.status === 'agreed') return { worker: 'codex', kind: 'build', candidate: job.agreedCandidate };
  if (job.status === 'building') {
    // A build reported as blocked (e.g. no game control yet) does not count as built.
    if (!job.build || job.build.built === false) return { worker: 'codex', kind: 'build', candidate: job.agreedCandidate };
    if (!crits.some(c => c.candidate === 'build' && c.at > job.build.at)) return { worker: 'claude', kind: 'verify', candidate: job.agreedCandidate };
    return null;
  }
  return null;
}

export function createStudioStore(root, { now = Date.now } = {}) {
  const base = join(root, 'state/studio/jobs');
  const dir = id => { if (!/^[0-9a-f-]{36}$/.test(id ?? '')) throw bad('Unknown job', 404); return join(base, id); };
  const load = id => { const f = join(dir(id), 'job.json'); if (!existsSync(f)) throw bad('Unknown job', 404); return JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, '')); };
  const save = job => { job.stage = stageOf(job); const d = dir(job.id); mkdirSync(d, { recursive: true }); const tmp = join(d, 'job.json.tmp'); writeFileSync(tmp, JSON.stringify(job, null, 2) + '\n'); renameSync(tmp, join(d, 'job.json')); return job; };
  const log = (job, who, line) => { job.events.push({ t: now(), who, text: String(line).slice(0, 500) }); job.events = job.events.slice(-200); job.updatedAt = new Date(now()).toISOString(); };
  // Pin the agreed piece list by hash so the build can prove it built exactly this.
  const hashOf = (id, n) => 'sha256:' + createHash('sha256').update(readFileSync(join(dir(id), `candidate-${n}.json`))).digest('hex');
  const pin = (job, n) => { job.agreedHash = hashOf(job.id, n); job.agreedSource = job.candidates.find(c => c.n === n)?.source ?? null; };
  const settle = job => {
    // Agreed when the model that did not author the candidate says "agree".
    const agree = [...job.critiques].reverse().find(c => c.verdict === 'agree' && c.candidate !== 'build');
    if (job.status === 'designing' && agree) {
      const cand = job.candidates.find(c => c.n === agree.candidate);
      if (cand && cand.author !== agree.author) { job.status = 'agreed'; job.agreedCandidate = cand.n; pin(job, cand.n); log(job, 'studio', `Both models agree on candidate ${cand.n}: ${cand.title} (${job.agreedHash.slice(0, 19)}…)`); }
    }
    if (job.status === 'designing' && !nextStep(job) && job.candidates.length) { job.status = 'needs-owner'; log(job, 'studio', `No agreement after ${MAX_ROUNDS} rounds; the owner decides`); }
    const verify = [...job.critiques].reverse().find(c => c.candidate === 'build');
    if (job.status === 'building' && job.build?.built !== false && job.build && verify && verify.at > job.build.at) {
      job.status = verify.verdict === 'agree' ? 'done' : 'needs-owner';
      log(job, 'studio', verify.verdict === 'agree' ? 'Build verified by both models' : 'The build needs the owner: the reviewer did not agree');
    }
    return job;
  };
  return {
    dirOf: dir,
    list() {
      if (!existsSync(base)) return [];
      return readdirSync(base).filter(n => /^[0-9a-f-]{36}$/.test(n) && existsSync(join(base, n, 'job.json'))).map(load).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    get: load,
    create({ brief, firstDesigner = 'codex' }) {
      if (!WORKERS.includes(firstDesigner)) throw bad('Unknown designer');
      const job = { id: randomUUID(), brief: text(brief, 4000, 'Brief'), firstDesigner, status: 'designing', createdAt: new Date(now()).toISOString(),
        candidates: [], critiques: [], agreedCandidate: null, build: null, notes: [], events: [] };
      log(job, 'owner', `Brief: ${job.brief}`);
      return save(job);
    },
    addCandidate(id, author, { title, rationale, pieces, source }) {
      if (!WORKERS.includes(author)) throw bad('Unknown author');
      const job = load(id);
      if (job.status !== 'designing') throw bad(`The job is ${job.status}; candidates are closed`, 409);
      const clean = validatePieces(pieces), n = job.candidates.length + 1;
      writeFileSync(join(dir(id), `candidate-${n}.json`), JSON.stringify(clean));
      job.candidates.push({ n, author, title: text(title, 160, 'Title'), rationale: text(rationale, 4000, 'Rationale'), source: typeof source === 'string' ? source.slice(0, 300) : null,
        pieces: clean.length, file: `candidate-${n}.json`, render: null, at: now() });
      log(job, author, `Candidate ${n}: ${job.candidates.at(-1).title} (${clean.length} pieces)`);
      return save(settle(job)).candidates.at(-1);
    },
    setRender(id, n, render) { const job = load(id); const c = job.candidates.find(x => x.n === n); if (!c) throw bad('Unknown candidate', 404); c.render = render; return save(job); },
    piecesOf(id, n) { return JSON.parse(readFileSync(join(dir(id), `candidate-${n}.json`), 'utf8')); },
    addCritique(id, author, { candidate, verdict, critique }) {
      if (!WORKERS.includes(author)) throw bad('Unknown author');
      if (!['agree', 'revise'].includes(verdict)) throw bad('Verdict is agree or revise');
      const job = load(id);
      if (candidate === 'build') {
        if (job.status !== 'building' || !job.build?.built) throw bad('There is no build to verify yet', 409);
        if (job.build.author === author) throw bad('The model that built it cannot verify its own build', 409);
      }
      else {
        const c = job.candidates.find(x => x.n === Number(candidate));
        if (!c) throw bad('Unknown candidate', 404);
        if (c.author === author) throw bad('Critique the other model\'s candidate, not your own', 409);
        if (job.status !== 'designing') throw bad(`The job is ${job.status}`, 409);
      }
      job.critiques.push({ candidate: candidate === 'build' ? 'build' : Number(candidate), author, verdict, text: text(critique, 6000, 'Critique'), at: now() });
      log(job, author, `${verdict === 'agree' ? 'Agrees with' : 'Asks to revise'} ${candidate === 'build' ? 'the build' : `candidate ${candidate}`}`);
      return save(settle(job));
    },
    startBuild(id) { const job = load(id); if (job.status !== 'agreed') throw bad('Nothing agreed yet', 409); if (!job.agreedHash) pin(job, job.agreedCandidate); job.status = 'building'; log(job, 'studio', 'Build started'); return save(job); },
    // The current bytes of the agreed piece file, for the check before every world-changing request.
    currentHash(id) { const job = load(id); if (!job.agreedCandidate) throw bad('Nothing agreed yet', 409); return hashOf(id, job.agreedCandidate); },
    reportBuild(id, author, { summary, blueprint_name, built, saved, placed, candidate_sha256, evidence = [] }) {
      const job = load(id);
      if (job.status !== 'building') throw bad('The job is not building', 409);
      // Unknown stays unknown (Codex #652): nothing is assumed from a missing field.
      if (typeof built !== 'boolean') throw bad('Say built: true (with game receipts) or built: false (with what stopped you)');
      // Evidence is the hub's own receipt for generating exactly the bound proposal (Codex #656).
      const generated = evidence.filter(r => r.operation === 'generate' && r.outcome === 'completed' && r.committedActions > 0 && r.matchesProposal === true);
      if (built) {
        if (!job.agreedHash) throw bad('No pinned piece list for this job; it needs a new review', 409);
        // Only the exact agreed piece list may be reported as built (Codex #647).
        if (candidate_sha256 !== job.agreedHash) throw bad(`candidate_sha256 must be the agreed piece list's hash ${job.agreedHash}; anything else needs a new review`, 409);
        if (hashOf(id, job.agreedCandidate) !== job.agreedHash) throw bad('The agreed piece file changed after agreement; it needs a new review', 409);
        if (typeof blueprint_name !== 'string' || !blueprint_name.trim()) throw bad('built: true needs the blueprint_name the game reported');
        const receipt = generated.find(r => r.blueprintName === blueprint_name);
        if (!receipt) throw bad(`built: true needs a committed game_generate receipt for exactly the agreed proposal, named "${blueprint_name}"; none was recorded. Report built: false with what happened instead`, 409);
        if (saved === true && !receipt.savedReadback) throw bad('saved: true needs the native save readback in the generation receipt', 409);
        // Placement is the player's Build Gun click; the hub has no receipt that proves it yet.
        if (placed === true) throw bad('placed: true cannot be checked yet (no world-capture comparison with the agreed poses); leave placed out', 409);
      }
      const tri = v => built && v === true ? true : built && v === false ? false : null;
      job.build = { author, built, saved: tri(saved), placed: tri(placed), candidate_sha256: built ? candidate_sha256 : null,
        receipts: evidence.map(r => ({ id: r.id, operation: r.operation, outcome: r.outcome, committedActions: r.committedActions ?? null, matchesProposal: r.matchesProposal ?? null, blueprintName: r.blueprintName ?? null, savedReadback: r.savedReadback ?? null })),
        summary: text(summary, 4000, 'Summary'), blueprint_name: typeof blueprint_name === 'string' ? blueprint_name.slice(0, 200) : null, at: now() };
      log(job, author, `Build reported: ${job.build.summary.slice(0, 200)}`);
      return save(job);
    },
    needsOwner(id, reason) { const job = load(id); job.status = 'needs-owner'; log(job, 'studio', reason); return save(job); },
    // Owner controls.
    stop(id) { const job = load(id); job.status = 'stopped'; log(job, 'owner', 'Stopped'); return save(job); },
    pick(id, n) {
      const job = load(id); const c = job.candidates.find(x => x.n === Number(n));
      if (!c) throw bad('Unknown candidate', 404);
      job.status = 'agreed'; job.agreedCandidate = c.n; pin(job, c.n); log(job, 'owner', `Owner picked candidate ${c.n}`); return save(job);
    },
    // Notes reach both models in their next prompt; they do not change the turn order.
    note(id, line) { const job = load(id); const s = text(line, 2000, 'Note'); job.notes.push({ t: now(), text: s }); log(job, 'owner', `Note: ${s}`); return save(job); },
    log(id, who, line) { const job = load(id); log(job, who, line); return save(job); },
  };
}
