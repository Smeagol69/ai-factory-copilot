import { parseArgs } from 'node:util';
import { runtimeContext } from '../lib/project.mjs';
import { launchServer } from '../lib/launch.mjs';
const { values } = parseArgs({ options: { provider: { type: 'string' } } });
if (!['codex', 'claude'].includes(values.provider)) throw new Error('Choose --provider codex|claude');
const c = await runtimeContext();
await launchServer('server.mjs', ['--provider', values.provider, '--instance', `${values.provider}-satisfactory-${process.pid}`, '--database', c.database]);
