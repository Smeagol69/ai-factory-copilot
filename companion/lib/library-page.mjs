/**
 * A browsable library of everything that can be placed, served by the bridge.
 *
 * The owner wanted the game's blueprint panel: see what you have saved, pick
 * one, place it. Two of those three are reachable from here — a page that lists
 * every saved design and blueprint with its contents, and hands over the exact
 * phrase to say. The third, clicking to place, needs the mod to poll for a
 * queued command, which it does not do; the page says so rather than pretending
 * the button is coming.
 *
 * Served from the bridge rather than written as a static file, so it always
 * shows what is actually on disk right now instead of a snapshot of it.
 */

const STYLES = `
:root{color-scheme:dark;--bg:#0e1116;--panel:#161b22;--line:#272e38;--ink:#e6edf3;
--dim:#8b949e;--hot:#ff8b3d;--good:#3fb950}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif}
header{padding:28px 32px 18px;border-bottom:1px solid var(--line);
display:flex;align-items:baseline;gap:16px;flex-wrap:wrap}
h1{margin:0;font-size:19px;letter-spacing:.2px;font-weight:650}
.sub{color:var(--dim);font-size:13px}
main{padding:24px 32px 56px;max-width:1180px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.09em;color:var(--dim);
margin:34px 0 14px;font-weight:600}
h2:first-child{margin-top:0}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(310px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;
padding:16px 17px;display:flex;flex-direction:column;gap:11px}
.card h3{margin:0;font-size:15px;font-weight:600;overflow-wrap:anywhere}
.meta{display:flex;gap:8px;flex-wrap:wrap}
.tag{font-size:11.5px;color:var(--dim);border:1px solid var(--line);
border-radius:999px;padding:2px 9px;white-space:nowrap}
.parts{font-size:12.5px;color:var(--dim);line-height:1.5;overflow-wrap:anywhere}
.say{display:flex;gap:8px;align-items:stretch;margin-top:auto}
code{flex:1;background:#0b0e13;border:1px solid var(--line);border-radius:7px;
padding:8px 10px;font:12.5px ui-monospace,"Cascadia Code",Consolas,monospace;
color:var(--hot);overflow-wrap:anywhere}
button{background:#21262d;color:var(--ink);border:1px solid var(--line);
border-radius:7px;padding:0 13px;font-size:12.5px;cursor:pointer;white-space:nowrap}
button:hover{background:#2b313a;border-color:#3d444d}
button.done{color:var(--good);border-color:var(--good)}
.empty{color:var(--dim);border:1px dashed var(--line);border-radius:10px;
padding:22px;font-size:13.5px}
.note{margin-top:34px;padding:15px 17px;border:1px solid var(--line);
border-radius:10px;background:var(--panel);color:var(--dim);font-size:13px}
.note b{color:var(--ink);font-weight:600}
@media(prefers-color-scheme:light){:root{--bg:#fff;--panel:#f6f8fa;--line:#d8dee4;
--ink:#1f2328;--dim:#59636e;--hot:#bc4c00;--good:#1a7f37}code{background:#fff}
button{background:#f6f8fa}}
`;

const SCRIPT = `
document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-say]');
  if (!button) return;
  try { await navigator.clipboard.writeText(button.dataset.say); }
  catch { return; }
  const was = button.textContent;
  button.textContent = 'copied';
  button.classList.add('done');
  setTimeout(() => { button.textContent = was; button.classList.remove('done'); }, 1200);
});
`;

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);

const shortName = (classPath) =>
  String(classPath ?? "").split(".").pop().replace(/^(Build|Desc|Recipe)_/, "").replace(/_C$/, "");

/** "3 × Smelter, 2 × Constructor" — what a design is actually made of. */
function describeContents(buildings) {
  const counts = new Map();
  for (const entry of buildings ?? []) {
    const name = shortName(entry.class_path || entry.recipe_class);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, count]) => `${count} × ${name}`)
    .join(" · ");
}

function footprintOf(buildings) {
  const xs = (buildings ?? []).map((entry) => entry.offset_cm?.x).filter(Number.isFinite);
  const ys = (buildings ?? []).map((entry) => entry.offset_cm?.y).filter(Number.isFinite);
  if (xs.length === 0) return null;
  const width = Math.round((Math.max(...xs) - Math.min(...xs)) / 100);
  const depth = Math.round((Math.max(...ys) - Math.min(...ys)) / 100);
  return `${width} × ${depth} m`;
}

function card({ title, tags, parts, say }) {
  return `<article class="card">
<h3>${escapeHtml(title)}</h3>
<div class="meta">${tags.filter(Boolean).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
${parts ? `<div class="parts">${escapeHtml(parts)}</div>` : ""}
<div class="say"><code>${escapeHtml(say)}</code><button data-say="${escapeHtml(say)}">copy</button></div>
</article>`;
}

/** The whole page. `designs` and `blueprints` are already-read library lists. */
export function renderLibraryPage({ designs = [], blueprints = [] } = {}) {
  const designCards = designs.map((design) =>
    card({
      title: design.name,
      tags: [
        `${design.building_count} buildings`,
        footprintOf(design.buildings),
        design.selected_by === "dismantle_selection" ? "hand-picked" : "by radius",
      ],
      parts: describeContents(design.buildings),
      say: `place ${design.name} here`,
    }),
  );

  const blueprintCards = blueprints.map((blueprint) => {
    const dimensions = blueprint.designer_dimensions;
    return card({
      title: blueprint.name,
      tags: [
        dimensions ? `${dimensions.x} × ${dimensions.y} foundations` : null,
        blueprint.game_changelist ? `CL ${blueprint.game_changelist}` : null,
        `${(blueprint.build_cost ?? []).length} cost entries`,
      ],
      parts: (blueprint.build_cost ?? [])
        .slice()
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 5)
        .map((entry) => `${entry.amount} × ${entry.item_name}`)
        .join(" · "),
      say: `place ${blueprint.name} here`,
    });
  });

  const section = (heading, cards, emptyText) =>
    `<h2>${heading}</h2>` +
    (cards.length > 0
      ? `<div class="grid">${cards.join("")}</div>`
      : `<p class="empty">${escapeHtml(emptyText)}</p>`);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Factory Copilot — Library</title><style>${STYLES}</style></head><body>
<header><h1>Factory Library</h1>
<span class="sub">${designs.length} saved design(s) · ${blueprints.length} blueprint(s) · read live from disk</span>
</header><main>
${section("Saved designs", designCards, 'Nothing saved yet. Mark buildings with the dismantle tool and say "save this as <name>".')}
${section("Game blueprints", blueprintCards, "No .sbp blueprints found for this save.")}
<p class="note"><b>Copy a line and say it in game.</b> Placing from this page
would need the mod to poll the bridge for a queued command, which it does not
do — so the button copies the phrase rather than pretending to build. A design
keeps the spacing, facing and recipes it was saved with, and any miner in it
attaches to the node you are aiming at.</p>
</main><script>${SCRIPT}</script></body></html>`;
}
