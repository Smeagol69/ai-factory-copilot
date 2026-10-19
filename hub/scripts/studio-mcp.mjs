// "studio" MCP server for the conductor's workers: node scripts/studio-mcp.mjs --worker claude|codex
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, loadProject } from '../lib/project.mjs';
import { createStudioGateway } from '../lib/studio-gateway.mjs';
import { createPlaytestClient } from '../lib/playtest.mjs';

const worker = process.argv[process.argv.indexOf('--worker') + 1];
if (!['claude', 'codex'].includes(worker)) { console.error('Use --worker claude|codex'); process.exit(2); }
const project = loadProject();
const at = relative => import(pathToFileURL(resolve(project.runtime, relative)).href);
const [{ McpServer }, { StdioServerTransport }, { z }] = await Promise.all([
  at('node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js'), at('node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js'), at('node_modules/zod/index.js')]);
const repo = resolve(ROOT, '..');
const { inspectBlueprintStructure } = await import(pathToFileURL(resolve(repo, 'companion/lib/blueprints.mjs')).href);
const gateway = createStudioGateway({ root: ROOT, repo: process.cwd(), worker, playtest: createPlaytestClient(),
  inspectSaved: async (name, sbp, cfg) => inspectBlueprintStructure(name, sbp, cfg, { includeReferenceTraits: true, maximumEntities: 2000 }) });

const server = new McpServer({ name: 'studio', version: '1.0.0' }, { instructions:
  `Design studio tools for the ${worker} worker. Design jobs: read the job, post candidates (piece lists are rendered for both models), critique the other model's candidates (agree or revise), report builds. Game tools go through the in-game Copilot, which validates and reads back every action; game_ask backs up the newest save first. Never claim an in-game result without the tool's receipt.` });
const piece = z.object({ class_path: z.string(), transform: z.object({ translation_cm: z.object({ x: z.number(), y: z.number(), z: z.number() }), rotation_quat: z.object({ x: z.number(), y: z.number(), z: z.number(), w: z.number() }), scale3d: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional() }) });
const jobId = z.string().uuid().optional();
const tools = [
  ['studio_job', 'Read the open design job: brief, owner notes, every candidate (render PNG and piece file paths), critiques, status and whose turn is next.', { job_id: jobId }, true],
  ['studio_post_candidate', 'Post your design candidate: title, rationale, and the piece list (pieces array, or pieces_file: a JSON file in your worktree). It is rendered in three views for both models.', { job_id: jobId, title: z.string(), rationale: z.string(), source: z.string().optional(), pieces: z.array(piece).optional(), pieces_file: z.string().optional() }, false],
  ['studio_post_critique', 'Critique the other model\'s candidate after looking at its render and pieces: verdict "agree" (build it) or "revise" (say what to change; you may then post your own variant). Use candidate "build" to verify a reported build.', { job_id: jobId, candidate: z.union([z.number().int(), z.literal('build')]), verdict: z.enum(['agree', 'revise']), critique: z.string() }, false],
  ['studio_report_build', 'Report the build of the agreed candidate: what was saved/placed and the blueprint name, with the game receipts you observed.', { job_id: jobId, summary: z.string(), blueprint_name: z.string().optional() }, false],
  ['studio_render', 'Render a draft piece list to a PNG for yourself (not posted).', { title: z.string().optional(), pieces: z.array(piece).optional(), pieces_file: z.string().optional() }, true],
  ['studio_read_blueprint', 'Read a saved in-game blueprint by name (e.g. "walled tunnel") into a reference piece file.', { name: z.string() }, true],
  ['game_status', 'Is the game loaded and accepting requests?', {}, true],
  ['game_capture', 'Capture the world snapshot ("capture") or a screenshot of the player view ("look").', { operation: z.enum(['capture', 'look']).optional() }, true],
  ['game_ask', 'Ask the in-game Copilot to do something (e.g. generate a native blueprint, place it, undo). The newest save is backed up first; the game validates and reports what it committed.', { question: z.string() }, false],
];
for (const [name, description, shape, readOnlyHint] of tools) server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint, destructiveHint: false, openWorldHint: false } }, async args => {
  try { const result = await gateway.dispatch(name, args); return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }; }
  catch (error) { return { isError: true, content: [{ type: 'text', text: String(error.message).slice(0, 800) }] }; }
});
await server.connect(new StdioServerTransport());
