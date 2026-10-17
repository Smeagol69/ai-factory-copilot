const byId = id => document.getElementById(id);
const el = (tag, text, className) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; };
let current;
function card(title, value, detail) { const n = el('article', null, 'card'); n.append(el('h3', title), el('div', value, 'value'), el('p', detail)); return n; }
function listItem(title, detail, tag) { const n = el('div', null, 'item'); if (tag) n.append(el('span', tag, 'tag')); n.append(el('strong', title), el('small', detail)); return n; }
function modelWork(s) {
  const workers = s.modelWork?.workers ?? [];
  byId('model-work').replaceChildren(...workers.map(w => {
    const n = el('article', null, 'worker');
    n.append(el('div', `${w.provider.toUpperCase()} · ${w.role}`, 'eyebrow'), el('h3', w.task));
    const state = w.reviewCurrent ? 'Adapter reviewed and approved' : w.review === 'approve' ? 'Previous artifact reviewed; current artifact needs review' : `Reported: ${w.reportedStatus}`;
    n.append(el('strong', state), el('p', w.model ?? w.summary ?? 'Local integration worker', 'muted'));
    const evidence = [w.commit ? `Code commit ${w.commit.slice(0, 7)}` : null,
      w.toolCallsCompleted != null ? `${w.toolCallsCompleted} completed tool calls` : null,
      w.testsPassed != null ? `${w.testsPassed} tests passed` : null,
      w.error ? `Last error: ${w.error}` : null].filter(Boolean).join(' · ');
    n.append(el('small', evidence), el('small', `Report: ${new Date(w.lastReportAt).toLocaleString()}${w.fresh ? '' : ' · Current activity unknown'}`));
    return n;
  }));
  if (!workers.length) byId('model-work').textContent = 'No explicit model jobs have reported yet.';
  const service = s.companionService;
  byId('bridge-detail').textContent = service?.owned
    ? `Bridge running inside this project · ${service.runningVersion} · port ${service.port}.${service.runtimeMatches ? '' : ' Installed update needs a service restart.'} Provider configuration checked. A loaded world and game changes still need verification.`
    : 'Bridge ownership has not been verified. Start or reconnect it here; the app will leave an unknown service alone.';
}
function designDraft(s) {
  const receipt = s.checks?.findLast(c => c.name === 'architect');
  const draft = receipt?.result;
  if (!draft) return;
  const target = byId('design-preview'); target.replaceChildren();
  if (!draft.compiled || !draft.manifest) {
    byId('design-summary').textContent = `Draft unavailable: ${draft.reason ?? receipt.error ?? 'See the check evidence.'}`;
    return;
  }
  const m = draft.manifest, capture = draft.capture;
  byId('design-summary').textContent = `${m.part_count} measured pieces · ${m.shell.wall_centerline_width_cm / 100} m wide × ${m.shell.grid_length_cm / 100} m long · ${m.shell.nominal_internal_height_cm / 100} m nominal internal height. Capture: ${capture.session}, ${new Date(capture.completedAtUtc ?? capture.generatedAtUtc).toLocaleString()} (${capture.freshness.status}). Geometry audit: ${draft.geometryAudit?.status ?? 'not run'} (${draft.geometryAudit?.testedPairs ?? 0} pairs). Draft only; no game writes.`;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Measured structural shell schematic; game placement not verified');
  const faces = [];
  for (const e of m.elements ?? []) {
    const piece = e.role === 'wall' ? m.pieces.wall : m.pieces.floor;
    const size = piece.measurement.local_size_cm, p = e.relative_location;
    if (![size.x, size.y, size.z, p.x, p.y, p.z, e.yaw, piece.measurement.local_min_z_cm].every(Number.isFinite)) continue;
    const angle = e.yaw * Math.PI / 180, c = Math.cos(angle), sin = Math.sin(angle);
    const corners = [];
    for (const z of [piece.measurement.local_min_z_cm, piece.measurement.local_min_z_cm + size.z]) {
      for (const [x, y] of [[-size.x / 2, -size.y / 2], [size.x / 2, -size.y / 2], [size.x / 2, size.y / 2], [-size.x / 2, size.y / 2]]) {
        const a = p.x + x * c - y * sin, b = p.y + x * sin + y * c, h = p.z + z;
        corners.push({ x: (a - b) * 0.866, y: (a + b) * 0.5 - h, depth: a + b + h });
      }
    }
    for (const indices of [[0, 1, 5, 4], [1, 2, 6, 5], [4, 5, 6, 7]]) {
      const points = indices.map(i => corners[i]); faces.push({ points, role: e.role, depth: points.reduce((v, p) => v + p.depth, 0) / 4 });
    }
  }
  const points = faces.flatMap(f => f.points);
  if (!points.length) return;
  const xmin = Math.min(...points.map(p => p.x)), ymin = Math.min(...points.map(p => p.y));
  const width = Math.max(...points.map(p => p.x)) - xmin, height = Math.max(...points.map(p => p.y)) - ymin;
  svg.setAttribute('viewBox', `${xmin - 100} ${ymin - 100} ${width + 200} ${height + 200}`);
  for (const face of faces.sort((a, b) => a.depth - b.depth)) {
    const polygon = document.createElementNS(ns, 'polygon');
    polygon.setAttribute('points', face.points.map(p => `${p.x},${p.y}`).join(' '));
    polygon.setAttribute('fill', face.role === 'roof' ? '#a4d2db' : face.role === 'wall' ? '#d4c29b' : '#719fce');
    polygon.setAttribute('fill-opacity', face.role === 'roof' ? '.24' : '.58');
    polygon.setAttribute('stroke', '#c4d8e5'); polygon.setAttribute('stroke-width', '2');
    svg.append(polygon);
  }
  target.append(svg);
}
function catalogue() {
  const filter = byId('filter').value.toLowerCase();
  const entries = (current?.catalogue?.entries ?? []).filter(e => `${e.name} ${e.category}`.toLowerCase().includes(filter));
  byId('catalogue-list').replaceChildren(...entries.map(e => {
    const n = listItem('', `${e.category} · Setup required`), link = el('a', e.name);
    link.href = e.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; n.prepend(link); return n;
  }));
}
async function refresh() {
  try {
    const response = await fetch('/api/status'); const s = await response.json();
    if (!response.ok) throw Error(s.error ?? 'Status unavailable');
    current = s;
    modelWork(s);
    designDraft(s);
    byId('connection').textContent = '● Local app connected';
    const verified = s.rea.verifiedTools;
    const reaCount = Array.isArray(verified) ? verified.length : typeof verified === 'number' ? verified : s.rea.mcp?.toolCount;
    byId('cards').replaceChildren(
      card('Agent Pair', 'Pinned & verified', '31 coordination tools · shared tasks and memory'),
      card('Superpowers', `${s.superpowers.skills ?? 15} skills`, 'Full upstream workflows, prompts and resources'),
      card('REA', s.rea.installed ? `Installed ${s.rea.version}` : 'Needs attention', reaCount ? `${reaCount} MCP tools verified` : 'Run the demo to verify local tools'),
      card('Satisfactory', s.companion.operationalReady ? 'Bridge ready' : 'Bridge unavailable', 'A loaded game world has not been verified')
    );
    byId('home').textContent = s.home;
    byId('storage').textContent = s.storage.sharedLedger + ' ' + s.storage.credentials;
    byId('rea-details').textContent = s.rea.installed ? `Local package ${s.rea.version}. MCP and CLI use the same bundled installation. Findings are stored in state/rea/.` : 'The local REA package could not be verified.';
    byId('rea-native').textContent = s.rea.native?.verified ? 'Ghidra: native analysis verified on the owned test program.' : 'Native decompiler: verification pending. External engine installation alone does not prove analysis works.';
    byId('rea-limitations').replaceChildren(...(s.rea.limitations ?? []).map(t => el('div', typeof t === 'string' ? t : JSON.stringify(t))));
    byId('tasks').replaceChildren(...s.tasks.slice(0, 8).map(t => listItem(t.id, `${t.owner} · ${t.description}`, t.status)));
    if (!s.tasks.length) byId('tasks').textContent = 'No task claims in this project yet.';
    byId('checks').replaceChildren(...s.checks.slice(-6).reverse().map(c => {
      const n = listItem(c.name.toUpperCase(), new Date(c.finishedAt).toLocaleString(), c.status);
      const details = el('details'), summary = el('summary', 'Show findings');
      details.append(summary, el('pre', JSON.stringify(c.result ?? { error: c.error }, null, 2), 'receipt')); n.append(details); return n;
    }));
    if (!s.checks.length) byId('checks').textContent = 'Run a check to record its real outcome.';
    catalogue();
  } catch (error) { byId('connection').textContent = 'Status unavailable'; byId('notice').textContent = error.message; }
}
document.querySelectorAll('[data-check]').forEach(button => button.addEventListener('click', async () => {
  document.querySelectorAll('[data-check]').forEach(n => { n.disabled = true; });
  byId('notice').textContent = `Running ${button.dataset.check.toUpperCase()} check locally…`;
  try {
    const response = await fetch('/api/checks/' + button.dataset.check, { method: 'POST' });
    const receipt = await response.json();
    byId('notice').textContent = response.ok ? 'Check completed. The evidence is saved below.' : `Check needs attention: ${receipt.error ?? 'See the recorded result.'}`;
  } catch (error) { byId('notice').textContent = `Check connection lost: ${error.message}`; }
  finally { document.querySelectorAll('[data-check]').forEach(n => { n.disabled = false; }); await refresh(); }
}));
byId('filter').addEventListener('input', catalogue);
refresh(); setInterval(refresh, 15000);
