#!/usr/bin/env node
import { startCompanion, runCompanionService } from '../lib/companion.mjs';
try {
  if (process.argv[2] === '--serve' && process.argv.length === 4) await runCompanionService(process.argv[3]);
  else if (process.argv.length === 2) process.stdout.write(JSON.stringify(await startCompanion(), null, 2) + '\n');
  else throw new Error('Usage: start-companion.mjs');
} catch { process.stderr.write('Companion startup failed. Inspect state/companion logs.\n'); process.exitCode = 1; }
