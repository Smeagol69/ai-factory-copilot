// The Team room: the hub's front page. One live column per model, read from the
// logs each model's own app writes, plus the owner's milestone strip. Added on
// top of the existing app server like local chat; the earlier page moves to
// /workshop unchanged.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFeedReader, readLocalChats, columnStatus, redact } from './team-feeds.mjs';
import { createTeamState, milestonesForMemory } from './team-state.mjs';

const publicFile = name => fileURLToPath(new URL(`../app/public/${name}`, import.meta.url));
const assets = new Map([['/team.js', ['team.js', 'text/javascript']], ['/team.css', ['team.css', 'text/css']]]);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const DAY2 = 48 * 3600000;

async function readBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw Object.assign(Error('Use application/json'), { statusCode: 415 });
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 16384) throw Object.assign(Error('Request too large'), { statusCode: 413 }); chunks.push(chunk); }
  try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!v || Array.isArray(v) || typeof v !== 'object') throw Error(); return v; }
  catch { throw Object.assign(Error('Invalid JSON request'), { statusCode: 400 }); }
}

export function createTeamRoom({ root, roots, codexHome, claudeHome, localModelUrl = 'http://127.0.0.1:11436', defaultLocal = [],
  readLedger = () => [], publishMilestones = async () => ({ published: false }), fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const reader = createFeedReader({ codexHome, claudeHome, roots });
  const state = createTeamState(root, { now, defaultLocal });
  let installed = { at: 0, models: null };
  const installedModels = async () => {
    if (now() - installed.at < 15000) return installed.models;
    let models = null;
    try {
      const r = await fetchImpl(`${localModelUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) models = ((await r.json()).models ?? []).map(m => String(m.name)).filter(Boolean).slice(0, 50);
    } catch { /* Ollama not running: shown as unknown, never as empty */ }
    installed = { at: now(), models };
    return models;
  };
  const withMessages = (events, messages) => [...events, ...messages].sort((a, b) => a.t - b.t).slice(-80);

  return {
    state,
    async view() {
      const t = now(), feeds = reader.read(t);
      let ledger = [];
      try { ledger = readLedger().filter(m => m.t >= t - DAY2); } catch { /* ledger unavailable: columns still show the logs */ }
      const messagesFor = prefix => ledger.filter(m => String(m.sender).startsWith(prefix))
        .map(m => ({ t: m.t, kind: 'message', text: redact(m.subject).slice(0, 200), session: m.sender }));
      const roster = state.roster();
      const local = readLocalChats(join(root, 'state/local-worker/chats'), { since: t - DAY2 });
      const sub = (id, name, app, feed) => {
        const events = withMessages(feed.events, messagesFor(id));
        const lastAt = Math.max(feed.lastAt ?? 0, events.at(-1)?.t ?? 0) || null;
        return { id, name, app, kind: 'subscription', canStop: false, sessions: feed.sessions, usage: feed.usage,
          status: columnStatus({ lastAt, usage: feed.usage, limitAt: feed.limitAt, manualOut: state.manualOut(id) }, t), lastAt, events };
      };
      const columns = [
        sub('codex', 'Codex', 'Codex app · ChatGPT subscription', feeds.codex),
        sub('claude', 'Claude', 'Claude Code · Claude subscription', feeds.claude),
        ...roster.local.map((m, i) => {
          const events = local.events.filter(e => e.model ? e.model === m.model : i === 0);
          const lastAt = events.at(-1)?.t ?? null;
          return { id: `local:${m.model}`, name: m.model.replace(/:latest$/, ''), app: 'Ollama on this PC · free', kind: 'local', role: m.role,
            canStop: false, sessions: [], status: columnStatus({ lastAt, standby: m.role === 'backup worker' }, t), lastAt, events };
        }),
      ];
      return { observedAt: new Date(t).toISOString(), columns, milestones: state.milestones(), roster,
        installedLocal: await installedModels(), modelCalls: 0,
        connect: { repo: join(root, '..'), servers: ['agent_pair', 'superpowers', 'rea', 'local_model'] } };
    },
    async changeMilestones(args) {
      const items = state.changeMilestones(args);
      let shared;
      try { shared = await publishMilestones(milestonesForMemory(items)); } catch (e) { shared = { published: false, error: redact(e?.message ?? 'failed').slice(0, 200) }; }
      return { milestones: items, shared };
    },
    async changeRoster(args) { return { roster: state.changeRoster(args) }; },
  };
}

export function attachTeamRoom(server, room) {
  const previous = server.listeners('request'); server.removeAllListeners('request');
  server.on('request', (req, res) => {
    const pass = () => { for (const l of previous) l.call(server, req, res); };
    // The earlier page lives on at /workshop; the server underneath serves it as '/'.
    if (req.url === '/workshop' || req.url?.startsWith('/workshop?')) { req.url = '/'; pass(); return; }
    if (!(req.url === '/' || assets.has(req.url) || req.url?.startsWith('/api/team'))) { pass(); return; }
    const json = (code, data) => { const text = JSON.stringify(data); if (Buffer.byteLength(text) > 1048576) { res.writeHead(503).end('Too large'); return; } res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }).end(text); };
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', CSP);
    const authority = `127.0.0.1:${req.socket.localPort}`, origin = `http://${authority}`;
    if (req.headers.host !== authority || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') { req.resume(); json(403, { error: 'Local application origin required' }); return; }
    (async () => {
      if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(readFileSync(publicFile('team.html'))); return; }
      if (req.method === 'GET' && assets.has(req.url)) { const [f, type] = assets.get(req.url); res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }).end(readFileSync(publicFile(f))); return; }
      if (req.method === 'GET' && req.url === '/api/team') { json(200, await room.view()); return; }
      if (req.method === 'POST' && req.url === '/api/team/milestones') { json(200, await room.changeMilestones(await readBody(req))); return; }
      if (req.method === 'POST' && req.url === '/api/team/models') { json(200, await room.changeRoster(await readBody(req))); return; }
      req.resume(); json(404, { error: 'Unknown Team room route' });
    })().catch(error => { if (!res.writableEnded) json(error.statusCode ?? 503, { error: redact(error?.message ?? 'Team room unavailable').slice(0, 300) }); });
  });
  return server;
}
