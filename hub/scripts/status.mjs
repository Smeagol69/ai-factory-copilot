import { parseArgs } from 'node:util';
import { projectStatus } from '../lib/project.mjs';
const { values } = parseArgs({ options: { offline: { type: 'boolean', default: false } } });
try { console.log(JSON.stringify(await projectStatus({ offline: values.offline }), null, 2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
