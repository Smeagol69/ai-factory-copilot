import { parseArgs } from 'node:util';
import { serveLocalWorkerMcp } from '../lib/local-worker-mcp.mjs';

// This process speaks MCP on stdout and exposes no generic provider/project CLI.
const { values } = parseArgs({ options: {
  root: { type: 'string' }, conversation: { type: 'string' }, database: { type: 'string' },
} });
await serveLocalWorkerMcp({ root: values.root, conversationId: values.conversation, database: values.database });
