// Composes the "layered industrial tunnel" treatment (studio job 07de5619's target
// render) onto the agreed straight 2-bay shell, using only real game pieces from the
// catalog with their true sizes and pivots from the game's own meshes. Every added
// piece is fitted to the shell's actual facets (read from the shell's foundations).
//
//   node compose-layered-bay.mjs <shell-pieces.json> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(here, '../../catalog/game-buildables.json'), 'utf8')).buildables;
const byName = (name, mod) => {
  const b = catalog.find(x => x.name === name && (!mod || x.owner_mod === mod) && x.available && x.size);
  if (!b?.size) throw new Error(`No sized real piece "${name}"${mod ? ` [${mod}]` : ''}`);
  return b;
};
const [shellFile, outFile, repeatArg] = process.argv.slice(2);
const shellDoc = JSON.parse(readFileSync(shellFile, 'utf8'));
const agreedShell = Array.isArray(shellDoc) ? shellDoc : shellDoc.pieces;
// Optional preview length: repeat the shell's first 8 m bay N times along the tunnel (the module repeats).
const repeat = Number(repeatArg) || 0;
const firstY = Math.min(...agreedShell.map(p => p.transform.translation_cm.y));
const bayPieces = agreedShell.filter(p => Math.abs(p.transform.translation_cm.y - firstY) < 1);
const shell = repeat ? Array.from({ length: repeat }, (_, i) => bayPieces.map(p => ({ ...p, transform: { ...p.transform, translation_cm: { ...p.transform.translation_cm, y: p.transform.translation_cm.y + i * 800 } } }))).flat() : agreedShell;

// --- vector / quaternion helpers (Unreal axes; same algebra either handedness) ---
const v = (x, y, z) => ({ x, y, z });
const add = (a, b) => v(a.x + b.x, a.y + b.y, a.z + b.z), sub = (a, b) => v(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a, s) => v(a.x * s, a.y * s, a.z * s), dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => v(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const norm = a => mul(a, 1 / Math.hypot(a.x, a.y, a.z));
const rotate = (q, p) => {
  const t = mul(cross(v(q.x, q.y, q.z), p), 2);
  return add(add(p, mul(t, q.w)), cross(v(q.x, q.y, q.z), t));
};
// Quaternion whose local X, Y, Z axes map to the given orthonormal world axes.
function quatFromAxes(X, Y, Z) {
  if (dot(cross(X, Y), Z) < 0) throw new Error('Axes must form a proper rotation');
  const m = [[X.x, Y.x, Z.x], [X.y, Y.y, Z.y], [X.z, Y.z, Z.z]], tr = m[0][0] + m[1][1] + m[2][2];
  let q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = { w: s / 4, x: (m[2][1] - m[1][2]) / s, y: (m[0][2] - m[2][0]) / s, z: (m[1][0] - m[0][1]) / s }; }
  else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2; q = { w: (m[2][1] - m[1][2]) / s, x: s / 4, y: (m[0][1] + m[1][0]) / s, z: (m[0][2] + m[2][0]) / s }; }
  else if (m[1][1] > m[2][2]) { const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2; q = { w: (m[0][2] - m[2][0]) / s, x: (m[0][1] + m[1][0]) / s, y: s / 4, z: (m[1][2] + m[2][1]) / s }; }
  else { const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2; q = { w: (m[1][0] - m[0][1]) / s, x: (m[0][2] + m[2][0]) / s, y: (m[1][2] + m[2][1]) / s, z: s / 4 }; }
  const r = n => Math.round(n * 1e7) / 1e7;
  return { x: r(q.x), y: r(q.y), z: r(q.z), w: r(q.w) };
}
// Place a real piece so that its true mesh box is centred at `centre`, with its
// local axes (lx, ly, lz) along the given world directions.
const pieces = [];
function place(b, centre, lx, ly, lz, role) {
  const q = quatFromAxes(lx, ly, lz);
  const pos = sub(centre, rotate(q, b.size.origin));
  const r = n => Math.round(n * 100) / 100;
  pieces.push({ class_path: b.class_path, role, transform: { translation_cm: v(r(pos.x), r(pos.y), r(pos.z)), rotation_quat: q, scale3d: v(1, 1, 1) } });
}

// --- the shell's facets, read from its foundations ---
const AXIS_Y = v(0, 1, 0);
const centreXZ = shell.reduce((s, p) => add(s, p.transform.translation_cm), v(0, 0, 0));
const C = mul(centreXZ, 1 / shell.length);
const facets = shell.map(p => {
  const q = p.transform.rotation_quat, at = p.transform.translation_cm;
  const ax = [rotate(q, v(1, 0, 0)), rotate(q, v(0, 1, 0)), rotate(q, v(0, 0, 1))];
  let n = ax[2]; // the foundation's 2 m thickness axis is its local Z
  const toC = sub(v(C.x, at.y, C.z), at); if (dot(n, toC) < 0) n = mul(n, -1);
  const across = norm(cross(AXIS_Y, n)); // in the facet plane, perpendicular to the tunnel
  return { at, n: norm(n), across, y: at.y };
});
const ys = [...new Set(facets.map(f => Math.round(f.y)))].sort((a, b) => a - b);
const boundaries = [ys[0] - 400, ...ys.map(y => y + 400)];
const floorZ = Math.max(...facets.filter(f => f.n.z > 0.9).map(f => f.at.z)) + 100;  // top of the floor foundations
const ceilZ = Math.min(...facets.filter(f => f.n.z < -0.9).map(f => f.at.z)) - 100;   // underside of the ceiling
const sides = { left: Math.min(...facets.filter(f => Math.abs(f.n.x) > 0.9).map(f => f.at.x)) + 100, right: Math.max(...facets.filter(f => Math.abs(f.n.x) > 0.9).map(f => f.at.x)) - 100 };

// --- real pieces (names exactly as in the game catalog) ---
const RIB = byName('CC Round 1x1x8', 'ConcreteConstructionMain');           // 1 x 1 x 8 m
const PANEL_A = byName('CC Emissive Wall 1c', 'CCDetailedWalls');           // 0.5 x 8 x 4 m, lit trims
const PANEL_B = byName('CC Emissive Wall 2b', 'CCDetailedWalls');
const SPINE = byName('DI Ceiling Light 04', 'DI_More_Lights');              // 9 x 0.9 x 1 m strip
const SIDE_STRIP = byName('DI Ceiling Light 02', 'DI_More_Lights');         // 9.2 x 1.6 x 1.1 m
const CANOPY = byName('Flat Roof', 'FactoryGame');                          // 8.4 x 8 x 0.8 m
const RAIL = byName('Industrial Railing', 'FactoryGame');                   // 0.29 x 8 x 1.16 m
// Orange 8 x 1 m wall (the base game names several walls "Basic Wall (1 m)"; take the orange one by class).
const accent = catalog.find(b => b.class_path.endsWith('.Build_Wall_Orange_8x1_C') && b.size);
if (!accent) throw new Error('No sized Build_Wall_Orange_8x1_C');

// Long axis of a piece's true mesh box, to orient it.
const longAxis = b => { const e = b.size.extent; return e.x >= e.y && e.x >= e.z ? 'x' : e.y >= e.z ? 'y' : 'z'; };

// 1. Ribs: at every bay boundary, one rib segment on each shell facet, standing 1 m proud of the shell.
// The walkway stays clear: no rib on the floor facets (normal pointing straight up).
for (const yb of boundaries) for (const f of facets.filter(f => Math.round(f.y) === ys[0] && f.n.z < 0.9)) {
  const centre = add(v(f.at.x, yb, f.at.z), mul(f.n, 100 + 50));
  // CC Round 1x1x8: long axis is local Z.
  place(RIB, centre, AXIS_Y, cross(f.across, AXIS_Y), f.across, 'rib');
}
// 2. Lit wall panels on both side walls, three rows, alternating style by bay.
ys.forEach((y, i) => {
  const panel = i % 2 ? PANEL_B : PANEL_A;
  for (const [x, inward] of [[sides.left, v(1, 0, 0)], [sides.right, v(-1, 0, 0)]]) {
    for (const z of [floorZ + 1500, floorZ + 1900, floorZ + 2300]) {
      // Wall: local X = thickness (into the tunnel), Y = 8 m along the tunnel, Z = 4 m up.
      place(panel, v(x + inward.x * 25, y, z), inward, cross(v(0, 0, 1), inward), v(0, 0, 1), `panel-${i % 2 ? 'b' : 'a'}`);
    }
  }
});
// 3. Ceiling light spine along the centre, flanked by two wider strips.
for (const y of ys) {
  const hang = (b, x) => {
    const e = b.size.extent; // long axis along the tunnel, hanging just under the ceiling
    const lx = longAxis(b) === 'x' ? AXIS_Y : v(1, 0, 0), ly = longAxis(b) === 'x' ? v(-1, 0, 0) : AXIS_Y;
    place(b, v(x, y, ceilZ - e.z - 30), lx, ly, v(0, 0, 1), 'light');
  };
  hang(SPINE, C.x); hang(SIDE_STRIP, C.x - 800); hang(SIDE_STRIP, C.x + 800);
}
// 4. Equipment canopies with a light strip under each, over the lower side bays.
for (const y of ys) for (const side of [-1, 1]) {
  const x = C.x + side * 1500, z = floorZ + 750;
  place(CANOPY, v(x, y, z), v(1, 0, 0), AXIS_Y, v(0, 0, 1), 'canopy');
  const e = SIDE_STRIP.size.extent;
  place(SIDE_STRIP, v(x, y, z - CANOPY.size.extent.z - e.z - 10), AXIS_Y, v(-1, 0, 0), v(0, 0, 1), 'light');
}
// 4b. Real equipment under each canopy: a Tall Vent and a M.A.M. Console (Factory Prop Mod).
const VENT = byName('Tall Vent', 'Factory_Prop_Mod'), CONSOLE = byName('M.A.M. Console', 'Factory_Prop_Mod');
for (const y of ys) for (const side of [-1, 1]) {
  const x = C.x + side * 1500, face = v(-side, 0, 0);
  place(VENT, v(x, y - 200, floorZ + VENT.size.extent.z), face, cross(v(0, 0, 1), face), v(0, 0, 1), 'equipment');
  place(CONSOLE, v(x, y + 220, floorZ + CONSOLE.size.extent.z), face, cross(v(0, 0, 1), face), v(0, 0, 1), 'equipment');
}
// 5. Railings along the 12 m central walkway, and orange service accents at the wall feet.
for (const y of ys) for (const side of [-1, 1]) {
  const x = C.x + side * 600, e = RAIL.size.extent;
  place(RAIL, v(x, y, floorZ + e.z), v(side, 0, 0), cross(v(0, 0, 1), v(side, 0, 0)), v(0, 0, 1), 'railing');
}
for (const y of ys) for (const [x, inward] of [[sides.left, v(1, 0, 0)], [sides.right, v(-1, 0, 0)]]) {
  place(accent, v(x + inward.x * 25, y, floorZ + 1500 - 200 - 50), inward, cross(v(0, 0, 1), inward), v(0, 0, 1), 'accent');
}

const all = [...shell.map(p => ({ ...p, role: 'shell' })), ...pieces];
const counts = all.reduce((m, p) => { m[p.role] = (m[p.role] ?? 0) + 1; return m; }, {});
// Walkway camera: standing at the near end on the walkway, looking down the run.
const camera = { eye: v(C.x, boundaries[0] + 150, floorZ + 170), look: v(C.x, boundaries[0] + 2400, floorZ + 1300), lens: 14 };
writeFileSync(outFile, JSON.stringify({ title: 'AI Walled Straight 2 Bay: layered industrial treatment', basis: { floorZ, ceilZ, sides, centre: C, boundaries }, camera, pieces: all }, null, 1));
console.log(JSON.stringify({ pieces: all.length, counts, floorZ, ceilZ, sides }));

