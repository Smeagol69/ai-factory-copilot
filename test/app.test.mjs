import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

const rawStatus = (url, headers) => new Promise((resolve, reject) => {
  const req = request(url, { method: 'POST', headers }, res => { res.resume(); resolve(res.statusCode); });
  req.on('error', reject); req.end();
});

test('control room serves status, blocks browser cross-origin commands and records a real failed check', async () => {
  assert(existsSync(new URL('../lib/app.mjs', import.meta.url)), 'Unified control room must exist');
  const { createAppServer } = await import('../lib/app.mjs');
  const root = mkdtempSync(join(tmpdir(), 'copilot-app-'));
  let checks = 0;
  const server = await createAppServer({ root, project: 'test-project', port: 0,
    readStatus: async () => ({ project: 'test-project', modelCalls: 0 }),
    runCheck: async name => { checks++; if (name === 'rea') throw new Error('engine unavailable'); return { ok: true }; },
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(url)).status, 200);
    const status = await (await fetch(url + '/api/status')).json();
    assert.equal(status.project, 'test-project');
    assert.equal(status.modelCalls, 0);
    for (const headers of [{ origin: 'https://example.com' }, { host: 'evil.example' }]) {
      assert.equal(await rawStatus(url + '/api/checks/rea', headers), 403);
    }
    assert.equal((await fetch(url + '/api/checks/anything', { method: 'POST' })).status, 404);
    assert.equal((await fetch(url + '/api/checks/rea')).status, 405);
    assert.equal(checks, 0);
    const failed = await fetch(url + '/api/checks/rea', { method: 'POST', headers: { origin: url } });
    assert.equal(failed.status, 502);
    assert.equal((await failed.json()).status, 'failed');
    const history = JSON.parse(readFileSync(join(root, 'state/app/checks.json'), 'utf8'));
    assert.equal(history.length, 1);
    assert.equal(history[0].name, 'rea');
    assert.equal(history[0].status, 'failed');
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('duplicate button presses share one check and bounded history survives another check', async () => {
  const { createAppServer } = await import('../lib/app.mjs');
  const root = mkdtempSync(join(tmpdir(), 'copilot-app-'));
  let checks = 0, unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  const server = await createAppServer({ root, project: 'test-project', port: 0,
    readStatus: async () => ({ project: 'test-project' }),
    runCheck: async () => { checks++; await gate; return { ok: true }; },
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = fetch(url + '/api/checks/rea', { method: 'POST' });
    while (!checks) await new Promise(resolve => setTimeout(resolve, 10));
    const second = await fetch(url + '/api/checks/mcp', { method: 'POST' });
    assert.equal(second.status, 409);
    assert.equal(checks, 1);
    unblock();
    assert.equal((await first).status, 200);
    assert.equal((await (await fetch(url + '/api/status')).json()).checks.length, 1);
  } finally {
    unblock();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('check history survives restart after real receipts exceed 128 KiB', async () => {
  const { createAppServer } = await import('../lib/app.mjs');
  const root = mkdtempSync(join(tmpdir(), 'copilot-history-'));
  const options = { root, project: 'test-project', port: 0, readStatus: async () => ({}), runCheck: async () => ({ evidence: 'a'.repeat(9000) }) };
  let server = await createAppServer(options);
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    for (let i = 0; i < 17; i++) assert.equal((await fetch(url + '/api/checks/mcp', { method: 'POST' })).status, 200);
    await new Promise(resolve => server.close(resolve));
    server = await createAppServer(options);
    const result = await (await fetch(`http://127.0.0.1:${server.address().port}/api/status`)).json();
    assert.equal(result.checks.length, 17);
  } finally { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); }
});

test('a structured tool failure stays failed and preserves its evidence', async () => {
  const { createAppServer } = await import('../lib/app.mjs');
  const root = mkdtempSync(join(tmpdir(), 'copilot-failure-'));
  const server = await createAppServer({ root, project: 'test-project', port: 0,
    readStatus: async () => ({}), runCheck: async () => ({ ok: false, error: { stage: 'static-analysis' }, evidenceFile: 'state/rea/failure.json' }) });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/checks/rea`, { method: 'POST' });
    assert.equal(response.status, 502);
    const receipt = await response.json();
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.result.evidenceFile, 'state/rea/failure.json');
  } finally { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); }
});

test('an oversized tool receipt records a bounded failure and keeps the evidence pointer', async () => {
  const { createAppServer } = await import('../lib/app.mjs');
  const root = mkdtempSync(join(tmpdir(), 'copilot-large-'));
  const server = await createAppServer({ root, project: 'test-project', port: 0,
    readStatus: async () => ({}), runCheck: async () => ({ ok: true, evidenceFile: 'state/rea/large.json', output: 'a'.repeat(40000) }) });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/checks/rea`, { method: 'POST' });
    assert.equal(response.status, 502);
    const saved = JSON.parse(readFileSync(join(root, 'state/app/checks.json'), 'utf8'));
    assert.equal(saved[0].status, 'failed');
    assert.equal(saved[0].result.evidenceFile, 'state/rea/large.json');
    assert.equal(saved[0].result.output, undefined);
  } finally { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); }
});

test('a storage failure cannot appear later as a saved passing check', async () => {
  const { createAppServer } = await import('../lib/app.mjs');
  const root = mkdtempSync(join(tmpdir(), 'copilot-storage-'));
  mkdirSync(join(root, 'state/app/checks.json'), { recursive: true });
  const server = await createAppServer({ root, project: 'test-project', port: 0,
    readStatus: async () => ({}), runCheck: async () => ({ ok: true }) });
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(url + '/api/checks/mcp', { method: 'POST' })).status, 503);
    const status = await (await fetch(url + '/api/status')).json();
    assert.deepEqual(status.checks, []);
  } finally { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); }
});
