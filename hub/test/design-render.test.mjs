import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pieceSize, axes, pieceBoxes, viewSvg, renderHtml, renderPng, boundsFromMeasurements, EDGE_PATHS } from '../lib/design-render.mjs';

const FOUNDATION = '/Game/FactoryGame/Buildable/Building/Foundation/ConcreteSet/Build_Foundation_Concrete_8x2.Build_Foundation_Concrete_8x2_C';
const piece = (cls, x = 0, y = 0, z = 0, q = { x: 0, y: 0, z: 0, w: 1 }) => ({ class_path: cls, transform: { translation_cm: { x, y, z }, rotation_quat: q, scale3d: { x: 1, y: 1, z: 1 } } });

test('piece sizes come from the class family', () => {
  assert.deepEqual(pieceSize(FOUNDATION), [800, 800, 200]);
  assert.deepEqual(pieceSize('/x/Build_Wall_Concrete_8x4.Build_Wall_Concrete_8x4_C'), [800, 20, 400]);
  assert.equal(pieceSize('/x/Build_Pipeline_NoIndicator.Build_Pipeline_NoIndicator_C'), 'spline');
  assert.equal(pieceSize('/x/Build_CeilingLight.Build_CeilingLight_C'), null, 'lights are never guessed');
});

test('an identity rotation gives world axes and boxes span the piece size', () => {
  assert.deepEqual(axes({ x: 0, y: 0, z: 0, w: 1 }), [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }]);
  const { boxes } = pieceBoxes([piece(FOUNDATION, 100, 200, 300)]);
  const xs = boxes[0].v.map(v => v.x), zs = boxes[0].v.map(v => v.z);
  // Sizes come from the game catalog where the game reported them (float cm), so compare to 0.05 cm.
  const near = (got, want) => got.every((g, i) => Math.abs(g - want[i]) < 0.05);
  assert.ok(near([Math.min(...xs), Math.max(...xs)], [-300, 500]), xs.join());
  assert.ok(near([Math.min(...zs), Math.max(...zs)], [200, 400]), zs.join());
});

test('a 90 degree yaw turns the box footprint', () => {
  const s = Math.SQRT1_2, { boxes } = pieceBoxes([{ ...piece('/x/Build_Wall_Concrete_8x4.Build_Wall_Concrete_8x4_C'), transform: { translation_cm: { x: 0, y: 0, z: 0 }, rotation_quat: { x: 0, y: 0, z: s, w: s }, scale3d: { x: 1, y: 1, z: 1 } } }]);
  const xs = boxes[0].v.map(v => v.x), ys = boxes[0].v.map(v => v.y);
  assert.ok(Math.max(...xs) - Math.min(...xs) < 25, 'the 800 cm length now runs along Y');
  assert.ok(Math.max(...ys) - Math.min(...ys) > 790);
});

test('broken pieces and splines are skipped and counted, never invented', () => {
  const { boxes, skipped } = pieceBoxes([piece(FOUNDATION), { class_path: FOUNDATION }, piece('/x/Build_Pipeline.Build_Pipeline_C')]);
  assert.equal(boxes.length, 1);
  assert.equal(skipped.length, 2);
  const out = renderHtml([piece(FOUNDATION), piece('/x/Build_Pipeline.Build_Pipeline_C')], { title: '<Tunnel & co>' });
  assert.match(out.html, /&lt;Tunnel &amp; co&gt; · 1 pieces · 1 pipes\/belts\/wires not drawn/);
  assert.equal((out.html.match(/<figure>/g) ?? []).length, 3);
  assert.match(viewSvg([], { yaw: 0, pitch: 30 }), /<svg/);
});

test('a render is saved as a PNG through headless Edge', { skip: !EDGE_PATHS.some(existsSync) && 'no Edge or Chrome on this machine' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-'));
  const pieces = Array.from({ length: 6 }, (_, i) => piece(FOUNDATION, i * 800, 0, 0));
  const r = await renderPng(pieces, join(dir, 'candidate-1.png'), { title: 'Test strip', real: false });
  assert.equal(r.pieces, 6);
  assert.ok(existsSync(r.file));
});

test('measured native bounds are used, and unmeasured pieces become labelled markers', () => {
  const FAN = '/Factory_Prop_Mod/FactoryDecorMod/WallFan/Steel/SteelWallFan.SteelWallFan_C';
  const bounds = boundsFromMeasurements([{ measurements: [{ class_path: FAN, local_bounds_origin_cm: { x: 0, y: 0, z: 400 }, bounds_extent_cm: { x: 168.5, y: 400, z: 400 } }, { class_path: 'bad' }] }]);
  assert.deepEqual(Object.keys(bounds), [FAN]);
  const { boxes, unknown } = pieceBoxes([piece(FAN), piece('/x/Build_CeilingLight.Build_CeilingLight_C')], { bounds });
  const zs = boxes[0].v.map(v => v.z);
  assert.deepEqual([Math.min(...zs), Math.max(...zs)], [0, 800], 'the fan stands 8 m tall from its pivot');
  assert.deepEqual(unknown, ['Build_CeilingLight_C']);
  const html = renderHtml([piece('/x/Build_CeilingLight.Build_CeilingLight_C')]).html;
  assert.match(html, /red markers = size unknown: Build_CeilingLight_C/);
  assert.match(html, /cannot certify clipping/);
});

test('the game catalog: only placeable game classes are eligible, and game-reported sizes come from it', async () => {
  const { loadGameCatalog, ineligible, catalogBounds } = await import('../lib/game-catalog.mjs');
  const catalog = loadGameCatalog();
  assert.ok(catalog.size > 500, 'the catalog lists the game\'s placeable buildings');
  assert.equal(ineligible(FOUNDATION), null);
  assert.match(ineligible('/Game/Made/Up/Build_NeonTube.Build_NeonTube_C'), /not a building the game can place/);
  assert.match(ineligible('/x/y', null), /catalog is missing/);
  const b = catalogBounds()[FOUNDATION];
  assert.ok(Math.abs(b.extent.x - 400) < 0.01 && Math.abs(b.extent.z - 100) < 0.01, 'the 8x2 foundation is 8 m x 2 m as the game reported');
});
