/**
 * A browsable library of everything that can be placed, served by the bridge.
 *
 * The owner wanted the game's blueprint panel: see what is saved, pick one,
 * place it. Two of those three are reachable from here — a page listing every
 * saved design and blueprint with its contents, handing over the exact phrase
 * to say. The third, clicking to place, needs the mod to poll the bridge for a
 * queued command, which it does not do; the page says so rather than offering a
 * button that quietly does nothing.
 *
 * Rendered on request, so it always shows the folder as it is now. The data is
 * also served as JSON at `/library.json`, which is what lets the page refresh
 * itself without a reload and without re-sending the markup.
 */

import { describeUnplaceableByCoordinate } from "./designs.mjs";

const STYLES = `
:root{color-scheme:dark light;--bg:#0d1117;--panel:#161b22;--raise:#1c232c;
--line:#2a313b;--ink:#e6edf3;--dim:#8b949e;--hot:#ff8b3d;--good:#3fb950;--r:11px}
@media(prefers-color-scheme:light){:root{--bg:#fff;--panel:#f6f8fa;--raise:#fff;
--line:#d6dde5;--ink:#1f2328;--dim:#59636e;--hot:#bc4c00;--good:#1a7f37}}
*{box-sizing:border-box}
html{scrollbar-gutter:stable}
body{margin:0;background:var(--bg);color:var(--ink);
font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif}
header{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 88%,transparent);
backdrop-filter:blur(10px);border-bottom:1px solid var(--line);padding:18px 28px 14px}
.bar{display:flex;gap:14px;align-items:center;flex-wrap:wrap;max-width:1200px;margin:0 auto}
h1{margin:0;font-size:17px;font-weight:650;letter-spacing:.2px;white-space:nowrap}
.count{color:var(--dim);font-size:12.5px;white-space:nowrap}
.spacer{flex:1}
input[type=search]{flex:1 1 240px;min-width:170px;background:var(--panel);color:var(--ink);
border:1px solid var(--line);border-radius:9px;padding:8px 12px;font-size:14px}
input[type=search]:focus{outline:none;border-color:var(--hot)}
select,button{background:var(--panel);color:var(--ink);border:1px solid var(--line);
border-radius:9px;padding:8px 11px;font-size:13px;cursor:pointer}
button:hover,select:hover{background:var(--raise);border-color:#3d444d}
button.done{color:var(--good);border-color:var(--good)}
main{padding:22px 28px 64px;max-width:1200px;margin:0 auto}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--dim);
margin:30px 0 12px;font-weight:600;display:flex;gap:9px;align-items:baseline}
h2:first-child{margin-top:4px}
h2 .n{font-size:11px;border:1px solid var(--line);border-radius:999px;padding:1px 8px}
.grid{display:grid;gap:13px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);
padding:15px 16px;display:flex;flex-direction:column;gap:10px;transition:border-color .12s}
.card:hover{border-color:#3d444d}
.card h3{margin:0;font-size:14.5px;font-weight:600;overflow-wrap:anywhere;line-height:1.35}
.meta{display:flex;gap:6px;flex-wrap:wrap}
.tag{font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:999px;
padding:2px 8px;white-space:nowrap}
.parts{font-size:12.5px;color:var(--dim);line-height:1.5;overflow-wrap:anywhere}
.says{display:flex;flex-direction:column;gap:6px;margin-top:auto}
.say{display:flex;gap:6px}
code{flex:1;background:var(--bg);border:1px solid var(--line);border-radius:8px;
padding:7px 9px;font:12px ui-monospace,"Cascadia Code",Consolas,monospace;
color:var(--hot);overflow-wrap:anywhere}
.say button{padding:0 11px;font-size:12px}
.turns{display:flex;align-items:center;gap:6px;margin-top:2px}
.turns span{color:var(--dim);font-size:11.5px;letter-spacing:.02em}
.turns button{padding:3px 9px;font-size:11.5px}
.empty{color:var(--dim);border:1px dashed var(--line);border-radius:var(--r);
padding:20px;font-size:13.5px;line-height:1.6}
.note{margin-top:32px;padding:14px 16px;border:1px solid var(--line);border-radius:var(--r);
background:var(--panel);color:var(--dim);font-size:12.5px;line-height:1.6}
.note b{color:var(--ink);font-weight:600}
kbd{border:1px solid var(--line);border-bottom-width:2px;border-radius:5px;
padding:0 5px;font:11px ui-monospace,monospace;color:var(--ink)}
.hidden{display:none!important}
`;

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);

const shortName = (classPath) =>
  String(classPath ?? "").split(".").pop().replace(/^(Build|Desc|Recipe)_/, "").replace(/_C$/, "");

/** "3 × Smelter · 2 × Constructor" — what a design is actually made of. */
function describeContents(buildings) {
  const counts = new Map();
  for (const entry of buildings ?? []) {
    const name = shortName(entry.class_path || entry.recipe_class);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, 5).map(([name, count]) => `${count} × ${name}`);
  if (sorted.length > shown.length) shown.push(`+${sorted.length - shown.length} more`);
  return shown.join(" · ");
}

function footprintOf(buildings) {
  const xs = (buildings ?? []).map((entry) => entry.offset_cm?.x).filter(Number.isFinite);
  const ys = (buildings ?? []).map((entry) => entry.offset_cm?.y).filter(Number.isFinite);
  if (xs.length === 0) return null;
  return `${Math.round((Math.max(...xs) - Math.min(...xs)) / 100)} × ` +
    `${Math.round((Math.max(...ys) - Math.min(...ys)) / 100)} m`;
}

const hasExtractor = (buildings) =>
  (buildings ?? []).some((entry) => /Miner|Extractor|Pump/i.test(String(entry.recipe_class)));

/** The library as plain data. The page fetches this to refresh itself. */
export function buildLibraryModel({ designs = [], blueprints = [] } = {}) {
  return {
    schema: "aifactory.library/v1",
    generated_at_utc: new Date().toISOString(),
    designs: designs.map((design) => {
      // Count what will actually be placed. A design saved before the capture
      // separated links from buildings still carries its belts and power lines
      // on the buildings list, and promising 27 when 18 go down is the kind of
      // small lie the rest of this project spends its time avoiding.
      const placeable = (design.buildings ?? []).filter(
        (entry) => !describeUnplaceableByCoordinate(entry.class_path),
      );
      const links = (design.buildings ?? []).length - placeable.length + (design.links ?? []).length;
      return {
      name: design.name,
      kind: "design",
      count: placeable.length,
      links,
      footprint: footprintOf(placeable),
      picked: design.selected_by === "dismantle_selection",
      contents: describeContents(placeable),
      // A design containing a miner is meant for a node, so offer that phrasing
      // first — it is the one that makes the extractor attach.
      says: hasExtractor(placeable)
        ? [`place ${design.name} on this node`, `place ${design.name} here`]
        : [`place ${design.name} here`],
      };
    }),
    blueprints: blueprints.map((blueprint) => ({
      name: blueprint.name,
      kind: "blueprint",
      count: (blueprint.build_cost ?? []).reduce((total, entry) => total + (entry.amount ?? 0), 0),
      footprint: blueprint.designer_dimensions
        ? `${blueprint.designer_dimensions.x} × ${blueprint.designer_dimensions.y} foundations`
        : null,
      changelist: blueprint.game_changelist ?? null,
      contents: (blueprint.build_cost ?? [])
        .slice()
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 5)
        .map((entry) => `${entry.amount} × ${entry.item_name}`)
        .join(" · "),
      says: [`place ${blueprint.name} here`],
    })),
  };
}

const CLIENT = `
const state = { query: '', sort: 'name', model: null };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function card(item) {
  const tags = [
    item.kind === 'design' ? item.count + ' buildings' : item.count + ' parts',
    item.footprint,
    item.changelist ? 'CL ' + item.changelist : null,
    item.kind === 'design' ? (item.picked ? 'hand-picked' : 'by radius') : null,
    // Say it on the card rather than letting the number quietly disagree with
    // what lands: belts and wires join two ends, so they are not replayed.
    item.links ? item.links + ' belts/wires not replayed' : null,
  ].filter(Boolean);
  return '<article class="card"><h3>' + esc(item.name) + '</h3>' +
    '<div class="meta">' + tags.map(t => '<span class="tag">' + esc(t) + '</span>').join('') + '</div>' +
    (item.contents ? '<div class="parts">' + esc(item.contents) + '</div>' : '') +
    '<div class="says">' + item.says.map(say =>
      '<div class="say"><code>' + esc(say) + '</code>' +
      '<button data-say="' + esc(say) + '">copy</button></div>').join('') +
    // Turning it, the way a vanilla blueprint turns under the build gun. The
    // first phrase is the one that matters -- for a design with a miner that is
    // the "on this node" one -- and the turn is appended to it.
    (item.kind === 'design'
      ? '<div class="turns"><span>turned</span>' + [90, 180, 270].map(deg =>
          '<button data-say="' + esc(item.says[0] + ' rotated ' + deg) + '">' + deg +
          '\\u00b0</button>').join('') + '</div>'
      : '') +
    '</div></article>';
}

function matches(item) {
  if (!state.query) return true;
  const hay = (item.name + ' ' + (item.contents || '')).toLowerCase();
  // Every word must appear somewhere, so "coal mk1" narrows rather than widens.
  return state.query.toLowerCase().split(/\\s+/).filter(Boolean).every(w => hay.includes(w));
}

function sorted(items) {
  const by = state.sort;
  return items.slice().sort((a, b) =>
    by === 'size' ? (b.count - a.count) || a.name.localeCompare(b.name)
                  : a.name.localeCompare(b.name));
}

function section(id, items, emptyText) {
  const list = sorted(items.filter(matches));
  document.querySelector('#' + id + ' .n').textContent = list.length;
  const body = document.querySelector('#' + id + '-body');
  body.innerHTML = list.length
    ? '<div class="grid">' + list.map(card).join('') + '</div>'
    : '<p class="empty">' + esc(state.query ? 'Nothing matches "' + state.query + '".' : emptyText) + '</p>';
}

function render() {
  if (!state.model) return;
  section('designs', state.model.designs,
    'Nothing saved yet. Mark buildings with the dismantle tool and say "save this as <name>".');
  section('blueprints', state.model.blueprints, 'No .sbp blueprints found for this save.');
  const total = state.model.designs.length + state.model.blueprints.length;
  document.getElementById('count').textContent =
    total + ' item' + (total === 1 ? '' : 's') + ' · updated ' +
    new Date(state.model.generated_at_utc).toLocaleTimeString();
}

async function refresh() {
  try {
    const response = await fetch('/library.json', { cache: 'no-store' });
    if (!response.ok) return;
    state.model = await response.json();
    render();
  } catch { /* the bridge restarts sometimes; the next tick picks it up */ }
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-say]');
  if (!button) return;
  try { await navigator.clipboard.writeText(button.dataset.say); } catch { return; }
  const was = button.textContent;
  button.textContent = 'copied';
  button.classList.add('done');
  setTimeout(() => { button.textContent = was; button.classList.remove('done'); }, 1100);
});

document.getElementById('q').addEventListener('input', (event) => {
  state.query = event.target.value.trim();
  render();
});
document.getElementById('sort').addEventListener('change', (event) => {
  state.sort = event.target.value;
  render();
});
document.getElementById('reload').addEventListener('click', refresh);

document.addEventListener('keydown', (event) => {
  const box = document.getElementById('q');
  if (event.key === '/' && document.activeElement !== box) { event.preventDefault(); box.focus(); }
  if (event.key === 'Escape' && document.activeElement === box) {
    box.value = ''; state.query = ''; render(); box.blur();
  }
});

refresh();
// Saving a design in game should show up here without a reload.
setInterval(refresh, 5000);
`;

/** The page shell. Content is filled in by the client from `/library.json`. */
export function renderLibraryPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Factory Library</title><style>${STYLES}</style></head><body>
<header><div class="bar">
<h1>Factory Library</h1>
<span class="count" id="count">loading…</span>
<span class="spacer"></span>
<input type="search" id="q" placeholder="Filter by name or contents…  /" autocomplete="off">
<select id="sort" aria-label="Sort">
<option value="name">A–Z</option><option value="size">Largest first</option>
</select>
<button id="reload">Refresh</button>
</div></header>
<main>
<h2 id="designs">Saved designs <span class="n">0</span></h2>
<div id="designs-body"></div>
<h2 id="blueprints">Game blueprints <span class="n">0</span></h2>
<div id="blueprints-body"></div>
<p class="note"><b>Copy a line and say it in game.</b> Placing from this page
would need the mod to poll the bridge for a queued command, which it does not
do — so the button copies the phrase rather than pretending to build. A design
keeps the spacing, facing and recipes it was saved with; one containing a miner
offers <em>on this node</em> first, which is the phrasing that attaches the
extractor. Press <kbd>/</kbd> to search, <kbd>Esc</kbd> to clear. The list
refreshes itself every few seconds, so a design saved in game appears here on
its own.</p>
</main><script>${CLIENT}</script></body></html>`;
}
