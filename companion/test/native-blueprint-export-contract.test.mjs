import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const native = new URL('../../Source/AIFactoryCopilot/', import.meta.url);
test('every generated schema reloads the saved Blueprint before claiming exact readback', () => {
  const source = readFileSync(new URL('Private/AIFactoryBlueprintExport.cpp', native), 'utf8');
  assert(!source.includes('bool bExactNativeReadback = bSchemaV1;'), 'Structural v1 must not predeclare a readback that never happened');
  assert.match(source, /bool bExactNativeReadback = false;/);
  assert(!source.includes('bReadable && (bSchemaV2 || bSchemaV3 || bSchemaV4)'), 'All supported schemas need the isolated native reload');
  assert(source.includes('AIFactoryGeneratedGeometry::Match'));
  assert(source.includes('exact_saved_part_transforms'));
  assert(source.includes('exact_native_geometry_readback'));
});
