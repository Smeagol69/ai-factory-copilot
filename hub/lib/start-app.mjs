import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export async function ensureApp({ root, project, port }) {
  root = resolve(root);
  const url = `http://127.0.0.1:${port}/`;
  const probe = async () => {
    let response;
    try { response = await fetch(url + 'api/identity', { redirect: 'error', signal: AbortSignal.timeout(1000) }); }
    catch { return null; }
    let text = '', size = 0;
    for await (const bytes of response.body ?? []) {
      size += bytes.length;
      if (size > 4096) throw new Error('Port is serving a different or unknown application');
      text += Buffer.from(bytes).toString('utf8');
    }
    let identity;
    try { identity = JSON.parse(text); } catch { throw new Error('Port is serving a different or unknown application'); }
    if (!response.ok || identity.application !== 'copilot-control-room/v1' || identity.root !== root ||
        identity.project !== project || !Number.isInteger(identity.pid) || identity.pid < 1)
      throw new Error('Port is serving a different or unknown application');
    return identity;
  };
  const existing = await probe();
  if (existing) return { ...existing, url, reused: true };
  const state = join(root, 'state/app'); mkdirSync(state, { recursive: true });
  const stdout = openSync(join(state, 'stdout.log'), 'a'), stderr = openSync(join(state, 'stderr.log'), 'a');
  let child;
  try {
    child = spawn(join(root, 'runtime/node/node.exe'), [join(root, 'app/server.mjs')], {
      cwd: root, env: { ...process.env }, detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { closeSync(stdout); closeSync(stderr); }
  try {
    // Up to 30 s: the first start after boot also starts the local Ollama, which can take a while.
    for (let attempt = 0; attempt < 150; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      const ready = await probe();
      if (ready) {
        const receipt = { ...ready, url, reused: ready.pid !== child.pid, observedAt: new Date().toISOString() };
        writeFileSync(join(state, 'server.json'), JSON.stringify(receipt, null, 2) + '\n');
        return receipt;
      }
      if (child.exitCode !== null) break;
    }
    throw new Error('Copilot did not start. See state/app/stderr.log in the project folder.');
  } catch (error) {
    // This reference belongs only to the child launched above, never an existing listener.
    if (child.exitCode === null) child.kill();
    throw error;
  }
}
