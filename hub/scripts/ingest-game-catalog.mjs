// Builds hub/catalog/game-buildables.json from the mod's newest world snapshot:
// every building the game's Build Gun can place (the live AFGRecipeManager state,
// base game and installed mods), with sizes taken only from the game itself.
// Nothing here is invented: a class that the game does not list is not eligible,
// and a size the game did not report stays unknown.
//
//   node scripts/ingest-game-catalog.mjs [snapshot.json(.gz)]
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog } from '../lib/game-catalog.mjs';

const SNAPSHOTS = join(process.env.LOCALAPPDATA ?? '', 'FactoryGame/Saved/AIFactoryCopilot/Snapshots');
const newest = () => readdirSync(SNAPSHOTS).filter(f => /-latest\.json\.gz$/.test(f)).map(f => join(SNAPSHOTS, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
const file = process.argv[2] ?? newest();
if (!file || !existsSync(file)) { console.error('No snapshot found; capture the world in game first'); process.exit(1); }
const raw = readFileSync(file);
const doc = JSON.parse((file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8').replace(/^﻿/, ''));
const catalog = buildCatalog(doc.snapshot ?? doc, { source: { file: file.split(/[\\/]/).pop(), save: doc.save?.session_name ?? doc.save ?? null, world_revision: doc.world_revision ?? doc.snapshot?.world_revision ?? null, generated_at_utc: doc.generated_at_utc ?? doc.snapshot?.generated_at_utc ?? null } });
const out = join(dirname(fileURLToPath(import.meta.url)), '../catalog/game-buildables.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(catalog, null, 1) + '\n');
const sized = catalog.buildables.filter(b => b.size).length;
console.log(`${catalog.buildables.length} buildables (${catalog.buildables.filter(b => b.owner_mod === 'FactoryGame').length} base game), ${sized} with a game-reported size → ${out}`);
