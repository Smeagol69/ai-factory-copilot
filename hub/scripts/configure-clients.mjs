import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT } from '../lib/project.mjs';
const normalized = path => path.replaceAll('\\', '/');
const node = normalized(join(ROOT, 'runtime/node/node.exe')), root = normalized(ROOT);
const args = (script, provider) => [root + '/scripts/' + script, ...(provider ? ['--provider', provider] : [])];
// Clients open either the repo root or hub/, so both get the same launchers.
for (const target of [dirname(ROOT), ROOT]) {
  mkdirSync(join(target, '.codex'), { recursive: true });
  writeFileSync(join(target, '.mcp.json'), JSON.stringify({ mcpServers: {
    agent_pair: { command: node, args: args('mcp.mjs', 'claude') },
    superpowers: { command: node, args: args('superpowers.mjs') },
    rea: { command: node, args: args('rea.mjs') },
    local_model: { command: node, args: args('local-worker.mjs') },
  } }, null, 2) + '\n');
  writeFileSync(join(target, '.codex/config.toml'),
    '[mcp_servers.agent_pair]\ncommand = ' + JSON.stringify(node) + '\nargs = ' + JSON.stringify(args('mcp.mjs', 'codex')) + '\ncwd = ' + JSON.stringify(root) + '\n\n' +
    '[mcp_servers.superpowers]\ncommand = ' + JSON.stringify(node) + '\nargs = ' + JSON.stringify(args('superpowers.mjs')) + '\ncwd = ' + JSON.stringify(root) + '\n\n' +
    '[mcp_servers.rea]\ncommand = ' + JSON.stringify(node) + '\nargs = ' + JSON.stringify(args('rea.mjs')) + '\ncwd = ' + JSON.stringify(root) + '\n\n' +
    '[mcp_servers.local_model]\ncommand = ' + JSON.stringify(node) + '\nargs = ' + JSON.stringify(args('local-worker.mjs')) + '\ncwd = ' + JSON.stringify(root) + '\n');
}
console.log('Project-local Codex and Claude MCP launch configurations written for the repo root and hub/. Global settings unchanged.');
