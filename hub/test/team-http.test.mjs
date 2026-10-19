import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamRoom, attachTeamRoom } from '../lib/team-http.mjs';

const REPO = 'C:\\Users\\owner\\Documents\\satisfactory';

async function start({ published = [], ledger = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'room-'));
  const root = join(home, 'hub');
  const codex = join(home, 'codex', 'sessions', '2026', '10', '19');
  mkdirSync(codex, { recursive: true }); mkdirSync(join(root, 'state'), { recursive: true });
  const t = new Date().toISOString();
  writeFileSync(join(codex, 'rollout-x.jsonl'), [
    { timestamp: t, type: 'session_meta', payload: { id: 'session-abcdef', cwd: REPO } },
    { timestamp: t, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fitting the sweep to the walled tunnel.' }] } },
  ].map(j => JSON.stringify(j)).join('\n') + '\n');
  const room = createTeamRoom({ root, roots: [REPO], codexHome: join(home, 'codex'), claudeHome: join(home, 'claude'), defaultLocal: ['copilot-hauhau-game:latest'],
    readLedger: () => ledger, publishMilestones: async v => { published.push(v); return { published: true }; },
    fetchImpl: async () => ({ ok: true, json: async () => ({ models: [{ name: 'copilot-hauhau-game:latest' }, { name: 'qwen3:8b' }] }) }) });
  const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }).end(`underlying:${req.url}`); });
  attachTeamRoom(server, room);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, published };
}
const post = (base, path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('the Team room is the front page and the earlier page lives on at /workshop', async () => {
  const { server, base } = await start();
  try {
    const home = await (await fetch(base + '/')).text();
    assert.match(home, /Team room/);
    assert.equal(await (await fetch(base + '/workshop')).text(), 'underlying:/');
    assert.equal(await (await fetch(base + '/api/status')).text(), 'underlying:/api/status');
    assert.equal((await fetch(base + '/team.js')).status, 200);
  } finally { server.close(); }
});

test('the view has live columns, HauhauCS on standby, installed models and ledger messages', async () => {
  const { server, base } = await start({ ledger: [{ sender: 'codex-14540', subject: 'Deployed fitted fixtures', t: Date.now() + 5000 }] });
  try {
    const v = await (await fetch(base + '/api/team')).json();
    assert.deepEqual(v.columns.map(c => c.id), ['codex', 'claude', 'local:copilot-hauhau-game:latest']);
    const codex = v.columns[0];
    assert.equal(codex.status.state, 'working');
    assert.deepEqual(codex.events.map(e => e.kind), ['say', 'message']);
    assert.equal(v.columns[1].status.state, 'idle');
    assert.equal(v.columns[2].status.state, 'standby');
    assert.deepEqual(v.installedLocal, ['copilot-hauhau-game:latest', 'qwen3:8b']);
    assert.equal(v.modelCalls, 0);
  } finally { server.close(); }
});

test('milestone changes are saved and published to shared memory; bad input and foreign origins are refused', async () => {
  const { server, base, published } = await start();
  try {
    const r = await (await post(base, '/api/team/milestones', { action: 'add', title: 'Factory floor that places in game' })).json();
    assert.equal(r.milestones.length, 1);
    assert.equal(r.shared.published, true);
    assert.match(published.at(-1), /1\. \[○ planned\] Factory floor that places in game/);
    const bad = await post(base, '/api/team/milestones', { action: 'add', title: '' });
    assert.equal(bad.status, 400);
    const foreign = await post(base, '/api/team/milestones', { action: 'add', title: 'x' }, { Origin: 'http://evil.example' });
    assert.equal(foreign.status, 403);
    const wrongType = await fetch(base + '/api/team/milestones', { method: 'POST', body: '{}' });
    assert.equal(wrongType.status, 415);
    const added = await (await post(base, '/api/team/models', { action: 'add', model: 'qwen3:8b', role: 'reviewer' })).json();
    assert.equal(added.roster.local.length, 2);
  } finally { server.close(); }
});

test('the backup shift is shown on the local column and switched from the page', async () => {
  const home = mkdtempSync(join(tmpdir(), 'room-shift-')), root = join(home, 'hub');
  mkdirSync(join(root, 'state/team'), { recursive: true });
  writeFileSync(join(root, 'state/team/local-events.jsonl'), JSON.stringify({ t: Date.now(), kind: 'tool', text: 'shift_read_file: companion/lib/turn.mjs', model: 'copilot-hauhau-game:latest' }) + '\n');
  let enabled = false, running = null;
  const shift = { status: async () => ({ enabled, running, decision: 'Waiting', branch: 'local/shift', needsReview: [{ commit: 'abcdef1234', summary: 'added a test' }] }),
    set: async v => { enabled = v; return shift.status(); }, stop: async () => { enabled = false; running = null; return shift.status(); } };
  const room = createTeamRoom({ root, roots: [REPO], defaultLocal: ['copilot-hauhau-game:latest'], shift, fetchImpl: async () => { throw new Error('offline'); } });
  const server = createServer((req, res) => res.end('x')); attachTeamRoom(server, room);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let v = await (await fetch(base + '/api/team')).json();
    const local = v.columns.find(c => c.kind === 'local');
    assert.equal(local.shift.needsReview[0].summary, 'added a test');
    assert.equal(local.events.at(-1).text, 'shift_read_file: companion/lib/turn.mjs');
    assert.equal(v.installedLocal, null, 'Ollama offline is unknown, not empty');
    assert.equal((await (await post(base, '/api/team/shift', { action: 'on' })).json()).shift.enabled, true);
    running = { startedAt: new Date().toISOString(), milestone: 'Turn' };
    v = await (await fetch(base + '/api/team')).json();
    assert.equal(v.columns.find(c => c.kind === 'local').status.state, 'working');
    assert.equal((await (await post(base, '/api/team/shift', { action: 'stop' })).json()).shift.enabled, false);
    assert.equal((await post(base, '/api/team/shift', { action: 'explode' })).status, 400);
  } finally { server.close(); }
});
