import { loadProject } from '../lib/project.mjs';
import { ensureApp } from '../lib/start-app.mjs';
import { startCompanion } from '../lib/companion.mjs';
const { root, config } = loadProject();
try {
  const result = await ensureApp({ root, project: config.project, port: config.appPort });
  let companion;
  try { companion = await startCompanion(); }
  catch { companion = { ok: false, message: 'Companion needs attention; use the control room to inspect or retry.' }; }
  console.log(JSON.stringify({ ...result, companion }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
