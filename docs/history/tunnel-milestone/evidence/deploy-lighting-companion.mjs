import { readFile, writeFile, mkdir, copyFile, rename } from 'node:fs/promises';
import { resolve, join, dirname, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { companionStatus, stopCompanion, startCompanion } from '../../../lib/companion.mjs';
const root = resolve('.'), source = join(root, 'workspaces/architect/blueprint-force-save');
const target = join(root, 'runtime/satisfactory-companion');
const expected = 'f84bb0c';
const git = args => execFileSync('git', args, { cwd: source, windowsHide: true, encoding: 'utf8' }).trim();
const hash = b => createHash('sha256').update(b).digest('hex');
const within = (base, path) => { if (!resolve(path).startsWith(resolve(base) + '\\') && !resolve(path).startsWith(resolve(base) + '/')) throw Error('Deployment path escapes owned directory'); return path; };
const commit = git(['rev-parse', 'HEAD']);
if (!commit.startsWith(expected) || git(['status', '--porcelain', '--untracked-files=no'])) throw Error('Reviewed source is not clean and pinned');

for(const name of ['local-lighting-bridge-v2-review.json','local-lighting-curve-v3-review.json']){
 const r=JSON.parse(await readFile(join(root,'state/live-architect/tunnel-milestone',name)));
 if(r.status!=='completed'||!r.result.messages.some(m=>m.role==='assistant'&&JSON.parse(m.content.replace(/^```json\s*|\s*```$/g,'')).verdict==='approve'))throw Error('Source review missing');
 for(const f of r.files)if(hash(await readFile(join(source,f.file)))!==f.sha256)throw Error('Reviewed source changed');
}
const verified=JSON.parse(await readFile(join(root,'state/live-architect/tunnel-milestone/local-readonly-fixtures-v2-review.json')));
if(JSON.parse(verified.result.message.content).verdict!=='approve')throw Error('Fixture review not approved');
for(const f of verified.files)if(hash(await readFile(join(source,f.file)))!==f.sha256)throw Error('Fixture source changed');
const route=JSON.parse(await readFile(join(root,'state/live-architect/tunnel-milestone/local-readonly-route-final.json')));
if(route.sourceCommit!=='f84bb0c'||!route.result.message.content.startsWith('{verdict:approve,findings:[]'))throw Error('Route review unresolved');
const suite=await readFile(join(root,'state/live-architect/tunnel-milestone/companion-lighting-suite.log'),'utf8');
if(!/ℹ pass 1350[\s\S]*ℹ fail 0/.test(suite))throw Error('Full tests missing');

const oldBytes = await readFile(join(target, 'install-lock.json')), oldLock = JSON.parse(oldBytes);
for (const file of oldLock.files) if (hash(await readFile(within(target, join(target, file.path)))) !== file.sha256) throw Error('Current runtime differs from its recovery manifest');
if (hash(await readFile(join(source, 'companion/package-lock.json'))) !== hash(await readFile(join(target, 'package-lock.json')))) throw Error('Dependency change requires a separate clean install');
const paths = git(['ls-files', '--', 'companion/lib', 'companion/data', 'companion/server.mjs', 'companion/package.json', 'companion/package-lock.json', 'companion/.env.example']).split('\n').filter(Boolean);
const changes = [];
for (const path of paths) {
  if (!/^companion\/(?:lib\/[^/]+\.mjs|data\/[^\x00-\x1f]+|server\.mjs|package(?:-lock)?\.json|\.env\.example)$/.test(path) || path.includes('..')) throw Error('Unexpected public runtime path');
  const relativePath = path.slice('companion/'.length), bytes = await readFile(within(source, join(source, path)));
  const old = oldLock.files.find(f => f.path === relativePath);
  if (old?.sha256 !== hash(bytes)) changes.push({ path: relativePath, bytes, previous: old ? await readFile(within(target, join(target, relativePath))) : null });
}
const status = await companionStatus();
if (!status.owned || !status.runtimeMatches) throw Error('Only the verified owned current service may be updated');
const backup = join(root, 'state/companion/deployments', String(Date.now())); await mkdir(backup, { recursive: true });
await writeFile(join(backup, 'install-lock.previous.json'), oldBytes);
for (const change of changes) if (change.previous) { const file = within(backup, join(backup, change.path)); await mkdir(dirname(file), { recursive: true }); await writeFile(file, change.previous); }
const receipt = { schema: 'copilot.companion-deployment/v1', commit, backup: relative(root, backup), changes: changes.map(c => c.path),
  startedAt: new Date().toISOString(), modelCalls: 0, gameWrites: 0, scheduledTasks: 0, ok: false };
try {
  if (!(await stopCompanion()).stopped) throw Error('Owned service stop not confirmed');
  for (const change of changes) await writeFile(within(target, join(target, change.path)), change.bytes);
  const files = new Map(oldLock.files.map(f => [f.path, f]));
  for (const change of changes) files.set(change.path, { path: change.path, sha256: hash(change.bytes) });
  const lock = { ...oldLock, sourceCommit: commit, updatedFrom: 'workspaces/architect/blueprint-force-save/companion', updatedAt: new Date().toISOString(), files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) };
  lock.runtimeSha256 = hash(JSON.stringify(lock.files));
  for (const file of lock.files) if (hash(await readFile(within(target, join(target, file.path)))) !== file.sha256) throw Error('Updated runtime did not verify');
  await writeFile(join(target, 'install-lock.tmp'), JSON.stringify(lock, null, 2) + '\n'); await rename(join(target, 'install-lock.tmp'), join(target, 'install-lock.json'));
  const started = await startCompanion();
  if (!started.status.owned || !started.status.runtimeMatches || !started.status.health.operationalReady) throw Error('Updated runtime failed readiness');
  Object.assign(receipt, { ok: true, pid: started.pid, runtimeSha256: lock.runtimeSha256, health: started.status.health, worldVerified: false });
} catch (error) {
  await stopCompanion().catch(() => {});
  for (const change of changes) if (change.previous) await writeFile(within(target, join(target, change.path)), change.previous);
  await writeFile(join(target, 'install-lock.json'), oldBytes);
  receipt.rollback = await startCompanion().then(() => 'previous_runtime_restored', () => 'needs_attention');
  receipt.error = 'Reviewed runtime deployment failed; preserved recovery evidence';
} finally {
  receipt.finishedAt = new Date().toISOString();
  await writeFile(join(backup, 'deployment.json'), JSON.stringify(receipt, null, 2) + '\n');
  await writeFile(join(root, 'state/companion/latest-deployment.json'), JSON.stringify(receipt, null, 2) + '\n');
}
console.log(JSON.stringify(receipt));
if (!receipt.ok) process.exitCode = 1;



