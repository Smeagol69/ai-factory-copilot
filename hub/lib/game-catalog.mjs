// The eligible pieces: only buildings the game itself lists as placeable with the
// Build Gun (hub/catalog/game-buildables.json, made by scripts/ingest-game-catalog.mjs
// from the mod's world snapshot). Designs, renders and proposals may use these
// classes and nothing else; sizes come only from what the game reported.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CATALOG_FILE = join(dirname(fileURLToPath(import.meta.url)), '../catalog/game-buildables.json');
export const CATALOG_SCHEMA = 'copilot.game-buildables/v1';

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const reflected = (actor, name) => num(actor.reflected_properties?.find(p => p.name === name)?.value);
const rightAngle = yaw => { const m = (((yaw ?? 0) % 90) + 90) % 90; return m < 0.01 || m > 89.99; };
const square = r => [r?.pitch, r?.roll].every(v => Math.abs(v ?? 0) < 0.01) && rightAngle(r?.yaw);
const unit = s => ['x', 'y', 'z'].every(k => Math.abs((s?.[k] ?? 1) - 1) < 1e-6);

// The game's own world bounds of one placed actor, turned back into the piece's
// local frame. Only actors at unit scale with no pitch/roll and a yaw on a right
// angle are used, so the axis-aligned world box is exactly the local box.
function localBox(actor) {
  if (!actor.bounds?.extent || !actor.location || !unit(actor.scale) || !square(actor.rotation)) return null;
  const yaw = ((Math.round((actor.rotation?.yaw ?? 0) / 90) % 4) + 4) % 4;
  const e = actor.bounds.extent, o = actor.bounds.origin ?? actor.location;
  const dx = o.x - actor.location.x, dy = o.y - actor.location.y, dz = o.z - actor.location.z;
  // Undo the yaw: world = R(yaw)·local.
  const [lx, ly] = [[dx, dy], [dy, -dx], [-dx, -dy], [-dy, dx]][yaw];
  const [ex, ey] = yaw % 2 ? [e.y, e.x] : [e.x, e.y];
  // A box the game reports with no size, or whose centre lies far outside it, is not
  // the piece's own geometry (seen: a wall power pole 3 km from its pivot); unknown instead.
  const big = Math.max(ex, ey, e.z);
  if (Math.min(ex, ey, e.z) < 1 || Math.hypot(lx, ly, dz) > 2 * big + 200) return null;
  return { origin: { x: lx, y: ly, z: dz }, extent: { x: ex, y: ey, z: e.z } };
}

export function buildCatalog(snapshot, { source = {} } = {}) {
  const items = new Map((snapshot.content?.items ?? []).map(i => [i.class_path, i]));
  const actorsByClass = new Map();
  for (const a of snapshot.actors ?? []) { if (!actorsByClass.has(a.class_path)) actorsByClass.set(a.class_path, []); actorsByClass.get(a.class_path).push(a); }
  const out = new Map();
  for (const r of snapshot.content?.recipes ?? []) {
    if (!(r.produced_in ?? []).some(p => /BuildGun/i.test(p))) continue;
    for (const product of r.products ?? []) {
      const desc = items.get(product.item_class), cls = desc?.building?.class_path;
      if (!cls || out.has(cls)) continue;
      const placed = actorsByClass.get(cls) ?? [];
      // Beams, belts, pipes, wires and rails are sized per placement (their length is
      // chosen when built), so one placed actor's box says nothing about the class.
      const variable = /Beam|Pipeline|Conveyor|PowerLine|Wire|Railroad|Hypertube/i.test(cls.split('.').pop());
      const box = variable ? null : placed.map(localBox).find(Boolean) ?? null;
      const withDims = placed.find(a => reflected(a, 'mWidth') != null && reflected(a, 'mHeight') != null);
      const dims = withDims ? { width: reflected(withDims, 'mWidth'), depth: reflected(withDims, 'mDepth'), height: reflected(withDims, 'mHeight') } : null;
      out.set(cls, {
        class_path: cls, recipe_class: r.class_path, descriptor_class: desc.class_path, name: desc.name ?? r.name,
        owner_mod: r.owner_mod ?? desc.owner_mod ?? null, available: r.available === true && desc.available !== false,
        size_text: /Size:\s*([^\r\n]+)/.exec(desc.description ?? '')?.[1]?.trim() ?? null,
        // size: the game's bounds of a placed actor (local cm). dims: the game's reflected width/depth/height.
        size: box ? { ...box, source: 'placed-actor-bounds', samples: placed.length } : null,
        dims: dims && Object.values(dims).some(v => v != null) ? { ...dims, source: 'reflected-properties' } : null,
      });
    }
  }
  return { schema: CATALOG_SCHEMA, source, buildables: [...out.values()].sort((a, b) => a.class_path.localeCompare(b.class_path)) };
}

let cached = null;
export function loadGameCatalog(file = CATALOG_FILE) {
  if (cached?.file === file) return cached.map;
  if (!existsSync(file)) return null;
  const doc = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  if (doc.schema !== CATALOG_SCHEMA) throw new Error(`${file} is not a ${CATALOG_SCHEMA} catalog`);
  const map = new Map(doc.buildables.map(b => [b.class_path, b]));
  cached = { file, map };
  return map;
}

// Why a class may not be used, or null when the game lists it as placeable now.
export function ineligible(classPath, catalog = loadGameCatalog()) {
  if (!catalog) return 'the game catalog is missing (run scripts/ingest-game-catalog.mjs after a world capture)';
  const b = catalog.get(classPath);
  if (!b) return 'it is not a building the game can place (not in the game catalog)';
  if (!b.available) return `${b.name} is not unlocked in this save`;
  return null;
}

// Render bounds from the catalog for every class the game measured.
export function catalogBounds(catalog = loadGameCatalog()) {
  const out = {};
  for (const [cls, b] of catalog ?? []) if (b.size) out[cls] = { origin: b.size.origin, extent: b.size.extent };
  return out;
}
