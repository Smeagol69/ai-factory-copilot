import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { runtimeContext } from '../lib/project.mjs';

async function connect(name, work) {
  const context = await runtimeContext();
  const profile = JSON.parse(readFileSync(resolve(context.root, '.mcp.json'), 'utf8')).mcpServers[name];
  const sdk = relative => import(pathToFileURL(resolve(context.runtime, 'node_modules/@modelcontextprotocol/sdk/dist/esm', relative)).href);
  const [{ Client }, { StdioClientTransport }] = await Promise.all([sdk('client/index.js'), sdk('client/stdio.js')]);
  const client = new Client({ name: 'satisfactory-lab-setup-check', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: profile.command,
      args: profile.args, cwd: context.runtime,
      env: context.subscriptionEnvironment(), stderr: 'ignore' }));
    await work(client);
  } finally { await client.close(); }
}

test('real client profile launches from another working directory and reads the separate Satisfactory ledger', async () => {
  await connect('agent_pair', async client => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 31);
    for (const name of ['pair_context', 'pair_remember', 'pair_claim_task', 'pair_validate_project_contract', 'pair_assess_project_readiness'])
      assert(tools.some(tool => tool.name === name), name);
    const response = await client.callTool({ name: 'pair_context', arguments: { project: 'satisfactory-mcp-lab' } });
    assert(!response.isError);
    const context = response.structuredContent ?? JSON.parse(response.content[0].text);
    assert.equal(context.project.id, 'satisfactory-mcp-lab');
    assert(context.project.workspace.replaceAll('\\', '/').endsWith('/satisfactory-mcp-lab'));
    assert(context.tasks.every(task => task.project === 'satisfactory-mcp-lab'));
  });
});

test('real Superpowers launcher exposes all skills, prompts and original resources', async () => {
  await connect('superpowers', async client => {
    const [{ tools }, { prompts }, { resources }] = await Promise.all([client.listTools(), client.listPrompts(), client.listResources()]);
    assert.equal(tools.length, 18);
    assert.equal(prompts.length, 15);
    assert.equal(resources.length, 238);
    assert(tools.some(tool => tool.name === 'superpowers_test_driven_development'));
    assert(tools.some(tool => tool.name === 'superpowers_verification_before_completion'));
  });
});
