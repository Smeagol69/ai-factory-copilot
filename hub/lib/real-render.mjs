// Real renders: a piece list drawn with the game's own meshes and textures in Blender
// (hub/tools/game-assets: meshes exported from the installed game by GameAssets,
// rendered by render_pieces.py). Used by the studio whenever Blender and the export
// are present; otherwise the studio falls back to its labelled box render.
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

export const BLENDER = process.env.BLENDER_EXE ?? 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe';
export const ASSET_MANIFEST = process.env.GAME_ASSETS_MANIFEST ?? 'D:/SatisfactoryAssets/export/manifest.json';
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../tools/game-assets/render_pieces.py');

export const realRenderAvailable = () => existsSync(BLENDER) && existsSync(ASSET_MANIFEST) && existsSync(SCRIPT);

// Renders the exterior view to outFile and the walkway view beside it (-interior.png).
export function renderReal(pieces, outFile, { timeoutMs = 300000 } = {}) {
  const work = join(tmpdir(), `real-render-${randomUUID()}`); mkdirSync(work, { recursive: true });
  const piecesFile = join(work, 'pieces.json'); writeFileSync(piecesFile, JSON.stringify({ pieces }));
  const base = join(work, 'render.png');
  return new Promise((resolve, reject) => {
    let out = '';
    const child = spawn(BLENDER, ['-b', '-P', SCRIPT, '--', ASSET_MANIFEST, piecesFile, base, '--view', 'both'], { windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Blender render timed out')); }, timeoutMs);
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', () => {});
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.split(/\r?\n/).find(l => l.startsWith('{"drawn"'));
      if (!line) { reject(new Error('Blender produced no render summary')); return; }
      const summary = JSON.parse(line);
      const exterior = base.replace('.png', '-exterior.png'), interior = base.replace('.png', '-interior.png');
      if (!existsSync(exterior)) { reject(new Error('Blender did not save the render')); return; }
      mkdirSync(dirname(outFile), { recursive: true });
      copyFileSync(exterior, outFile);
      const interiorFile = outFile.replace(/\.png$/, '-interior.png');
      if (existsSync(interior)) copyFileSync(interior, interiorFile);
      resolve({ file: outFile, interior: existsSync(interiorFile) ? interiorFile : null, pieces: summary.drawn, skipped: summary.skipped_splines, unknown: summary.missing_mesh, real: true });
    });
  });
}
