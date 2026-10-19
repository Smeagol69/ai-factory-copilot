// Design studio page: polls the studio API every 3 s and redraws what changed.
const $ = id => document.getElementById(id);
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
const NAME = { codex: 'Codex', claude: 'Claude', owner: 'You', studio: 'Studio' };
const STATUS = { designing: 'designing', 'needs-owner': 'needs you', agreed: 'agreed', building: 'building', done: 'done', stopped: 'stopped' };
let overview = null, selected = null, jobKey = '';

function notice(text, error = false) { const n = $('notice'); n.textContent = text ?? ''; n.className = error ? 'error' : ''; if (text) setTimeout(() => { if (n.textContent === text) n.textContent = ''; }, 6000); }
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({})); if (!r.ok) throw new Error(data.error ?? `Request failed (${r.status})`); return data;
}
const act = async (url, body, ok) => { try { await post(url, body); if (ok) notice(ok); poll(); } catch (e) { notice(e.message, true); } };

function renderControls() {
  const c = overview.conductor, on = c.enabled;
  $('cond-state').textContent = c.running ? 'working' : on ? 'on' : 'off';
  $('cond-state').className = `state ${c.running ? 'working' : on ? 'standby' : 'idle'}`;
  $('cond-detail').textContent = c.running ? `${NAME[c.running.worker]}: ${c.running.kind}${c.running.candidate ? ` (candidate ${c.running.candidate})` : ''}${c.running.message ? ` (answering message #${c.running.message})` : ''} since ${new Date(c.running.startedAt).toLocaleTimeString()}`
    : c.waiting ? c.waiting.reason : on ? 'Waiting: no design open and no milestone step due' : 'Off: designs wait until you turn it on';
  $('cond-toggle').textContent = on ? 'Turn off' : 'Turn on';
  const l = overview.gameLease;
  $('op-state').textContent = (overview.conductorMayOperateGame ? 'conductor may operate' : 'Codex session operates') + (l ? l.unresolved ? ` · UNRESOLVED game transaction (${l.worker}): ${l.unresolvedReason}` : ` · leased to ${l.worker} (${l.purpose}) until ${new Date(l.expiresAt).toLocaleTimeString()}` : '');
  $('op-resolve').hidden = !l?.unresolved;
  $('op-toggle').textContent = overview.conductorMayOperateGame ? 'Take game control back' : 'Hand game to conductor';
  $('workers').replaceChildren(...['codex', 'claude'].map(n => { const w = overview.workers[n] ?? {}; const u = w.usage;
    return el('div', `${NAME[n]}: ${w.running ? (w.busy ? 'in a turn' : 'ready') : 'not started'}${u?.usedPercent != null ? ` · ${Math.round(u.usedPercent)}% used` : ''}${u?.out ? ' · out of usage' : ''}`); }));
}
function renderMilestoneWork() {
  const box = $('mwork'), w = overview.milestoneWork, pending = overview.teamPending ?? [];
  if (!w && !pending.length) { box.replaceChildren(); return; }
  const parts = [];
  if (w) {
    const next = w.next ? (w.next.worker === 'hub' ? 'Next: the hub adds the approved step to team/auto' : `Next: ${NAME[w.next.worker]} — ${w.next.kind}${w.next.step ? ` step ${w.next.step}` : ''}${w.next.fixing ? ` (fixing step ${w.next.fixing})` : ''}`) : '';
    parts.push(el('h3', `Milestone work: ${w.milestone.title}`), el('div', `${w.status}${next ? ' · ' + next : ''} · Codex and Claude take turns building and reviewing; approved steps go to team/auto`, 'muted'));
    const steps = el('div', null, 'steps');
    for (const s of [...w.steps].reverse().slice(0, 8)) {
      const line = el('div', null, 'stepline');
      line.append(el('strong', `Step ${s.n} · ${NAME[s.author]} · ${s.commit.slice(0, 7)} `), el('span', s.summary.slice(0, 220)));
      if (s.review) line.append(el('div', `${NAME[s.review.author]}: ${s.review.verdict === 'approve' ? 'approved' : 'changes requested'} — ${s.review.text.slice(0, 200)}`, s.review.verdict === 'approve' ? 'ok' : 'chg'));
      if (s.merged) line.append(el('div', s.merged.error ? `Not merged: ${s.merged.error}` : 'On team/auto', s.merged.error ? 'err' : 'ok'));
      steps.append(line);
    }
    parts.push(steps);
  }
  const row = el('div', null, 'row');
  row.append(el('span', pending.length ? `${pending.length} reviewed step${pending.length === 1 ? '' : 's'} on team/auto, not in master yet` : 'team/auto has nothing new for master', 'muted'));
  if (pending.length) { const m = el('button', 'Merge team work into master'); m.type = 'button'; m.title = pending.join(String.fromCharCode(10));
    m.onclick = () => { if (confirm('Merge these reviewed steps into master?' + String.fromCharCode(10, 10) + pending.join(String.fromCharCode(10)))) act('/api/studio/team-merge', {}, 'Team work merged into master.'); }; row.append(m); }
  if (w && w.status === 'working') { const s = el('button', 'Stop milestone work', 'danger'); s.type = 'button'; s.onclick = () => act('/api/studio/milestone-work', { action: 'stop' }, 'Milestone work stopped.'); row.append(s); }
  if (w && ['needs-owner', 'stopped'].includes(w.status)) { const r = el('button', 'Resume milestone work', 'secondary'); r.type = 'button'; r.onclick = () => act('/api/studio/milestone-work', { action: 'resume' }, 'Milestone work resumes.'); row.append(r); }
  parts.push(row);
  box.replaceChildren(...parts);
}
function renderJobs() {
  const list = $('jobs');
  if (!overview.jobs.length) { list.replaceChildren(el('p', 'No designs yet.', 'muted')); return; }
  list.replaceChildren(...overview.jobs.map(j => { const b = el('button', null, `item${j.id === selected ? ' selected' : ''}`); b.type = 'button';
    b.append(el('span', j.brief.length > 80 ? j.brief.slice(0, 79) + '…' : j.brief), el('small', `${STATUS[j.status] ?? j.status} · ${j.candidates} candidate${j.candidates === 1 ? '' : 's'}`));
    b.onclick = () => { selected = j.id; jobKey = ''; renderJobs(); loadJob(); }; return b; }));
}
async function loadJob() {
  if (!selected) return;
  const r = await fetch(`/api/studio/jobs/${selected}`, { cache: 'no-store' }); if (!r.ok) return;
  const job = await r.json(), key = JSON.stringify([job.status, job.candidates.length, job.critiques.length, job.events.length, job.candidates.map(c => c.render)]);
  if (key === jobKey) return; jobKey = key;
  const box = $('job'), head = el('div');
  const pill = el('span', STATUS[job.status] ?? job.status, `status-pill ${job.status}`);
  const h = el('h2'); h.append(el('span', job.brief + ' '), pill);
  const next = job.next ? `Next: ${NAME[job.next.worker]} — ${job.next.kind}${job.next.candidate ? ` (candidate ${job.next.candidate})` : ''}` : job.status === 'needs-owner' ? 'Waiting for you: pick a candidate or add a note' : '';
  const STAGES = ['proposed', 'agreed', 'saved', 'placed', 'verified'], at = STAGES.indexOf(job.stage);
  const stages = el('div', null, 'stages'); for (const [i, s] of STAGES.entries()) stages.append(el('span', s, `stage${i <= at ? ' reached' : ''}${i === at ? ' now' : ''}`));
  head.append(h, stages, el('div', `Started ${new Date(job.createdAt).toLocaleString()} · first designer ${NAME[job.firstDesigner]}${next ? ` · ${next}` : ''}${job.agreedHash ? ` · agreed piece list ${job.agreedHash.slice(0, 19)}…` : ''}`, 'meta'));
  const actions = el('div', null, 'actions'), note = el('input'); note.placeholder = 'Note for both models (they see it next turn)'; note.maxLength = 2000; note.setAttribute('aria-label', 'Note for both models');
  const send = el('button', 'Add note', 'secondary'); send.type = 'button'; send.onclick = () => note.value.trim() && act(`/api/studio/jobs/${job.id}`, { action: 'note', text: note.value }, 'Note added.');
  const stop = el('button', 'Stop this design', 'danger'); stop.type = 'button'; stop.onclick = () => act(`/api/studio/jobs/${job.id}`, { action: 'stop' }, 'Design stopped.');
  actions.append(note, send, ...(['done', 'stopped'].includes(job.status) ? [] : [stop]));
  const cands = el('div', null, 'cands');
  for (const c of [...job.candidates].reverse()) {
    const card = el('article', null, `cand${job.agreedCandidate === c.n ? ' agreed' : ''}`);
    card.append(el('h3', `Candidate ${c.n}: ${c.title}${job.agreedCandidate === c.n ? '  ✓ agreed' : ''}`), el('div', `by ${NAME[c.author]} · ${c.pieces} pieces · ${new Date(c.at).toLocaleTimeString()}`, 'by'), el('p', c.rationale));
    if (c.renderUrl) { const img = el('img'); img.src = c.renderUrl; img.alt = `Render of candidate ${c.n}`; img.onclick = () => img.classList.toggle('big'); card.append(img); }
    else card.append(el('p', 'Render not available.', 'muted'));
    for (const k of job.critiques.filter(x => x.candidate === c.n)) { const d = el('div', null, 'crit'); d.append(el('span', `${NAME[k.author]}: ${k.verdict === 'agree' ? 'agree' : 'revise'} `, `v ${k.verdict}`), el('span', k.text)); card.append(d); }
    if (['designing', 'needs-owner'].includes(job.status)) { const pick = el('button', 'Pick this one', 'secondary'); pick.type = 'button'; pick.onclick = () => act(`/api/studio/jobs/${job.id}`, { action: 'pick', candidate: c.n }, `Candidate ${c.n} picked; building next.`); card.append(pick); }
    cands.append(card);
  }
  if (job.build) { const b = el('article', null, 'cand'); b.append(el('h3', `Build${job.build.blueprint_name ? `: ${job.build.blueprint_name}` : ''}`), el('p', job.build.summary));
    for (const k of job.critiques.filter(x => x.candidate === 'build')) { const d = el('div', null, 'crit'); d.append(el('span', `${NAME[k.author]}: ${k.verdict} `, `v ${k.verdict}`), el('span', k.text)); b.append(d); }
    cands.prepend(b); }
  const tl = el('div', null, 'timeline'); for (const e of [...job.events].reverse()) tl.append(el('div', `${new Date(e.t).toLocaleTimeString()} · ${NAME[e.who] ?? e.who}: ${e.text}`));
  box.replaceChildren(head, actions, cands, el('h3', 'Timeline'), tl);
}

$('brief-form').addEventListener('submit', async e => {
  e.preventDefault(); const brief = $('brief').value.trim(); if (!brief) return;
  try { const job = await post('/api/studio/jobs', { brief, firstDesigner: $('first').value }); selected = job.id; jobKey = ''; $('brief').value = '';
    notice(overview?.conductor.enabled ? 'Design started; the conductor hands it to the first designer.' : 'Design saved. Turn the conductor on to start it.'); poll(); }
  catch (err) { notice(err.message, true); }
});
$('cond-toggle').onclick = () => act('/api/studio/conductor', { action: overview?.conductor.enabled ? 'off' : 'on' });
$('cond-stop').onclick = () => act('/api/studio/conductor', { action: 'stop' }, 'Conductor stopped; the running turn was ended.');
$('op-resolve').onclick = () => { if (confirm('Did you check the game? Resolving clears the unresolved transaction; nothing is replayed.')) act('/api/studio/conductor', { action: 'resolve-game' }, 'Game transaction resolved.'); };
$('op-toggle').onclick = () => act('/api/studio/operator', { conductor: !overview?.conductorMayOperateGame });

async function poll() {
  try {
    const r = await fetch('/api/studio', { cache: 'no-store' }); if (!r.ok) throw new Error(`Status ${r.status}`);
    overview = await r.json();
    if (!selected && overview.jobs[0]) selected = overview.jobs[0].id;
    renderControls(); renderMilestoneWork(); renderJobs(); await loadJob();
    $('live').className = 'live ok'; $('live-text').textContent = `Live · ${new Date().toLocaleTimeString()}`;
  } catch (e) { $('live').className = 'live bad'; $('live-text').textContent = `Not updating: ${e.message}`; }
}
poll(); setInterval(poll, 3000);
