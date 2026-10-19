// Gives every catalog class its true size from the game's own meshes: the box
// around all the meshes the class draws (GameAssets export manifest: each
// component's native mesh bounds, placed by its component transform). These sizes
// replace placed-actor estimates; a class the export could not read keeps none.
//
//   node scripts/catalog-mesh-sizes.mjs [D:/SatisfactoryAssets/export/manifest.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { CATALOG_FILE } from '../lib/game-catalog.mjs';

const manifestFile = process.argv[2] ?? 'D:/SatisfactoryAssets/export/manifest.json';
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8').replace(/^\uFEFF/, ''));
const catalog = JSON.parse(readFileSync(CATALOG_FILE, 'utf8').replace(/^\uFEFF/, ''));

const rotate = (q, v) => { // v' = q v q*
  const { x, y, z, w } = q, ix = w * v.x + y * v.z - z * v.y, iy = w * v.y + z * v.x - x * v.z, iz = w * v.z + x * v.y - y * v.x, iw = -x * v.x - y * v.y - z * v.z;
  return { x: ix * w + iw * -x + iy * -z - iz * -y, y: iy * w + iw * -y + iz * -x - ix * -z, z: iz * w + iw * -z + ix * -y - iy * -x };
};
export function classBox(components) {
  const lo = { x: Infinity, y: Infinity, z: Infinity }, hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  let any = false;
  for (const c of components ?? []) {
    const b = c.bounds; if (!b) continue;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const local = { x: (b.origin.x + sx * b.extent.x) * c.scale.x, y: (b.origin.y + sy * b.extent.y) * c.scale.y, z: (b.origin.z + sz * b.extent.z) * c.scale.z };
      const r = rotate(c.rotation_quat, local), p = { x: r.x + c.location.x, y: r.y + c.location.y, z: r.z + c.location.z };
      for (const k of ['x', 'y', 'z']) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
      any = true;
    }
  }
  if (!any) return null;
  const r = n => Math.round(n * 100) / 100;
  return { origin: { x: r((lo.x + hi.x) / 2), y: r((lo.y + hi.y) / 2), z: r((lo.z + hi.z) / 2) }, extent: { x: r((hi.x - lo.x) / 2), y: r((hi.y - lo.y) / 2), z: r((hi.z - lo.z) / 2) } };
}

let sized = 0, meshless = 0, unread = 0;
for (const b of catalog.buildables) {
  const entry = manifest.classes?.[b.class_path];
  if (!entry || entry.error) { unread++; continue; }
  const box = classBox(entry.components);
  if (!box) { meshless++; continue; }
  b.size = { ...box, source: 'game-mesh-bounds', meshes: entry.components.map(c => c.mesh) };
  sized++;
}
catalog.source = { ...catalog.source, mesh_sizes: { manifest: manifestFile, at: new Date().toISOString() } };
writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 1) + '\n');
console.log(`${sized} classes sized from game meshes, ${meshless} with no static mesh (splines, logic, skeletal), ${unread} not readable`);
