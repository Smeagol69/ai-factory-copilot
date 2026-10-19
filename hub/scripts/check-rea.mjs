#!/usr/bin/env node
import { runReaCheck, runReaNativeCheck } from '../lib/rea.mjs';
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--native') || args.length > 1) throw new Error('Usage: check-rea.mjs [--native]');
const result = await (args.includes('--native') ? runReaNativeCheck() : runReaCheck());
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
if (!result.ok) process.exitCode = 1;
