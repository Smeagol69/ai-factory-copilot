import { readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT } from '../lib/project.mjs';
import { loadRePolicy, assertRePurpose } from '../lib/re-policy.mjs';
import { safeText } from '../runtime/agent-pair/process.mjs';

export async function executeHostedReRequest(requestPath, { root = ROOT, createClient } = {}) {
  const policy = loadRePolicy(root);
  const base = join(await realpath(root), 'state/local-game-re/models') + sep;
  requestPath = resolve(requestPath);
  if (!requestPath.startsWith(base) || !/claude-[a-f0-9-]{36}\.request\.json$/.test(requestPath)) throw Error('Invalid fixed RE request path');
  for (let current = dirname(requestPath); current.startsWith(base.slice(0, -1)); current = dirname(current)) {
    const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe RE request directory');
  }
  const stat = await lstat(requestPath); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) throw Error('Invalid RE request file');
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  assertRePurpose(request.purpose, policy);
  if (request.schema !== 'copilot.re-hosted-request/v1' || request.root !== resolve(root) || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(request.runId ?? '') ||
    dirname(requestPath) !== join(base.slice(0, -1), request.runId) || typeof request.prompt !== 'string' || request.prompt.length > 8000 ||
    request.resultPath !== requestPath.replace(/\.request\.json$/, '.result.json') ||
    !Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > 16384 ||
    !Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > policy.phaseTimeoutMs) throw Error('Invalid bounded RE model request');
  if (!process.env.ANTHROPIC_API_KEY && !createClient) throw Error('RE worker secure Anthropic key is unavailable');
  let result;
  try {
    const factory = createClient ?? (async options => {
      const { default: Anthropic } = await import(pathToFileURL(join(root, 'runtime/agent-pair/managed-agents/node_modules/@anthropic-ai/sdk/index.mjs')).href);
      return new Anthropic(options);
    });
    const client = await factory({ apiKey: process.env.ANTHROPIC_API_KEY, baseURL: 'https://api.anthropic.com', maxRetries: 0, timeout: request.timeoutMs });
    const response = await client.messages.create({ model: 'claude-sonnet-5-5', max_tokens: request.maxOutputTokens,
      messages: [{ role: 'user', content: request.prompt }] });
    const content = response.content?.filter(block => block.type === 'text').map(block => block.text).join('\n');
    const partial = response.stop_reason === 'max_tokens';
    if (!content?.trim() && !partial) throw Error('Claude returned no complete text result');
    result = { schema: 'copilot.re-hosted-result/v1', runId: request.runId, status: partial ? 'partial' : 'completed', model: response.model,
      content: safeText(content ?? ''), usage: { ...response.usage, costUsd: null, costSource: 'API_does_not_quote_cost' },
      responseId: response.id, stopReason: response.stop_reason,
      ...(partial ? {error:'Claude RE output reached its finite limit; partial text and actual usage were retained. Reassess this evidence; do not replay automatically.'} : {}) };
  } catch (error) {
    result = { schema: 'copilot.re-hosted-result/v1', runId: request.runId, status: 'failed', error: safeText(error?.message ?? 'Claude RE request failed').slice(0, 4096) };
  }
  await writeFile(request.resultPath, safeText(JSON.stringify(result)) + '\n', { flag: 'wx', mode: 0o600 });
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (process.argv.length !== 3) throw Error('A fixed RE request path is required'); await executeHostedReRequest(process.argv[2]); }
  catch { process.stderr.write('RE hosted worker validation or storage failed.\n'); process.exitCode = 1; }
}
