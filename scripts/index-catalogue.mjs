import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT } from '../lib/project.mjs';
const path = join(ROOT, 'catalog/Awesome-RE-MCP/README.md');
const bytes = readFileSync(path);
let category = '', entries = [];
for (const line of bytes.toString('utf8').split(/\r?\n/)) {
  if (line.startsWith('## Missing Categories')) break;
  if (line.startsWith('## ')) category = line.slice(3).trim();
  const match = /^- \*\*\[([^\]]+)\]\((https:\/\/[^)]+)\)/.exec(line);
  if (match) entries.push({ name: match[1], url: match[2], category, status: 'catalogued-not-configured' });
}
writeFileSync(join(ROOT, 'catalog/index.json'), JSON.stringify({
  repository: 'https://github.com/crowdere/Awesome-RE-MCP',
  commit: 'e400b882965ef61302718c7fe7c4f1e2861bd664',
  readmeSha256: createHash('sha256').update(bytes).digest('hex'),
  completeUpstreamFile: 'catalog/Awesome-RE-MCP/README.md', entries,
}, null, 2) + '\n');
console.log(`Indexed ${entries.length} linked RE servers; none are represented as installed.`);
