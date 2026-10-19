import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createAppServer } from '../lib/app.mjs';

test('one launcher reuses its exact project and refuses a foreign service on the same port', async () => {
  assert(existsSync(new URL('../lib/start-app.mjs', import.meta.url)), 'Single launcher startup must exist');
  const { ensureApp } = await import('../lib/start-app.mjs');
  const root = mkdtempSync(join(tmpdir(), 'copilot-start-'));
  const server = await createAppServer({ root, project: 'test-project', port: 0, readStatus: async () => ({}), runCheck: async () => ({}) });
  try {
    const port = server.address().port;
    const first = await ensureApp({ root, project: 'test-project', port });
    const second = await ensureApp({ root, project: 'test-project', port });
    assert.equal(first.reused, true);
    assert.equal(first.pid, process.pid);
    assert.equal(second.pid, first.pid);
    await assert.rejects(ensureApp({ root, project: 'another-project', port }), /different|unknown|foreign/i);
  } finally { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); }
  const foreign = createServer((req, res) => res.end('{"status":"ok"}'));
  await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(ensureApp({ root, project: 'test-project', port: foreign.address().port }), /different|unknown|foreign/i);
  } finally { await new Promise(resolve => foreign.close(resolve)); }
});
