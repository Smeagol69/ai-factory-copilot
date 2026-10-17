import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runtimeContext } from '../lib/project.mjs';
const context = await runtimeContext();
const url = `http://127.0.0.1:${context.config.progressPort}`;
let running = null;
try {
  const r = await fetch(url + '/api/progress', { redirect: 'error', signal: AbortSignal.timeout(1500) });
  running = await r.json();
} catch {}
if (running) {
  if (running.project?.id !== context.config.project) throw new Error('Port is already serving a different or unknown project');
  console.log(`Existing Satisfactory room: ${url}`);
} else {
  const local = resolve(context.root, '.local'); mkdirSync(local, { recursive: true });
  const out = openSync(resolve(local, 'room-stdout.log'), 'a'), err = openSync(resolve(local, 'room-stderr.log'), 'a');
  let child;
  try {
    child = spawn(process.execPath, [resolve(context.root, 'scripts/room.mjs')], {
      cwd: context.root, env: context.subscriptionEnvironment(), detached: true,
      windowsHide: true, stdio: ['ignore', out, err],
    });
    await new Promise((ok, fail) => { child.once('spawn', ok); child.once('error', fail); });
    child.unref();
  } finally { closeSync(out); closeSync(err); }
  let ready = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise(done => setTimeout(done, 250));
    try {
      const r = await fetch(url + '/api/progress', { redirect: 'error', signal: AbortSignal.timeout(1000) });
      const p = await r.json();
      if (r.ok && p.project?.id === context.config.project) { ready = true; break; }
    } catch {}
  }
  if (!ready) {
    child.kill();
    throw new Error('Room did not become ready; inspect .local/room-stderr.log');
  }
  writeFileSync(resolve(local, 'room.json'), JSON.stringify({ pid: child.pid, url, project: context.config.project, startedAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(`Satisfactory room ready: ${url}`);
}
