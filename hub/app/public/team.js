// Team room page: polls /api/team every 2 s and redraws only what changed.
const $ = id => document.getElementById(id);
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
const time = t => { const d = new Date(t), today = d.toDateString() === new Date().toDateString(); return (today ? '' : d.toLocaleDateString([], { weekday: 'short' }) + ' ') + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: today ? '2-digit' : undefined }); };
const ago = t => { if (!t) return 'never'; const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
const LABEL = { working: 'working', idle: 'idle', out: 'out of usage', standby: 'standby' };
let view = null, selected = null, busy = false;
const colState = new Map(); // column id → { key, pinned }

function notice(text, error = false) { const n = $('notice'); n.textContent = text ?? ''; n.className = error ? 'error' : ''; if (text) setTimeout(() => { if (n.textContent === text) n.textContent = ''; }, 6000); }

async function post(url, body) {
  busy = true;
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error ?? `Request failed (${r.status})`);
    return data;
  } finally { busy = false; }
}

// ---- milestones ----
function renderMilestones() {
  const strip = $('ms-strip'), items = view.milestones;
  if (!items.length) { strip.replaceChildren(el('span', 'No milestones yet. Add the first one below; every model sees the list in shared memory.', 'chip empty')); }
  else strip.replaceChildren(...items.map((m, i) => {
    const b = el('button', `${m.status === 'complete' ? '✓ ' : m.status === 'active' ? '▶ ' : ''}${i + 1}. ${m.title}`, `chip ${m.status}${selected === m.id ? ' selected' : ''}`);
    b.type = 'button'; if (m.notes) b.title = m.notes;
    b.onclick = () => { selected = selected === m.id ? null : m.id; renderMilestones(); };
    return b;
  }));
  const ed = $('ms-editor'), m = items.find(x => x.id === selected);
  if (!m) { ed.hidden = true; return; }
  ed.hidden = false;
  const title = el('input'); title.value = m.title; title.maxLength = 160; title.setAttribute('aria-label', 'Milestone title');
  const notes = el('input'); notes.value = m.notes ?? ''; notes.maxLength = 2000; notes.placeholder = 'Notes for the team (optional)'; notes.setAttribute('aria-label', 'Milestone notes');
  const act = (label, args, cls) => { const b = el('button', label, cls); b.type = 'button'; b.onclick = () => changeMilestones({ id: m.id, ...args }); return b; };
  const save = act('Save', {}, 'secondary'); save.onclick = () => changeMilestones({ action: 'update', id: m.id, title: title.value, notes: notes.value });
  ed.replaceChildren(title, notes, save,
    m.status !== 'active' && m.status !== 'complete' ? act('Make active', { action: 'update', status: 'active' }) : '',
    m.status !== 'complete' ? act('Mark complete ✓', { action: 'update', status: 'complete' }) : act('Reopen', { action: 'update', status: 'planned' }, 'secondary'),
    act('◀', { action: 'move', by: -1 }, 'secondary'), act('▶', { action: 'move', by: 1 }, 'secondary'),
    act('Remove', { action: 'remove' }, 'danger'));
}
async function changeMilestones(args) {
  try {
    const r = await post('/api/team/milestones', args);
    view.milestones = r.milestones;
    if (args.action === 'remove') selected = null;
    renderMilestones();
    notice(r.shared?.published ? 'Saved and shared with every model.' : `Saved. Not yet in shared memory${r.shared?.error ? `: ${r.shared.error}` : ''}.`, !r.shared?.published);
  } catch (e) { notice(e.message, true); }
}
$('ms-add').addEventListener('submit', async e => {
  e.preventDefault();
  const title = $('ms-title').value.trim(); if (!title) return;
  await changeMilestones({ action: 'add', title }); $('ms-title').value = '';
});

// ---- columns ----
function header(c) {
  const head = el('div', null, 'col-head'), title = el('div', null, 'col-title');
  title.append(el('span', c.name), el('span', LABEL[c.status.state] ?? c.status.state, `state ${c.status.state}`));
  const bits = [c.app];
  if (c.role) bits.push(c.role);
  if (c.status.state === 'out') bits.push(c.status.resetsAt ? `${c.status.detail} · back ${new Date(c.status.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : c.status.detail);
  else bits.push(`last activity ${ago(c.lastAt)}`);
  if (c.usage && c.usage.usedPercent != null && c.status.state !== 'out') bits.push(`usage ${Math.round(c.usage.usedPercent)}% (5 h)${c.usage.weeklyPercent != null ? ` · ${Math.round(c.usage.weeklyPercent)}% week` : ''}`);
  if (c.sessions?.length > 1) bits.push(`${c.sessions.length} sessions`);
  head.append(title, el('div', bits.join(' · '), 'col-sub'));
  return head;
}
function footer(c) {
  const f = el('div', null, 'col-foot');
  if (c.kind === 'subscription') {
    f.append(el('span', `Started and stopped in the ${c.id === 'codex' ? 'Codex' : 'Claude'} app.`));
    const b = el('button', c.status.state === 'out' && c.status.detail.startsWith('Marked') ? 'Clear out mark' : 'Mark out of usage', 'secondary'); b.type = 'button';
    b.onclick = async () => { try { await post('/api/team/models', { action: b.textContent.startsWith('Clear') ? 'clear-out' : 'mark-out', column: c.id }); poll(); } catch (e) { notice(e.message, true); } };
    f.append(b);
  } else if (c.shift) {
    const s = c.shift, shiftPost = async action => { try { await post('/api/team/shift', { action }); poll(); } catch (e) { notice(e.message, true); } };
    const line = el('div', null, 'shift-line');
    line.append(el('strong', s.running ? 'Backup shift: working' : s.enabled ? 'Backup shift: on' : 'Backup shift: off'),
      el('span', s.running ? ` · ${s.running.milestone}` : s.enabled ? ` · ${s.decision}` : ' · takes over only when Codex and Claude are both out of usage'));
    f.append(line);
    const toggle = el('button', s.enabled ? 'Turn off' : 'Turn on', s.enabled ? 'secondary' : ''); toggle.type = 'button';
    toggle.onclick = () => shiftPost(s.enabled ? 'off' : 'on');
    f.append(toggle);
    if (s.running) { const stop = el('button', 'Stop', 'danger'); stop.type = 'button'; stop.onclick = () => shiftPost('stop'); f.append(stop); }
    if (s.needsReview?.length) {
      const list = el('div', null, 'review-list');
      list.append(el('strong', `Needs review (${s.needsReview.length}) on ${s.branch}:`));
      for (const r of s.needsReview) list.append(el('div', `${r.commit.slice(0, 7)} · ${r.summary}`));
      f.append(list);
    }
  } else {
    f.append(el('span', c.role === 'backup worker' ? 'Works only when every subscription model is out of usage.' : 'Reviews when asked.'));
    const b = el('button', 'Remove', 'secondary'); b.type = 'button';
    b.onclick = async () => { try { await post('/api/team/models', { action: 'remove', model: c.id.slice(6) }); poll(); } catch (e) { notice(e.message, true); } };
    f.append(b);
  }
  return f;
}
function feed(c, old) {
  const box = el('div', null, 'feed');
  if (!c.events.length) box.append(el('div', c.kind === 'local' ? 'No local work in the last 48 hours. It shows here when the model is asked to help or takes a shift.' : 'Nothing from this model in this project in the last 48 hours. Open the repo folder in its app and it shows up here.', 'empty-feed'));
  for (const e of c.events) {
    const row = el('div', null, `ev ${e.kind}${e.error ? ' error' : ''}`);
    const t = el('span', time(e.t), 't'); t.title = `${new Date(e.t).toLocaleString()} · session ${e.session ?? ''}`;
    row.append(t);
    if (String(e.session ?? '').startsWith('auto·')) { const b = el('span', 'auto', 'auto'); b.title = 'A turn the conductor ran (Design studio)'; row.append(b); }
    row.append(el('span', e.text, 'txt'));
    box.append(row);
  }
  // Follow new activity unless the reader scrolled up to look at something.
  const pinned = old ? old.pinned : true;
  requestAnimationFrame(() => { if (pinned) box.scrollTop = box.scrollHeight; else box.scrollTop = old.scrollTop; });
  box.addEventListener('scroll', () => { const s = colState.get(c.id); if (s) { s.pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 40; s.scrollTop = box.scrollTop; } });
  return box;
}
function renderColumns() {
  const main = $('columns'), keep = new Set();
  for (const c of view.columns) {
    keep.add(c.id);
    const key = JSON.stringify([c.status, c.shift, c.events.length, c.events.at(-1)?.t, c.events.at(-1)?.text, c.usage?.usedPercent, c.sessions?.length, Math.floor(Date.now() / 30000)]);
    let node = main.querySelector(`[data-col="${CSS.escape(c.id)}"]`);
    const old = colState.get(c.id);
    if (node && old?.key === key) continue;
    const fresh = el('article', null, 'col'); fresh.dataset.col = c.id;
    fresh.append(header(c), feed(c, old), footer(c));
    colState.set(c.id, { key, pinned: old?.pinned ?? true, scrollTop: old?.scrollTop ?? 0 });
    if (node) node.replaceWith(fresh); else main.append(fresh);
  }
  for (const node of [...main.children]) if (!keep.has(node.dataset.col)) node.remove();
}

// ---- plug in ----
function renderPlug() {
  $('servers').textContent = view.connect.servers.join(', ');
  $('repo-path').textContent = view.connect.repo;
  const list = $('local-list'), on = new Set(view.roster.local.map(m => m.model));
  if (!view.installedLocal) { list.replaceChildren(el('div', 'Ollama is not answering on this PC right now, so installed models are unknown.', 'muted')); return; }
  const rows = view.installedLocal.map(name => {
    const row = el('div', null, 'local-row'); row.append(el('span', name));
    if (on.has(name)) { row.append(el('small', 'on the team', 'muted')); return row; }
    const role = el('select'); for (const r of ['backup worker', 'reviewer']) role.append(new Option(r, r));
    const add = el('button', 'Add', 'secondary'); add.type = 'button';
    add.onclick = async () => { try { await post('/api/team/models', { action: 'add', model: name, role: role.value }); notice(`${name} joined the team as ${role.value}.`); poll(); } catch (e) { notice(e.message, true); } };
    row.append(role, add); return row;
  });
  list.replaceChildren(...(rows.length ? rows : [el('div', 'No models installed in Ollama.', 'muted')]));
}
$('copy-path').onclick = async () => { try { await navigator.clipboard.writeText(view.connect.repo); notice('Folder path copied.'); } catch { notice('Copy failed; select the path and copy it.', true); } };

// ---- loop ----
async function poll() {
  if (busy) return;
  try {
    const r = await fetch('/api/team', { cache: 'no-store' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Status ${r.status}`);
    const next = await r.json();
    const msChanged = !view || JSON.stringify(view.milestones) !== JSON.stringify(next.milestones);
    view = next;
    if (msChanged && !document.activeElement?.closest?.('#ms-editor')) renderMilestones();
    renderColumns();
    if (!document.activeElement?.closest?.('#plug')) renderPlug();
    $('live').className = 'live ok'; $('live-text').textContent = `Live · updated ${time(Date.parse(next.observedAt))}`;
  } catch (e) { $('live').className = 'live bad'; $('live-text').textContent = `Not updating: ${e.message}`; }
}
poll(); setInterval(poll, 2000);
