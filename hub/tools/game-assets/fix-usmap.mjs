// Satisfactory's shipped CommunityResources/FactoryGame.usmap writes an
// OptionalProperty (type 0x1C) without its inner property type; the .usmap format
// (and CUE4Parse) expect one. This copies the file and inserts an "unknown" inner
// type (0xFF) after every OptionalProperty, so CUE4Parse can read the mappings.
// The game's own file is never modified.
//   node fix-usmap.mjs <in.usmap> <out.usmap>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [input, output] = process.argv.slice(2);
const b = readFileSync(input);
let o = 0;
const u8 = () => b[o++], u16 = () => { const v = b.readUInt16LE(o); o += 2; return v; };
const i32 = () => { const v = b.readInt32LE(o); o += 4; return v; }, u32 = () => { const v = b.readUInt32LE(o); o += 4; return v; };

if (u16() !== 0x30C4) throw new Error('Not a .usmap file');
const version = u8();
if (version > 1) throw new Error(`Unexpected usmap version ${version}; this fix was written for version 1`);
if (i32()) { i32(); i32(); const n = i32(); o += n * 20; i32(); }
const compressionAt = o;
if (u8() !== 0) throw new Error('Compressed usmap; this fix handles the uncompressed file the game ships');
u32(); u32();
const bodyStart = o;
const names = u32();

o = bodyStart + 4;
for (let i = 0; i < names; i++) { const l = u8(); o += l; }
const enums = u32(); for (let i = 0; i < enums; i++) { i32(); const entries = u8(); o += entries * 4; }
const structsAt = o;

// Re-serialise the structs with the missing inner types inserted.
const out = [];
const copy = (from, to) => out.push(b.subarray(from, to));
let inserted = 0;
function prop() {
  const start = o, t = u8();
  copy(start, o);
  if (t === 26) { prop(); const s = o; i32(); copy(s, o); }
  else if (t === 9) { const s = o; i32(); copy(s, o); }
  else if (t === 8 || t === 25) prop();
  else if (t === 24) { prop(); prop(); }
  else if (t === 28) { out.push(Buffer.from([0xFF])); inserted++; }
  else if (t > 30 && t !== 255) throw new Error(`Unknown property type ${t} at ${start}`);
}
o = structsAt;
const structs = u32();
copy(structsAt, o);
for (let s = 0; s < structs; s++) {
  const head = o; i32(); i32(); u16(); const serial = u16(); copy(head, o);
  for (let p = 0; p < serial; p++) { const ph = o; u16(); u8(); i32(); copy(ph, o); prop(); }
}
copy(o, b.length); // anything after the structs, unchanged
const body = Buffer.concat(out);
const before = b.subarray(0, structsAt);
const result = Buffer.concat([before, body]);
// Fix the uncompressed/decompressed sizes in the header.
const dataLen = result.length - bodyStart;
result.writeUInt32LE(dataLen, compressionAt + 1); result.writeUInt32LE(dataLen, compressionAt + 5);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, result);
console.log(`${structs} structs, inserted ${inserted} missing OptionalProperty inner types -> ${output}`);
