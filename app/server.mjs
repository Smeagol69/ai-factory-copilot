import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAppServer } from '../lib/app.mjs';
import { runtimeContext, projectStatus, companionHealth } from '../lib/project.mjs';
import { runLocalCheck } from '../lib/checks.mjs';

const context = await runtimeContext();
const { PairStore } = await context.moduleAt('store.mjs');
const { safeText } = await context.moduleAt('process.mjs');
const store = new PairStore(context.database, 'copilot-app', Date.now, 'coordinator', { readOnly: true });
// Verify source once at startup. Refreshing the page never launches Git or a
// console subprocess; explicit MCP checks reverify the pinned source separately.
const baselineStatus = { ...await projectStatus({ offline: true }), sourceVerifiedAt: new Date().toISOString() };
const readStatus = async () => {
  const base = { ...baselineStatus, companion: await companionHealth(context.config.game.companionPort) };
  const ledger = store.context({ project: context.config.project });
  let rea;
  try { rea = await (await import('../lib/rea.mjs')).reaStatus(); }
  catch { rea = { installed: false, status: 'unavailable', limitations: ['REA status could not be verified.'] }; }
  return { ...base, home: context.root, application: 'Copilot', rea,
    catalogue: JSON.parse(readFileSync(join(context.root, 'catalog/index.json'), 'utf8')),
    tasks: ledger.tasks.map(t => ({ id: t.id, owner: t.owner, status: t.status, description: safeText(t.description ?? '').slice(0, 500) })),
    observedAt: new Date().toISOString(), modelCalls: 0,
    storage: { home: context.root, sharedLedger: 'Existing shared ledger in Windows app data; not copied or split.',
      gameSource: context.game, credentials: 'Existing secure Windows credential store; keys are not in this project.' } };
};
try {
  const server = await createAppServer({ root: context.root, project: context.config.project,
    port: context.config.appPort, readStatus, runCheck: runLocalCheck });
  server.on('close', () => store.close());
  process.once('SIGINT', () => server.close()); process.once('SIGTERM', () => server.close());
  console.log(`Copilot: http://127.0.0.1:${server.address().port}/`);
} catch (error) { store.close(); throw error; }
