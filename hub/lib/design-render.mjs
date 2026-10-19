// Offline design renders: a piece list (class + full transform, the shape of
// saved blueprint poses) drawn as oriented shaded boxes in three views, then
// saved as PNG by headless Edge. No game calls. Box sizes are approximations by
// class family, good enough to judge proportions, joints and clashes; the game
// stays the authority on exact meshes.
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function pieceSize(classPath) {
  const n = String(classPath).split('.').pop();
  let m = n.match(/Foundation\w*?_(\d+)x(\d+)/); if (m) return [+m[1] * 100, +m[1] * 100, +m[2] * 100];
  m = n.match(/Ramp\w*?_(\d+)x(\d+)/); if (m) return [+m[1] * 100, +m[1] * 100, +m[2] * 100];
  m = n.match(/Wall\w*?_(\d+)x(\d+)/); if (m && !/Support/.test(n)) return [+m[1] * 100, 20, +m[2] * 100];
  if (/Pillar_Small/.test(n)) return [100, 100, 400];
  if (/Pillar/.test(n)) return [200, 200, 400];
  if (/CeilingLight/.test(n)) return [400, 200, 40];
  if (/EmissiveBeam|Beam/.test(n)) return [400, 40, 40];
  if (/Pipeline|ConveyorBelt|PowerLine|Wire/.test(n)) return null; // splines: not drawn as boxes
  return [100, 100, 100];
}
const tint = cls => /Foundation|Ramp/.test(cls) ? [196, 178, 150] : /Light|Emissive/.test(cls) ? [255, 226, 140]
  : /Wall/.test(cls) ? [176, 186, 196] : /Pillar|Beam/.test(cls) ? [170, 170, 180] : [120, 150, 190];

// Unreal's local axes from a quaternion (the same convention the compilers use).
export function axes(q) {
  return [
    { x: 1 - 2 * (q.y * q.y + q.z * q.z), y: 2 * (q.x * q.y + q.w * q.z), z: 2 * (q.x * q.z - q.w * q.y) },
    { x: 2 * (q.x * q.y - q.w * q.z), y: 1 - 2 * (q.x * q.x + q.z * q.z), z: 2 * (q.y * q.z + q.w * q.x) },
    { x: 2 * (q.x * q.z + q.w * q.y), y: 2 * (q.y * q.z - q.w * q.x), z: 1 - 2 * (q.x * q.x + q.y * q.y) }];
}

export function pieceBoxes(pieces) {
  const boxes = [], skipped = [];
  for (const p of pieces) {
    const t = p?.transform?.translation_cm, q = p?.transform?.rotation_quat, s3 = p?.transform?.scale3d ?? { x: 1, y: 1, z: 1 };
    const size = pieceSize(p?.class_path);
    if (!size || !t || !q || ![t.x, t.y, t.z, q.x, q.y, q.z, q.w].every(Number.isFinite)) { skipped.push(p?.class_path ?? 'unknown'); continue; }
    const [X, Y, Z] = axes(q), h = [size[0] * s3.x / 2, size[1] * s3.y / 2, size[2] * s3.z / 2];
    const c = (a, b, d) => ({ x: t.x + X.x * a * h[0] + Y.x * b * h[1] + Z.x * d * h[2], y: t.y + X.y * a * h[0] + Y.y * b * h[1] + Z.y * d * h[2], z: t.z + X.z * a * h[0] + Y.z * b * h[1] + Z.z * d * h[2] });
    boxes.push({ v: [c(-1, -1, -1), c(1, -1, -1), c(1, 1, -1), c(-1, 1, -1), c(-1, -1, 1), c(1, -1, 1), c(1, 1, 1), c(-1, 1, 1)], rgb: tint(p.class_path) });
  }
  return { boxes, skipped };
}

const FACES = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
export function viewSvg(boxes, { yaw, pitch, width = 520, height = 400 }) {
  const a = yaw * Math.PI / 180, b = pitch * Math.PI / 180, light = { x: 0.4, y: -0.3, z: 0.86 };
  // Unreal is left-handed (Y right); flip Y so the picture is not mirrored.
  const proj = p => { const x = p.x, y = -p.y, z = p.z, rx = Math.cos(a) * x - Math.sin(a) * y, ry = Math.sin(a) * x + Math.cos(a) * y;
    return { sx: rx, sy: -(z * Math.cos(b) - ry * Math.sin(b)), d: ry * Math.cos(b) + z * Math.sin(b) }; };
  const polys = [];
  for (const box of boxes) for (const f of FACES) {
    const pts = f.map(i => box.v[i]);
    const u = { x: pts[1].x - pts[0].x, y: pts[1].y - pts[0].y, z: pts[1].z - pts[0].z }, w = { x: pts[3].x - pts[0].x, y: pts[3].y - pts[0].y, z: pts[3].z - pts[0].z };
    const n = { x: u.y * w.z - u.z * w.y, y: u.z * w.x - u.x * w.z, z: u.x * w.y - u.y * w.x }, L = Math.hypot(n.x, n.y, n.z) || 1;
    const shade = 0.45 + 0.55 * Math.abs((n.x * light.x + n.y * light.y + n.z * light.z) / L);
    const pp = pts.map(proj);
    polys.push({ pp, d: pp.reduce((s, p) => s + p.d, 0) / 4, fill: `rgb(${box.rgb.map(c => Math.round(c * shade)).join(',')})` });
  }
  if (!polys.length) return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"></svg>`;
  polys.sort((p, q) => p.d - q.d); // painter's order: far faces first
  const xs = polys.flatMap(p => p.pp.map(q => q.sx)), ys = polys.flatMap(p => p.pp.map(q => q.sy));
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const k = Math.min(width / Math.max(x1 - x0, 1), height / Math.max(y1 - y0, 1)) * 0.92, ox = (width - (x1 - x0) * k) / 2, oy = (height - (y1 - y0) * k) / 2;
  const path = polys.map(p => `<path d="M${p.pp.map(q => `${((q.sx - x0) * k + ox).toFixed(1)},${((q.sy - y0) * k + oy).toFixed(1)}`).join('L')}Z" fill="${p.fill}" stroke="rgba(40,30,20,.35)" stroke-width=".6"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${path}</svg>`;
}

const escape = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export function renderHtml(pieces, { title = 'Design' } = {}) {
  const { boxes, skipped } = pieceBoxes(pieces);
  const views = [['Isometric (front-right)', 35, 32], ['Isometric (back-left)', 215, 32], ['Top', 0, 89.9]]
    .map(([label, yaw, pitch]) => `<figure>${viewSvg(boxes, { yaw, pitch })}<figcaption>${label}</figcaption></figure>`).join('');
  const note = skipped.length ? ` · ${skipped.length} pipes/belts/wires not drawn` : '';
  return { pieces: boxes.length, skipped: skipped.length, html: `<!doctype html><meta charset=utf-8><style>body{margin:0;background:#1b2028;color:#cfd6df;font:14px Segoe UI,Arial;padding:12px;width:1680px}figure{display:inline-block;margin:6px;background:#11161d;border-radius:8px;padding:6px}figcaption{text-align:center;padding:4px}h3{margin:4px 8px}</style><h3>${escape(title)} · ${boxes.length} pieces${note} · offline render, approximate box sizes</h3>${views}` };
}

export const EDGE_PATHS = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'];
export async function renderPng(pieces, outFile, { title, browser = EDGE_PATHS.find(existsSync), timeoutMs = 60000 } = {}) {
  if (!browser) throw new Error('No Edge or Chrome found to save the render');
  const { html, pieces: count, skipped } = renderHtml(pieces, { title });
  mkdirSync(dirname(outFile), { recursive: true });
  const htmlFile = outFile.replace(/\.png$/i, '') + '.html';
  writeFileSync(htmlFile, html);
  const profile = join(dirname(outFile), '.browser-profile');
  await new Promise((resolve, reject) => {
    const child = spawn(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${profile}`, '--window-size=1720,500', `--screenshot=${outFile}`, pathToFileURL(htmlFile).href], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Render timed out')); }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', () => { clearTimeout(timer); resolve(); });
  });
  if (!existsSync(outFile) || statSync(outFile).size < 1000) throw new Error('The browser did not save a render');
  return { file: outFile, htmlFile, pieces: count, skipped };
}
