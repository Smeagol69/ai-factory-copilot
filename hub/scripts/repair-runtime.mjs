import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadProject, verifyRuntime } from '../lib/project.mjs';
const context = loadProject();
if (!context.runtime.startsWith(resolve(context.root, 'runtime') + sep)) throw new Error('Repair is restricted to this application\'s bundled runtime');
verifyRuntime(context.runtime, context.config.runtime.commit);
const bytes = execFileSync('git', ['show', `${context.config.runtime.commit}:COOPERATIVE_CHARTER.md`], {
  cwd: context.runtime, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
if (createHash('sha256').update(bytes).digest('hex') !== context.config.runtime.charterSha256)
  throw new Error('Reviewed Git object does not match the shared charter pin');
// The shared charter is byte-addressed. Windows autocrlf must not rewrite it.
// This local Git attribute changes checkout metadata, not the reviewed commit.
const attributes = join(context.runtime, '.git/info/attributes');
const previous = existsSync(attributes) ? readFileSync(attributes, 'utf8') : '';
const rule = 'COOPERATIVE_CHARTER.md text eol=lf';
if (!previous.split(/\r?\n/).includes(rule)) writeFileSync(attributes, previous + '\n' + rule + '\n');
writeFileSync(join(context.runtime, 'COOPERATIVE_CHARTER.md'), bytes);
execFileSync('git', ['add', '--', 'COOPERATIVE_CHARTER.md'], { cwd: context.runtime, windowsHide: true, stdio: 'pipe', timeout: 10000 });
verifyRuntime(context.runtime, context.config.runtime.commit);
console.log('Restored exact reviewed charter bytes. Shared charter/version and original repositories are unchanged.');
