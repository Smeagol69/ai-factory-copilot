// Tools the local model gets during a backup shift, confined to its own git
// worktree (branch local/shift). Read text files, list folders, make one exact
// replacement or create a new file in source folders, run one test file. No
// game, no network, no git: the shift engine commits, and reviewers merge.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const hash = data => createHash('sha256').update(data).digest('hex');
const TEXT = /\.(mjs|js|cjs|json|md|txt|css|html|cpp|h|hpp|cs|ini|ps1|cmd|yml|yaml)$/i;
const NEVER = /(^|\/)(\.git|node_modules)(\/|$)|^hub\/(runtime|state|models|tools|workspaces)(\/|$)/;
const WRITABLE = /^(companion|hub|docs|scripts|Source)\//;
const TEST = /^(companion|hub)\/test\/[\w.-]+\.test\.mjs$/;
// The local model has an 8K context. Bigger results make Ollama drop the
// original request from the conversation and the step fails, so keep them small.
const READ_CHARS = 3500;
const MAX_CALLS = 5;
const fail = message => { throw new Error(message); };

export function createShiftTools({ worktree, node = process.execPath, onEvent = () => {}, focus = '' }) {
  const root = realpathSync(worktree);
  let calls = 0;
  const literal = path => {
    if (typeof path !== 'string' || !path || path.length > 300 || /[\\:\x00-\x1f*?"<>|]/.test(path) ||
        path.split('/').some(p => !p || p === '.' || p === '..')) fail('Use a literal repo path with forward slashes, like companion/lib/level-tunnel.mjs');
    if (NEVER.test(path)) fail('That folder is not part of the shift workspace');
    let current = root;
    for (const part of path.split('/')) { current = join(current, part); if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('Linked paths are unavailable'); }
    const file = resolve(root, path);
    if (!file.startsWith(root + sep)) fail('Path leaves the shift workspace');
    return file;
  };

  const handlers = {
    shift_list_files({ path = '' }) {
      const dir = path === '' ? root : literal(path);
      if (!existsSync(dir) || !lstatSync(dir).isDirectory()) fail('Not a folder');
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter(e => !NEVER.test((path ? path + '/' : '') + e.name) && !e.name.startsWith('.'))
        .slice(0, 200).map(e => e.isDirectory() ? e.name + '/' : e.name);
      return { path, entries };
    },
    shift_read_file({ path, start = 1, end = 60 }) {
      const file = literal(path);
      if (!TEXT.test(path)) fail('Only text source files can be read');
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) fail('Give whole line numbers with start ≥ 1 and end ≥ start');
      end = Math.min(end, start + 79); // too wide a range is clipped, not refused: no wasted tool call
      if (!existsSync(file)) return { path, exists: false, sha256: null };
      const data = readFileSync(file);
      if (data.length > 524288) fail('File exceeds the read limit');
      const lines = data.toString('utf8').split(/\r?\n/);
      return { path, exists: true, sha256: hash(data), start, end: Math.min(end, lines.length), totalLines: lines.length,
        text: lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join('\n').slice(0, READ_CHARS), more: lines.length > end };
    },
    shift_edit_file({ path, expected_sha256 = null, old_text, new_text, content }) {
      const file = literal(path);
      if (!WRITABLE.test(path) || !TEXT.test(path)) fail('Edits are limited to text files under companion/, hub/, docs/, scripts/ or Source/');
      const data = existsSync(file) ? readFileSync(file) : null, current = data ? hash(data) : null;
      if (current !== expected_sha256) fail('The file changed since your read (or the hash is wrong); read it again first');
      let next;
      if (current === null) {
        if (typeof content !== 'string' || !content || content.length > 18000 || old_text !== undefined) fail('A new file needs content (up to 18000 characters) and expected_sha256 null');
        next = content;
      } else {
        if (typeof old_text !== 'string' || !old_text || typeof new_text !== 'string' || new_text.length > 18000 || content !== undefined) fail('Change an existing file with one exact old_text → new_text replacement');
        const text = data.toString('utf8').replace(/\r\n/g, '\n'), needle = old_text.replace(/\r\n/g, '\n'), at = text.indexOf(needle);
        if (at < 0 || text.indexOf(needle, at + 1) >= 0) fail('old_text must match exactly once');
        next = text.slice(0, at) + new_text + text.slice(at + needle.length);
      }
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${randomUUID()}.tmp`;
      writeFileSync(tmp, next, { flag: 'wx' }); renameSync(tmp, file);
      return { effect: 'file-written', written: true, path, sha256: hash(readFileSync(file)) };
    },
    async shift_run_test({ path }) {
      if (typeof path !== 'string' || !TEST.test(path)) fail('Run one test file under companion/test or hub/test');
      const file = literal(path);
      if (!existsSync(file)) fail('That test file does not exist');
      const [pkg, ...rest] = path.split('/');
      const env = { ...process.env }; for (const k of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD/i.test(k)) delete env[k];
      let output = '', exitCode = 0;
      try { const r = await exec(node, ['--test', rest.join('/')], { cwd: join(root, pkg), env, windowsHide: true, timeout: 180000, maxBuffer: 2 * 1024 * 1024 }); output = r.stdout + r.stderr; }
      catch (e) { exitCode = Number.isInteger(e.code) ? e.code : -1; output = String(e.stdout ?? '') + String(e.stderr ?? ''); }
      const summary = (output.match(/^ℹ (tests|pass|fail) \d+$/gm) ?? []).join(', ');
      return { path, exitCode, passed: exitCode === 0, summary, output: output.slice(-800) };
    },
  };

  const schema = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
  const str = d => ({ type: 'string', description: d });
  const tools = [
    schema('shift_list_files', 'List a folder in your shift workspace (the repo). Empty path = repo root.', { path: str('folder, e.g. companion/lib') }, []),
    schema('shift_read_file', 'Read numbered lines of a text file and get its sha256 (needed to edit it).', { path: str('file path'), start: { type: 'integer' }, end: { type: 'integer' } }, ['path']),
    schema('shift_edit_file', 'Change a file with ONE exact old_text→new_text replacement (pass its sha256 from your read), or create a new file with content and expected_sha256 null.',
      { path: str('file path'), expected_sha256: { type: ['string', 'null'] }, old_text: str('exact text to replace'), new_text: str('replacement'), content: str('content of a new file') }, ['path']),
    schema('shift_run_test', 'Run one test file with node --test and get the result.', { path: str('e.g. companion/test/level-tunnel.test.mjs') }, ['path']),
  ];
  return {
    tools,
    async dispatch(name, args) {
      const handler = handlers[name];
      if (!handler) throw new Error('Unknown shift tool');
      // The runner stops hard after 8 calls with no answer at all. Refusing from
      // the 6th leaves room for the model to write its summary instead.
      if (++calls > MAX_CALLS) {
        onEvent({ kind: 'result', text: 'Tool budget used up; asked to finish', error: true });
        return { error: 'Your tool budget for this step is used up. Do not call any more tools. Answer now with the two lines CHANGED: and REVIEW:.' };
      }
      onEvent({ kind: 'tool', text: `${name}: ${args?.path ?? ''}`.trim() });
      try {
        const result = await handler(args ?? {});
        onEvent({ kind: 'result', text: result.written ? `wrote ${result.path}` : result.summary ? `${result.passed ? 'tests passed' : 'tests failed'} (${result.summary})` : 'ok', error: result.passed === false });
        return result;
      } catch (error) {
        onEvent({ kind: 'result', text: error.message, error: true });
        return { error: error.message };
      }
    },
    async context() {
      const git = async args => (await exec('git', args, { cwd: root, windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
      const [branch, log, files] = await Promise.all([git(['branch', '--show-current']), git(['log', '-5', '--format=%h %s']), git(['ls-files', 'companion/lib', 'companion/test', 'docs'])]);
      // Hand the small model the files that match the milestone so it doesn't
      // spend its few tool calls listing folders.
      const words = String(focus ?? '').toLowerCase().match(/[a-z]{4,}/g)?.filter(w => !['with', 'that', 'into', 'from', 'joined', 'gradual'].includes(w)) ?? [];
      const related = files.split('\n').filter(f => TEXT.test(f) && words.some(w => f.toLowerCase().includes(w))).slice(0, 10).map(f => {
        try { return `${f} (${readFileSync(join(root, f), 'utf8').split('\n').length} lines)`; } catch { return f; }
      });
      return [`Shift workspace: the repo on branch ${branch}. Recent commits:\n${log}`,
        related.length ? `Files that match the milestone:\n${related.join('\n')}` : `Top level: ${handlers.shift_list_files({}).entries.join(' ')}`,
        'You have 5 tool calls in this step. Plan: read at most 2 files (only the lines you need), make ONE edit, run ONE test, then answer.'].join('\n\n');
    },
    async close() {},
  };
}
