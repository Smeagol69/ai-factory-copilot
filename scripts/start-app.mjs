import { loadProject } from '../lib/project.mjs';
import { ensureApp } from '../lib/start-app.mjs';
const { root, config } = loadProject();
try {
  const result = await ensureApp({ root, project: config.project, port: config.appPort });
  console.log(JSON.stringify(result));
} catch (error) { console.error(error.message); process.exitCode = 1; }
