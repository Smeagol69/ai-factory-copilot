#!/usr/bin/env node
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reaEnvironment, installReaQuietProcessPolicy } from '../lib/rea.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = resolve(root, 'tools/rea/node_modules/rea-agents/scripts/rea.mjs');
const args = process.argv.slice(2);
installReaQuietProcessPolicy();
const environment = await reaEnvironment();
// Replace this process's inherited environment, never the caller's environment.
// No intermediary shell/child is needed: MCP shutdown owns this exact process.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, environment);
// CLI input/output paths keep the caller's normal relative-path semantics.
// The stdio server has no caller-relative paths; its default output home is local.
if (!args.length || (args.length === 1 && ['mcp', '--mcp'].includes(args[0]))) process.chdir(resolve(root, 'state/rea/output'));
process.argv = [process.execPath, entry, ...(args.length ? args : ['mcp'])];
await import(pathToFileURL(entry).href);
