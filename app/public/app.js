const byId = id => document.getElementById(id);
const el = (tag, text, className) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; };
let current;
function card(title, value, detail) { const n = el('article', null, 'card'); n.append(el('h3', title), el('div', value, 'value'), el('p', detail)); return n; }
function listItem(title, detail, tag) { const n = el('div', null, 'item'); if (tag) n.append(el('span', tag, 'tag')); n.append(el('strong', title), el('small', detail)); return n; }
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
