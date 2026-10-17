import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runtimeContext, companionHealth } from './project.mjs';

export async function checkMcp() {
  const context = await runtimeContext();
  const sdk = relative => import(pathToFileURL(resolve(context.runtime, 'node_modules/@modelcontextprotocol/sdk/dist/esm', relative)).href);
  const [{ Client }, { StdioClientTransport }] = await Promise.all([sdk('client/index.js'), sdk('client/stdio.js')]);
  const profiles = JSON.parse(readFileSync(resolve(context.root, '.mcp.json'), 'utf8')).mcpServers;
  const result = {};
  for (const name of ['agent_pair', 'superpowers']) {
    const profile = profiles[name];
    const client = new Client({ name: 'copilot-local-check', version: '1' });
    try {
      await client.connect(new StdioClientTransport({ command: profile.command, args: profile.args,
        cwd: context.runtime, env: context.subscriptionEnvironment(), stderr: 'ignore' }));
      const { tools } = await client.listTools();
      const probe = name === 'agent_pair'
        ? await client.callTool({ name: 'pair_context', arguments: { project: context.config.project } })
        : await client.callTool({ name: 'superpowers_catalog', arguments: {} });
      if (probe.isError) throw new Error(`${name} MCP tool rejected its probe`);
      result[name] = { connected: true, tools: tools.length, toolCallVerified: true };
      if (name === 'superpowers') {
        result[name].prompts = (await client.listPrompts()).prompts.length;
        result[name].resources = (await client.listResources()).resources.length;
      }
    } finally { await client.close(); }
  }
  return { ...result, modelCalls: 0, gameWrites: 0 };
}

export async function runLocalCheck(name) {
  if (name === 'mcp') return checkMcp();
  if (name === 'rea') return (await import('./rea.mjs')).runReaCheck();
  if (name === 'native') return (await import('./rea.mjs')).runReaNativeCheck();
  if (name === 'companion') {
    const context = await runtimeContext();
    const health = await companionHealth(context.config.game.companionPort);
    if (!health.operationalReady) throw new Error(`Satisfactory companion: ${health.status}. No live world verified.`);
    return health;
  }
  throw new Error('Unknown local check');
}
