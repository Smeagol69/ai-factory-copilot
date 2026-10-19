import { resolve } from 'node:path';
import { runtimeContext } from '../lib/project.mjs';
const context = await runtimeContext();
const { startProgressServer } = await context.moduleAt('progress-server.mjs');
const server = await startProgressServer({ database: context.database, project: context.config.project,
  port: context.config.progressPort, statePath: resolve(context.root, 'progress-state.json'),
  readCoordinator: async () => ({ available: false, state: 'not-configured', phase: 'not-configured',
    activeWorkers: null, workerActivityKnown: false,
    source: 'No coordinator endpoint is configured for this project; activity is unknown.' }),
});
const stop = () => server.close();
process.once('SIGINT', stop); process.once('SIGTERM', stop);
console.log(`Satisfactory MCP Lab: http://127.0.0.1:${server.address().port}`);
