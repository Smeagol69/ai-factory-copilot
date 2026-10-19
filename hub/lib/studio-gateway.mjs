// The named tools the conductor's Claude and Codex workers get through the
// "studio" MCP server: design (candidates, critiques, renders, saved references)
// and the game: status, capture/look, and typed generation of the agreed design.
// Every game request is logged, and generation is preceded by a copy of the newest
// save. There is no free-text game request: a question to the in-game model cannot
// be bound to what was agreed (Codex #656). The game validates and reads back.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createStudioStore, nextStep } from './studio-store.mjs';
import { renderPng, boundsFromMeasurements } from './design-render.mjs';
import { createGameLease } from './game-lease.mjs';
import { loadGameCatalog } from './game-catalog.mjs';
import { createMilestoneWork, nextMilestoneStep } from './milestone-work.mjs';

// Measured native bounds saved by game runs (e.g. Codex's *-native-measurements.json).
export function loadMeasuredBounds(root) {
  const files = [];
  const visit = (d, depth) => { let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const p = join(d, e.name); if (e.isDirectory() && depth > 0) visit(p, depth - 1);
      else if (e.isFile() && /measurements.*\.json$/i.test(e.name) && statSync(p).size < 4 * 1024 * 1024) { try { files.push(JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''))); } catch { /* unreadable file: skipped */ } } } };
  visit(join(root, 'state/live-architect'), 2); visit(join(root, 'state/studio/measurements'), 0);
  return boundsFromMeasurements(files);
}

// Codex's live session is the only game operator until it hands off. The flag
// lives in state/studio/game-operator.json: {"conductor": true} after handoff.
export function conductorMayOperate(root) {
  try { return JSON.parse(readFileSync(join(root, 'state/studio/game-operator.json'), 'utf8').replace(/^﻿/, '')).conductor === true; } catch { return false; }
}

const bad = m => Object.assign(new Error(m), { statusCode: 400 });
export const GAME_BUILDERS = ['codex', 'claude'];
const LOCAL = process.env.LOCALAPPDATA ?? '';
export const SAVE_DIR = join(LOCAL, 'FactoryGame/Saved/SaveGames');
export const BLUEPRINT_DIR = join(LOCAL, 'FactoryGame/Saved/SaveGames/blueprints');

export function newestSave(dir = SAVE_DIR) {
  let best = null;
  const visit = (d, depth) => { let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const p = join(d, e.name);
      if (e.isDirectory() && depth > 0 && e.name !== 'blueprints') visit(p, depth - 1);
      else if (e.isFile() && e.name.endsWith('.sav')) { const m = statSync(p).mtimeMs; if (!best || m > best.m) best = { p, m }; } } };
  visit(dir, 2);
  return best?.p ?? null;
}

// The typed proposal must be the agreed piece list, piece for piece: the same
// buildable, position, rotation and scale, in order. The buildable's recipe is the one
// the game itself uses for that class (game catalog); the Build_X -> Recipe_X name
// rule only for a class the catalog does not list (mod recipes live elsewhere).
const namedRecipe = cls => String(cls ?? '').replace(/\/Build_([^/.]+)\.Build_\1_C$/, '/Recipe_$1.Recipe_$1_C');
const recipeOf = cls => loadGameCatalog()?.get(cls)?.recipe_class ?? namedRecipe(cls);
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
export function proposalMismatch(proposal, pieces) {
  if (proposal?.action !== 'generate_native_blueprint' || !Array.isArray(proposal.buildables)) return 'it must be a typed generate_native_blueprint action with buildables';
  if (!String(proposal.layout_schema ?? '').startsWith('aifactory.generated-blueprint/')) return 'layout_schema must be an aifactory.generated-blueprint schema';
  if (proposal.commit !== true) return 'commit must be true';
  if (typeof proposal.blueprint_name !== 'string' || !proposal.blueprint_name.trim() || proposal.blueprint_name.length > 200) return 'blueprint_name is required';
  for (const k of ['conveyors', 'power_wires', 'pipes']) if (Array.isArray(proposal[k]) && proposal[k].length) return `${k} are not part of the agreed piece list`;
  if (proposal.buildables.length !== pieces.length) return `it has ${proposal.buildables.length} buildables but the agreed piece list has ${pieces.length}`;
  for (const [i, b] of proposal.buildables.entries()) {
    const p = pieces[i], t = p.transform ?? {}, n = i + 1;
    if (b?.recipe_class !== recipeOf(p.class_path)) return `buildable ${n} is ${b?.recipe_class}, not the agreed ${p.class_path}`;
    const at = b.relative_location ?? {}, want = t.translation_cm ?? {};
    if (!['x', 'y', 'z'].every(k => near(at[k], want[k], 0.01))) return `buildable ${n} is not at the agreed position`;
    const q = b.rotation_quat ?? {}, r = t.rotation_quat ?? {};
    const dot = ['x', 'y', 'z', 'w'].reduce((sum, k) => sum + q[k] * r[k], 0);
    if (!near(Math.abs(dot), 1, 1e-6)) return `buildable ${n} is not at the agreed rotation`;
    const sc = b.scale3d ?? { x: 1, y: 1, z: 1 }, sw = t.scale3d ?? { x: 1, y: 1, z: 1 };
    if (!['x', 'y', 'z'].every(k => near(sc[k], sw[k], 1e-6))) return `buildable ${n} is not at the agreed scale`;
  }
  return null;
}

export function createStudioGateway({ root, repo, worker, playtest = null, typedRoute = null, render = renderPng, inspectSaved = null, saveDir = SAVE_DIR, blueprintDir = BLUEPRINT_DIR, now = Date.now, bounds = () => loadMeasuredBounds(root), mayOperate = () => conductorMayOperate(root), lease = null, milestones = null }) {
  const work = milestones ?? createMilestoneWork(root, { now });
  const openWork = id => id ? work.get(id) : work.open() ?? (() => { throw bad('No open milestone job'); })();
  // Game requests need the game lease, which belongs to this gateway's own session
  // and is proven by a token that never leaves this process.
  const session = `conductor-${worker}:${randomUUID()}`;
  let leaseToken = null;
  const gameLease = lease ?? createGameLease(root, { now, mayOperate });
  const store = createStudioStore(root, { now });
  const fileHash = f => 'sha256:' + createHash('sha256').update(readFileSync(f)).digest('hex');
  // World-changing requests are Codex's, and only for the agreed design that is
  // building, with its piece list and typed proposal unchanged since they were
  // pinned; checked before every submission. Read-only capture/look is open to
  // either worker holding the lease.
  const gameGate = (kind = 'read', token = leaseToken) => {
    if (!playtest) throw new Error('Game mailbox unavailable');
    // Codex and Claude may both build agreed designs (owner decision 2026-10-19, while
    // Codex was out of weekly usage); every other safeguard below is unchanged.
    if (kind === 'write' && !GAME_BUILDERS.includes(worker)) throw new Error('Game actions that change the world belong to the studio builders (Codex and Claude); post your findings instead');
    if (!mayOperate()) throw bad("Codex's live session is operating the game; conductor game requests wait for its handoff");
    const l = gameLease.require(session, token);
    if (kind === 'write') {
      if (!l.job) throw bad('World-changing requests need a lease tied to the agreed design job (game_lease acquire with job_id and proposal_file)');
      const job = store.get(l.job);
      if (job.status !== 'building' || !job.agreedHash) throw bad(`Job ${l.job} is ${job.status}; only an agreed design that is building may change the world`);
      if (l.agreedHash !== job.agreedHash || store.currentHash(l.job) !== job.agreedHash) throw bad('The agreed piece list changed since agreement; it needs a new review before anything is built');
      if (!l.proposalHash || !l.proposalFile) throw bad('Bind the typed generation proposal first: game_lease acquire with proposal_file');
      if (!existsSync(l.proposalFile) || fileHash(l.proposalFile) !== l.proposalHash) throw bad('The typed proposal changed since the lease was taken; it needs a new review');
    }
    return l;
  };
  const readJson = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const studio = join(root, 'state/studio');
  const readPieces = ({ pieces, pieces_file }) => {
    if (Array.isArray(pieces)) return pieces;
    if (typeof pieces_file !== 'string' || !pieces_file) throw bad('Give pieces (an array) or pieces_file (a JSON file path)');
    const file = isAbsolute(pieces_file) ? pieces_file : resolve(repo, pieces_file);
    const inside = [resolve(repo) + sep, resolve(studio) + sep].some(p => resolve(file).startsWith(p)) || resolve(file).toLowerCase().includes(`${sep}hub${sep}workspaces${sep}`);
    if (!inside) throw bad('pieces_file must be inside the repo or the studio folder');
    if (!existsSync(file) || statSync(file).size > 5 * 1024 * 1024) throw bad('pieces_file is missing or larger than 5 MB');
    const data = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return Array.isArray(data) ? data : data?.pieces ?? data?.reference_traits?.poses ?? data?.parts ?? fail();
    function fail() { throw bad('pieces_file must hold an array of pieces, {pieces:[…]}, or a saved inspection'); }
  };
  const activeId = id => id ?? store.list().find(j => !['done', 'stopped'].includes(j.status))?.id ?? (() => { throw bad('No open design job'); })();
  const gameLog = entry => { mkdirSync(studio, { recursive: true }); appendFileSync(join(studio, 'game-actions.jsonl'), JSON.stringify({ t: new Date(now()).toISOString(), worker, ...entry }) + '\n'); };
  const backup = () => {
    const save = newestSave(saveDir);
    if (!save) throw new Error('No save file found to back up; refusing a game request that could change the world');
    const dir = join(studio, 'save-backups'); mkdirSync(dir, { recursive: true });
    const target = join(dir, `${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${basename(save)}`);
    copyFileSync(save, target);
    return target;
  };

  const tools = {
    studio_job({ job_id } = {}) {
      const job = store.get(activeId(job_id)), d = store.dirOf(job.id);
      return { id: job.id, brief: job.brief, status: job.status, stage: job.stage, next: nextStep(job), notes: job.notes.map(n => n.text), agreedCandidate: job.agreedCandidate, agreedHash: job.agreedHash ?? null, build: job.build,
        candidates: job.candidates.map(c => ({ ...c, pieces_file: join(d, c.file), render_png: c.render ? join(d, c.render) : null })),
        critiques: job.critiques, recent: job.events.slice(-12).map(e => `${e.who}: ${e.text}`) };
    },
    async studio_post_candidate({ job_id, title, rationale, source, ...rest }) {
      const id = activeId(job_id), cand = store.addCandidate(id, worker, { title, rationale, source, pieces: readPieces(rest) });
      let render_png = null, render_error = null;
      try { const r = await render(store.piecesOf(id, cand.n), join(store.dirOf(id), `candidate-${cand.n}.png`), { title: `Candidate ${cand.n} by ${worker}: ${cand.title}`, bounds: bounds() }); store.setRender(id, cand.n, `candidate-${cand.n}.png`); render_png = r.file; }
      catch (e) { render_error = e.message; }
      return { candidate: cand.n, pieces: cand.pieces, render_png, render_error, next: nextStep(store.get(id)) };
    },
    studio_post_critique({ job_id, candidate, verdict, critique }) {
      const job = store.addCritique(activeId(job_id), worker, { candidate, verdict, critique });
      return { status: job.status, agreedCandidate: job.agreedCandidate, next: nextStep(job) };
    },
    studio_report_build({ job_id, summary, blueprint_name, built, saved, placed, candidate_sha256 }) {
      // Claims are checked against the receipts the hub recorded under this session's
      // lease for this job and its bound proposal, never against the model's word.
      const id = activeId(job_id);
      let evidence = [];
      if (leaseToken) {
        const l = gameLease.require(session, leaseToken);
        if (l.job === id) evidence = l.requests.filter(r => r.proposalHash && r.proposalHash === l.proposalHash);
      }
      const job = store.reportBuild(id, worker, { summary, blueprint_name, built, saved, placed, candidate_sha256, evidence });
      // The report closes the transaction; an unknown outcome leaves it for the owner.
      let transaction = null;
      if (leaseToken) { transaction = gameLease.close(session, leaseToken); gameLog({ operation: 'lease-close', result: transaction }); leaseToken = null; }
      return { status: job.status, stage: job.stage, next: nextStep(job), transaction };
    },
    studio_milestone({ job_id } = {}) {
      const job = openWork(job_id);
      return { id: job.id, milestone: job.milestone, status: job.status, next: nextMilestoneStep(job),
        steps: job.steps.map(s => ({ n: s.n, author: s.author, branch: s.branch, commit: s.commit, summary: s.summary, fixing: s.fixing, review: s.review, merged: s.merged })),
        recent: job.events.slice(-12).map(e => `${e.who}: ${e.text}`) };
    },
    studio_report_step({ job_id, summary, commit, branch }) {
      const job = work.reportStep(openWork(job_id).id, worker, { summary, commit, branch });
      return { step: job.steps.length, next: nextMilestoneStep(job) };
    },
    studio_review_step({ job_id, step, commit, verdict, review }) {
      const job = work.reviewStep(openWork(job_id).id, worker, { step, commit, verdict, review });
      return { next: nextMilestoneStep(job) };
    },
    async studio_render({ title = 'Draft', ...rest }) {
      mkdirSync(join(studio, 'scratch'), { recursive: true });
      const file = join(studio, 'scratch', `${randomUUID()}.png`);
      const r = await render(readPieces(rest), file, { title, bounds: bounds() });
      return { render_png: r.file, pieces: r.pieces, skipped: r.skipped };
    },
    async studio_read_blueprint({ name }) {
      if (typeof name !== 'string' || !name.trim() || /[\\/:*?"<>|]/.test(name)) throw bad('Give the blueprint name as shown in the game, without a path');
      const found = [];
      const visit = (d, depth) => { let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of es) { const p = join(d, e.name); if (e.isDirectory() && depth > 0) visit(p, depth - 1); else if (e.isFile() && e.name.toLowerCase() === `${name.toLowerCase()}.sbp`) found.push(p); } };
      visit(blueprintDir, 2);
      if (!found.length) throw bad(`No saved blueprint named "${name}"`);
      if (!inspectSaved) throw new Error('Blueprint reader unavailable');
      const sbp = found[0], cfg = sbp.replace(/\.sbp$/i, '.sbpcfg');
      const r = await inspectSaved(name, readFileSync(sbp), existsSync(cfg) ? readFileSync(cfg) : null);
      const poses = r?.reference_traits?.poses;
      if (!Array.isArray(poses)) throw new Error('The blueprint could not be read into pieces');
      const dir = join(studio, 'references'); mkdirSync(dir, { recursive: true });
      const file = join(dir, `${name.replace(/[^\w.-]+/g, '_')}.json`);
      writeFileSync(file, JSON.stringify({ name, pieces: poses.map(p => ({ class_path: p.class_path, transform: p.transform })) }));
      const counts = {}; for (const p of poses) { const k = String(p.class_path).split('.').pop(); counts[k] = (counts[k] ?? 0) + 1; }
      return { name, pieces_file: file, pieces: poses.length, classes: counts, designer_dimensions: r.header?.designer_dimensions ?? null };
    },
    async game_status() {
      if (!playtest) throw new Error('Game mailbox unavailable');
      return { ...(await playtest.status()), conductorMayOperate: mayOperate(), lease: gameLease.current(), worker };
    },
    game_lease({ action, purpose, job_id, proposal_file }) {
      if (action === 'acquire') {
        let job = null, agreedHash = null, proposalFile = null, proposalHash = null, blueprintName = null;
        if (job_id) {
          job = store.get(job_id);
          if (job.status !== 'building' || !job.agreedHash) throw bad(`Job ${job_id} is ${job.status}; a build lease needs an agreed design that is building`);
          agreedHash = job.agreedHash;
          if (proposal_file) {
            proposalFile = isAbsolute(proposal_file) ? proposal_file : resolve(repo, proposal_file);
            if (!existsSync(proposalFile) || statSync(proposalFile).size > 5 * 1024 * 1024) throw bad('proposal_file is missing or larger than 5 MB');
            // Hash first, then check those exact bytes: what is pinned is what was checked.
            const bytes = readFileSync(proposalFile);
            let proposal; try { proposal = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { throw bad('proposal_file is not JSON'); }
            if (store.currentHash(job_id) !== job.agreedHash) throw bad('The agreed piece list changed since agreement; it needs a new review');
            const mismatch = proposalMismatch(proposal, store.piecesOf(job_id, job.agreedCandidate));
            if (mismatch) throw bad(`The proposal is not the agreed design: ${mismatch}`);
            proposalHash = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
            blueprintName = proposal.blueprint_name;
          }
        }
        const l = gameLease.acquire({ session, worker, purpose, job: job?.id ?? null, agreedHash, proposalHash, proposalFile, blueprintName });
        leaseToken = l.token;
        gameLog({ operation: 'lease-acquire', purpose: l.purpose, job: l.job, agreedHash, proposalHash });
        return { worker, job: l.job, agreedHash, proposalHash, expiresAt: l.expiresAt };
      }
      if (action === 'release') {
        const result = leaseToken ? gameLease.release(session, leaseToken) : false;
        if (result) { gameLog({ operation: 'lease-release', result }); leaseToken = null; }
        return result === 'unresolved' ? { released: false, unresolved: true, reason: 'World requests were made; only a build report closes them. The owner must check the game and resolve it' } : { released: result === true };
      }
      throw bad('action is acquire or release');
    },
    async game_capture({ operation = 'capture' } = {}) {
      gameGate('read');
      if (!['capture', 'look'].includes(operation)) throw bad('operation is capture or look');
      const job = await playtest.submit({ operation });
      gameLease.record(session, leaseToken, { id: job.id, operation, outcome: 'submitted' }); gameLog({ operation, id: job.id });
      let r;
      try { r = await playtest.wait(job); }
      catch (e) { gameLease.record(session, leaseToken, { id: job.id, operation, outcome: 'completed', failed: e.message }); throw e; }
      gameLease.record(session, leaseToken, { id: job.id, operation, outcome: 'completed', completed: r.pipelineCompleted }); gameLog({ operation, id: job.id, completed: r.pipelineCompleted });
      return r;
    },
    // Generate the native blueprint of exactly the bound proposal. The request text
    // comes from the companion's deterministic typed route, never from a model.
    async game_generate() {
      const token = leaseToken, l = gameGate('write', token);
      if (!typedRoute) throw bad('No deterministic typed-generation route exists in the companion yet, so no request can be bound to the agreed proposal. World-changing requests stay off; the validated proposal waits for that route (Codex\'s scope)');
      const proposal = readJson(l.proposalFile);
      const question = await typedRoute.question({ proposal, proposalFile: l.proposalFile, proposalHash: l.proposalHash });
      // Route preparation can await capability checks and exact-byte staging.
      // Recheck the same lease, agreement and proposal after that await.
      gameGate('write', token);
      const backupFile = backup();
      const base = { operation: 'generate', proposalHash: l.proposalHash, intentId: randomUUID() };
      // Persist before submit: the mailbox may accept while its Promise is still
      // pending. Stopping, releasing or expiring now must keep exclusive ownership.
      gameLease.record(session, token, { id: null, ...base, outcome: 'submitting' });
      let job;
      try {
        job = await playtest.submit({ operation: 'askall', question });
        gameLease.submitted(session, token, base.intentId, job?.id);
      }
      catch (e) { gameLease.unknown(session, token, { id: job?.id ?? null, ...base }, `Submitting the generation failed (${e.message}); it may or may not have reached the game`); throw bad(`The generation submission failed and its outcome is unknown: ${e.message}. The transaction is unresolved; do not retry`); }
      gameLog({ operation: 'generate', id: job.id, proposalHash: l.proposalHash, backupFile });
      gameLease.require(session, token); // a stopped or released turn cannot resume
      let r;
      try { r = await playtest.wait(job, { timeoutMs: 120000 }); }
      catch (e) { gameLease.unknown(session, token, { id: job.id, ...base }, `Generation request ${job.id}: ${e.message}; its outcome is unknown`); gameLog({ operation: 'generate', id: job.id, unknown: e.message }); throw bad(`The generation outcome is unknown (${e.message}). The transaction is unresolved for the owner; do not retry`); }
      let v;
      try { v = await typedRoute.verify(r, proposal, { proposalHash: l.proposalHash, request: job }) ?? {}; }
      catch (e) { gameLease.unknown(session, token, { id: job.id, ...base }, `Generation request ${job.id} verification failed: ${e.message}; its outcome is unknown`); gameLog({ operation: 'generate', id: job.id, unknown: e.message }); throw bad(`The generation outcome is unknown (${e.message}). The transaction is unresolved for the owner; do not retry`); }
      const receipt = { id: job.id, ...base, outcome: 'completed', committedActions: r.committedActions ?? 0, matchesProposal: v.matchesProposal === true, blueprintName: v.blueprintName ?? null, savedReadback: v.savedReadback === true };
      gameLease.record(session, token, receipt); gameLog(receipt);
      return { ...r, ...receipt, saveBackup: backupFile };
    },
  };
  return {
    names: Object.keys(tools),
    async dispatch(name, args) { const fn = tools[name]; if (!fn) throw bad('Unknown studio tool'); return fn(args ?? {}); },
    store,
  };
}
