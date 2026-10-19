// Design studio page and API on the hub server: the owner writes a brief, the
// conductor runs Codex and Claude through candidate → critique → agree → build,
// and every render, critique and decision shows here. Same local-origin rules
// as the rest of the hub.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextStep, stageOf } from './studio-store.mjs';
import { nextMilestoneStep } from './milestone-work.mjs';
import { createGameLease } from './game-lease.mjs';
import { createGameHandoff } from './game-handoff.mjs';

const publicFile = n => fileURLToPath(new URL(`../app/public/${n}`, import.meta.url));
const assets = new Map([['/studio', ['studio.html', 'text/html']], ['/studio.js', ['studio.js', 'text/javascript']], ['/studio.css', ['studio.css', 'text/css']]]);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw Object.assign(Error('Use application/json'), { statusCode: 415 });
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 16384) throw Object.assign(Error('Request too large'), { statusCode: 413 }); chunks.push(c); }
  try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error(); return v; }
  catch { throw Object.assign(Error('Invalid JSON request'), { statusCode: 400 }); }
}

export function createStudioApi({ root, store, conductor, workerStatus = () => ({}), pump = () => {}, work = null, teamPending = async () => [], mergeTeam = async () => ({ error: 'Not configured' }), handoff = null }) {
  const game = handoff ?? createGameHandoff({ root, conductor });
  // Milestone work for the page: the open (or latest) job with its steps and reviews.
  const milestoneWork = () => {
    const j = work?.open() ?? work?.list()[0] ?? null;
    return j ? { id: j.id, milestone: j.milestone, status: j.status, next: nextMilestoneStep(j), steps: j.steps, recent: j.events.slice(-15) } : null;
  };
  const summary = j => ({ id: j.id, brief: j.brief, status: j.status, stage: stageOf(j), createdAt: j.createdAt, candidates: j.candidates.length, agreedCandidate: j.agreedCandidate, next: nextStep(j) });
  const full = j => ({ ...j, stage: stageOf(j), next: nextStep(j), candidates: j.candidates.map(c => ({ ...c, renderUrl: c.render ? `/api/studio/render/${j.id}/${c.render}` : null,
    interiorUrl: c.render && existsSync(join(store.dirOf(j.id), c.render.replace(/\.png$/, '-interior.png'))) ? `/api/studio/render/${j.id}/${c.render.replace(/\.png$/, '-interior.png')}` : null })) });
  return {
    overview: async () => ({ jobs: store.list().slice(0, 30).map(summary), conductor: conductor.status(), workers: workerStatus(), conductorMayOperateGame: game.mayOperate(), handoff: await game.view(), gameLease: createGameLease(root).current(),
      milestoneWork: milestoneWork(), teamPending: await teamPending() }),
    async teamMerge() { const r = await mergeTeam(); if (r.error) throw Object.assign(Error(r.error), { statusCode: 409 }); return r; },
    milestoneAction(args) {
      const j = work?.list()[0];
      if (!j) throw Object.assign(Error('No milestone work yet'), { statusCode: 404 });
      if (args.action === 'stop') return work.stop(j.id);
      // Resume after the owner sorted out a stop or a failed merge: a fresh job continues the milestone.
      if (args.action === 'resume') { if (['needs-owner', 'stopped'].includes(j.status)) work.close(j.id, 'Resumed by the owner'); pump(); return { resumed: true }; }
      throw Object.assign(Error('Unknown milestone action'), { statusCode: 400 });
    },
    job: id => full(store.get(id)),
    create(args) { const j = store.create({ brief: args.brief, firstDesigner: args.firstDesigner ?? 'codex' }); pump(); return full(j); },
    act(id, args) {
      if (args.action === 'stop') return full(store.stop(id));
      if (args.action === 'pick') { const j = store.pick(id, args.candidate); pump(); return full(j); }
      if (args.action === 'note') { const j = store.note(id, args.text); pump(); return full(j); }
      throw Object.assign(Error('Unknown job action'), { statusCode: 400 });
    },
    async conductorAction(args) {
      if (args.action === 'on') { const r = conductor.set(true); pump(); return r; }
      if (args.action === 'off') return conductor.set(false);
      if (args.action === 'stop') return conductor.stop();
      // The owner checked the game after an unresolved transaction and clears it.
      if (args.action === 'resolve-game') { if (conductor.status().running) throw Object.assign(Error('Wait for the running turn to end first'), { statusCode: 409 }); return { resolved: createGameLease(root).resolve() }; }
      throw Object.assign(Error('Unknown conductor action'), { statusCode: 400 });
    },
    // The owner's handoff: refused unless every readiness check passes now; taking
    // control back ends any running game turn first.
    async setOperator(args) {
      if (typeof args.conductor !== 'boolean') throw Object.assign(Error('conductor must be true or false'), { statusCode: 400 });
      return args.conductor ? game.handOver() : game.takeBack();
    },
    renderFile(id, name) {
      if (!uuid.test(id) || !/^candidate-\d{1,3}(-interior)?\.png$/.test(name)) return null;
      const f = join(store.dirOf(id), name); return existsSync(f) ? f : null;
    },
  };
}

export function attachStudio(server, api) {
  const previous = server.listeners('request'); server.removeAllListeners('request');
  server.on('request', (req, res) => {
    const url = req.url ?? '';
    if (!(assets.has(url) || url.startsWith('/api/studio'))) { for (const l of previous) l.call(server, req, res); return; }
    const json = (code, data) => res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', CSP);
    const authority = `127.0.0.1:${req.socket.localPort}`, origin = `http://${authority}`;
    if (req.headers.host !== authority || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') { req.resume(); json(403, { error: 'Local application origin required' }); return; }
    (async () => {
      if (req.method === 'GET' && assets.has(url)) { const [f, type] = assets.get(url); res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }).end(readFileSync(publicFile(f))); return; }
      if (req.method === 'GET' && url === '/api/studio') { json(200, await api.overview()); return; }
      let m = url.match(/^\/api\/studio\/render\/([0-9a-f-]{36})\/(candidate-\d{1,3}(?:-interior)?\.png)$/);
      if (req.method === 'GET' && m) { const f = api.renderFile(m[1], m[2]); if (!f) { json(404, { error: 'No render' }); return; } res.writeHead(200, { 'Content-Type': 'image/png' }).end(readFileSync(f)); return; }
      m = url.match(/^\/api\/studio\/jobs\/([0-9a-f-]{36})$/);
      if (m && req.method === 'GET') { json(200, api.job(m[1])); return; }
      if (m && req.method === 'POST') { json(200, api.act(m[1], await body(req))); return; }
      if (req.method === 'POST' && url === '/api/studio/jobs') { json(200, api.create(await body(req))); return; }
      if (req.method === 'POST' && url === '/api/studio/conductor') { json(200, await api.conductorAction(await body(req))); return; }
      if (req.method === 'POST' && url === '/api/studio/operator') { json(200, await api.setOperator(await body(req))); return; }
      if (req.method === 'POST' && url === '/api/studio/team-merge') { req.resume(); json(200, await api.teamMerge()); return; }
      if (req.method === 'POST' && url === '/api/studio/milestone-work') { json(200, api.milestoneAction(await body(req))); return; }
      req.resume(); json(404, { error: 'Unknown studio route' });
    })().catch(e => { if (!res.writableEnded) json(e.statusCode ?? 503, { error: String(e.message ?? 'Studio unavailable').slice(0, 300) }); });
  });
  return server;
}
