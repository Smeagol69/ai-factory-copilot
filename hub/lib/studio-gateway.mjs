// The named tools the conductor's Claude and Codex workers get through the
// "studio" MCP server: design (candidates, critiques, renders, saved references)
// and three game actions (status, capture/look, ask the in-game Copilot). Every
// game request is logged, and anything that could change the world is preceded
// by a copy of the newest save. The game itself validates and reads back actions.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStudioStore, nextStep } from './studio-store.mjs';
import { renderPng, boundsFromMeasurements } from './design-render.mjs';
import { createGameLease } from './game-lease.mjs';

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

export function createStudioGateway({ root, repo, worker, playtest = null, render = renderPng, inspectSaved = null, saveDir = SAVE_DIR, blueprintDir = BLUEPRINT_DIR, now = Date.now, bounds = () => loadMeasuredBounds(root), mayOperate = () => conductorMayOperate(root), lease = null }) {
  // Game requests: the Codex worker only, and only after the live operator hands off.
  const holder = `conductor-${worker}`;
  const gameLease = lease ?? createGameLease(root, { now, mayOperate });
  // World-changing requests are Codex's; read-only capture/look is open to either
  // worker. Both need the game lease, held for the whole build/verify transaction.
  const gameGate = (kind = 'read') => {
    if (!playtest) throw new Error('Game mailbox unavailable');
    if (kind === 'write' && worker !== 'codex') throw new Error('Game actions that change the world belong to Codex; post your findings for it instead');
    return gameLease.require(holder);
  };
  const store = createStudioStore(root, { now });
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
      const job = store.reportBuild(activeId(job_id), worker, { summary, blueprint_name, built, saved, placed, candidate_sha256 });
      // The report closes the build transaction (readback is done): free the game.
      if (gameLease.release(holder)) gameLog({ operation: 'lease-release', reason: 'build reported' });
      return { status: job.status, stage: job.stage, next: nextStep(job) };
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
    game_lease({ action, purpose, job_id }) {
      if (action === 'acquire') { const l = gameLease.acquire(holder, { purpose, job: job_id ?? null }); gameLog({ operation: 'lease-acquire', purpose: l.purpose }); return { holder: l.owner, expiresAt: l.expiresAt }; }
      if (action === 'release') { const released = gameLease.release(holder); if (released) gameLog({ operation: 'lease-release' }); return { released }; }
      throw bad('action is acquire or release');
    },
    async game_capture({ operation = 'capture' } = {}) {
      gameGate('read');
      if (!['capture', 'look'].includes(operation)) throw bad('operation is capture or look');
      const job = await playtest.submit({ operation }); gameLog({ operation, id: job.id });
      const r = await playtest.wait(job); gameLog({ operation, id: job.id, completed: r.pipelineCompleted });
      return r;
    },
    async game_ask({ question }) {
      gameGate('write');
      if (typeof question !== 'string' || !question.trim() || question.length > 4000) throw bad('question is 1–4000 characters');
      const backupFile = backup();
      const job = await playtest.submit({ operation: 'askall', question }); gameLog({ operation: 'askall', id: job.id, question, backupFile });
      const r = await playtest.wait(job, { timeoutMs: 120000 });
      gameLog({ operation: 'askall', id: job.id, committedActions: r.committedActions, worldMutationObserved: r.worldMutationObserved });
      return { ...r, saveBackup: backupFile };
    },
  };
  return {
    names: Object.keys(tools),
    async dispatch(name, args) { const fn = tools[name]; if (!fn) throw bad('Unknown studio tool'); return fn(args ?? {}); },
    store,
  };
}
