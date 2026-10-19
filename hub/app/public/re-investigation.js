(() => {
  'use strict';

  const host = document.getElementById('analysis');
  if (!host || document.getElementById('re-investigation')) return;

  // The selected game's adapter owns the workflow; no executable paths come from the UI.
  const TARGET = Object.freeze({ id: 'satisfactory', name: 'Satisfactory' });
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const POLL_LIMIT = 600;
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const plain = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
  const validId = value => typeof value === 'string' && UUID.test(value);
  const button = (text, className = 'secondary') => {
    const node = make('button', text, className);
    node.type = 'button';
    return node;
  };

  const panel = make('section', null, 're-investigation');
  panel.id = 're-investigation';
  panel.setAttribute('aria-labelledby', 're-investigation-title');
  const heading = make('div', null, 're-investigation-heading');
  const title = make('div');
  const h3 = make('h3', `Investigate ${TARGET.name}`);
  h3.id = 're-investigation-title';
  title.append(make('div', 'GAME REVERSE ENGINEERING', 'eyebrow'), h3);
  const badge = make('span', 'Reading saved progress…', 're-investigation-badge');
  badge.setAttribute('role', 'status');
  heading.append(title, badge);
  const description = make('p', 'Investigate the selected game through its project adapter, retain evidence, and record findings and missing capabilities. Each run is a finite investigation pass; its coverage and unresolved questions stay visible.', 're-investigation-description');
  const billing = make('p', 'This button can use hosted API credits under your reverse-engineering authorization. In-game Ollama remains a separate local feature. Opening this page and checking progress do not prompt a model.', 're-investigation-billing');
  const actions = make('div', null, 're-investigation-actions');
  const start = button('Reverse engineer this game', 're-investigation-start');
  const stop = button('Stop investigation');
  const refresh = button('Check progress');
  actions.append(start, stop, refresh);
  const announcement = make('p', '', 're-investigation-announcement');
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', 'polite');
  const requestError = make('p', '', 're-investigation-request-error');
  requestError.setAttribute('role', 'alert');
  requestError.hidden = true;
  const evidence = make('div', null, 're-investigation-evidence');
  evidence.id = 're-investigation-evidence';
  evidence.setAttribute('aria-label', 'Saved investigation progress and evidence');
  panel.append(heading, description, billing, actions, announcement, requestError, evidence);
  host.prepend(panel);
  // Keep the requested action beside the existing native decompiler control.
  const nativeButton=host.querySelector('[data-check="native"]');
  if(nativeButton)nativeButton.insertAdjacentElement('afterend',start);

  let latest = null;
  let statusKnown = false;
  let active = false;
  let activeId = null;
  let actionPending = false;
  let cancelPending = false;
  let statusRequest = null;
  let timer = null;
  let readsLeft = 0;
  let consecutiveFailures = 0;

  function controls() {
    start.disabled = !statusKnown || active || actionPending;
    stop.disabled = !active || !activeId || actionPending || cancelPending;
    stop.textContent = cancelPending ? 'Requesting stop…' : 'Stop investigation';
    refresh.disabled = Boolean(statusRequest) || actionPending;
    panel.setAttribute('aria-busy', String(actionPending));
  }
  function showRequestError(message) {
    requestError.textContent = message;
    requestError.hidden = !message;
  }
  function detailBlock(label, value, emptyText = 'Not reported yet.') {
    const block = make('div', null, 're-investigation-detail');
    block.append(make('h4', label));
    if (value == null) block.append(make('p', emptyText, 'muted'));
    else if (Array.isArray(value)) {
      if (!value.length) block.append(make('p', 'None reported in this pass.', 'muted'));
      else {
        const list = make('ul');
        value.forEach(item => list.append(make('li', plain(item))));
        block.append(list);
      }
    } else block.append(make('pre', plain(value)));
    return block;
  }
  function renderStages(value) {
    const block = make('div', null, 're-investigation-stages');
    block.append(make('h4', 'Stages'));
    const entries = Array.isArray(value) ? value.map((stage, index) => [String(index + 1), stage])
      : value && typeof value === 'object' ? Object.entries(value) : [];
    if (!entries.length) {
      block.append(make('p', value ? plain(value) : 'Stage details have not been reported yet.', 'muted'));
      return block;
    }
    const list = make('ol');
    entries.forEach(([key, stage]) => {
      const item = make('li');
      if (!stage || typeof stage !== 'object') item.append(make('span', `${key}: ${plain(stage)}`));
      else {
        const name = stage.title ?? stage.label ?? stage.name ?? stage.stage ?? stage.id ?? key;
        const state = stage.status ?? stage.state;
        item.append(make('strong', `${plain(name)}${state ? ` · ${plain(state)}` : ''}`));
        const result = stage.result;
        const model = stage.actualModel ?? result?.actualModel ?? result?.model ?? stage.model;
        if (model) item.append(make('span', `Recorded model: ${plain(model)}`, 're-investigation-model'));
        const details = make('details');
        details.append(make('summary', 'Saved stage evidence'), make('pre', plain(stage)));
        item.append(details);
      }
      list.append(item);
    });
    block.append(list);
    return block;
  }
  function render() {
    evidence.replaceChildren();
    const labels = {
      idle: 'No investigation running', running: 'Investigation in progress', cancelling: 'Cancellation requested',
      partial: 'Pass finished · partial coverage', blocked: 'Investigation blocked', failed: 'Investigation failed',
      cancelled: 'Investigation cancelled', interrupted: 'Investigation interrupted'
    };
    const status = latest?.status ?? 'idle';
    badge.textContent = labels[status] ?? `Reported status: ${plain(status)}`;
    badge.classList.toggle('re-investigation-attention', ['blocked', 'failed', 'interrupted'].includes(status));
    if (!latest || status === 'idle') {
      evidence.append(make('p', 'No saved investigation pass is available. Use the button above to start one for Satisfactory.', 'muted'));
      controls();
      return;
    }
    const summary = make('div', null, 're-investigation-summary');
    summary.append(make('span', `Target: ${plain(latest.targetId ?? TARGET.id)}`));
    summary.append(make('span', `Current stage: ${plain(latest.stage) || 'Not reported'}`));
    summary.append(make('span', latest.passCompleted === true ? 'Finite pass: finished' : 'Finite pass: not reported complete'));
    summary.append(make('span', 'Whole-game reverse engineering: not established by this pass.'));
    evidence.append(summary);
    if (latest.id) evidence.append(make('p', `Run: ${plain(latest.id)}`, 're-investigation-run-id'));
    const started = latest.startedAt ?? latest.createdAt;
    const dates = [started ? `Started: ${plain(started)}` : '',
      latest.updatedAt ? `Updated: ${plain(latest.updatedAt)}` : '',
      latest.finishedAt ? `Finished: ${plain(latest.finishedAt)}` : ''].filter(Boolean);
    if (dates.length) evidence.append(make('p', dates.join(' · '), 'muted'));
    if (latest.error != null || latest.lastError != null) {
      const error = detailBlock('Recorded error', latest.error ?? latest.lastError);
      error.classList.add('re-investigation-run-error');
      evidence.append(error);
    }
    const goals = latest.goals ?? latest.goal ?? latest.originalGoal;
    if (goals != null) evidence.append(detailBlock('Investigation goals', goals));
    evidence.append(detailBlock('Coverage', latest.coverage), renderStages(latest.stages));
    if (latest.latestProgress != null) evidence.append(detailBlock('Latest recorded progress', latest.latestProgress));
    const results = {};
    for (const key of ['results', 'modelResults', 'models', 'modelParticipation', 'participants', 'participation']) {
      if (latest[key] != null) results[key] = latest[key];
    }
    if (Object.keys(results).length) {
      evidence.append(detailBlock('Recorded model results and participation', results));
      evidence.append(make('p', 'These are saved model reports. Current model activity is established by the active run, not by a dated report.', 'muted'));
    }
    const columns = make('div', null, 're-investigation-columns');
    columns.append(detailBlock('Findings', latest.findings), detailBlock('Unknowns', latest.unknowns),
      detailBlock('Missing capabilities', latest.capabilitiesMissing ?? latest.coverage?.capabilitiesMissing),
      detailBlock('Disagreements', latest.disagreements ?? latest.coverage?.reviewDisagreements));
    evidence.append(columns);
    if (latest.blockers != null) evidence.append(detailBlock('Recorded blockers', latest.blockers));
    if (Array.isArray(latest.warnings) && latest.warnings.length) evidence.append(detailBlock('Status warnings', latest.warnings));
    const evidencePath = latest.evidenceFile ?? latest.evidencePath ?? latest.reportPath;
    if (evidencePath) {
      const pointer = make('div', null, 're-investigation-pointer');
      pointer.append(make('strong', 'Saved evidence'), make('code', plain(evidencePath)));
      evidence.append(pointer);
    }
    controls();
  }
  function applySnapshot(snapshot) {
    if (snapshot !== null && (typeof snapshot !== 'object' || Array.isArray(snapshot) || typeof snapshot.status !== 'string')) {
      throw new Error('Investigation status has an unexpected format.');
    }
    latest = snapshot;
    statusKnown = true;
    activeId = [snapshot?.activeRunId, snapshot?.id].find(validId) || null;
    active = Boolean(snapshot?.busy === true || validId(snapshot?.activeRunId)
      || ['running', 'cancelling'].includes(snapshot?.status));
    render();
  }
  async function request(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(path, {
        method, cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
      });
      let data;
      try { data = await response.json(); }
      catch { throw new Error(`Investigation returned an unreadable response (HTTP ${response.status}).`); }
      if (!response.ok) throw new Error(plain(data?.error?.message ?? data?.error) || `Investigation request failed (HTTP ${response.status}).`);
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The investigation service did not respond within 15 seconds.');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function clearPoll() {
    if (timer) clearTimeout(timer);
    timer = null;
  }
  function schedulePoll() {
    clearPoll();
    if (!active || document.hidden || readsLeft <= 0 || consecutiveFailures >= 3) return;
    timer = setTimeout(async () => {
      readsLeft -= 1;
      await readStatus();
      if (active && readsLeft <= 0) announcement.textContent = 'Automatic progress checks paused after 30 minutes. Check progress to continue reading this run.';
      if (active && consecutiveFailures >= 3) announcement.textContent = 'Automatic progress checks paused after three connection failures. The last saved evidence remains visible; use Check progress to reconnect.';
      schedulePoll();
    }, 3000);
  }
  function beginPolling() {
    readsLeft = POLL_LIMIT;
    consecutiveFailures = 0;
    schedulePoll();
  }
  async function readStatus() {
    if (statusRequest) return statusRequest;
    statusRequest = (async () => {
      try {
        const snapshot = await request('/api/re-investigation/status');
        applySnapshot(snapshot);
        consecutiveFailures = 0;
        showRequestError('');
        if (!active) clearPoll();
      } catch (error) {
        statusKnown = false;
        consecutiveFailures += 1;
        showRequestError(`Could not read investigation progress: ${error.message}`);
        if (!latest) badge.textContent = 'Investigation status unavailable';
      } finally {
        statusRequest = null;
        controls();
      }
    })();
    controls();
    return statusRequest;
  }

  start.addEventListener('click', async () => {
    if (!statusKnown || active || actionPending) return;
    actionPending = true;
    showRequestError('');
    announcement.textContent = 'Requesting a new investigation pass…';
    controls();
    try {
      applySnapshot(await request('/api/re-investigation/start', { method: 'POST', body: { targetId: TARGET.id } }));
      announcement.textContent = active ? 'Investigation started. Progress and evidence will update below.' : 'The investigation request returned its recorded outcome below.';
      if (active) beginPolling();
    } catch (error) {
      await readStatus();
      if (active) beginPolling();
      showRequestError(`The start request could not be confirmed: ${error.message} Read the current status before starting again; this request was not replayed.`);
    } finally {
      actionPending = false;
      controls();
    }
  });
  stop.addEventListener('click', async () => {
    if (!active || !activeId || actionPending || cancelPending) return;
    actionPending = true;
    cancelPending = true;
    showRequestError('');
    announcement.textContent = 'Requesting cancellation of the active investigation…';
    controls();
    try {
      const result = await request('/api/re-investigation/cancel', { method: 'POST', body: { id: activeId } });
      if (result && typeof result.status === 'string') applySnapshot(result);
      else await readStatus();
      announcement.textContent = active ? 'Cancellation requested. Waiting for the recorded stopping outcome.' : 'The latest recorded investigation outcome is shown below.';
      if (active) beginPolling();
    } catch (error) {
      showRequestError(`Could not confirm cancellation: ${error.message} Use Check progress to read the active run.`);
    } finally {
      actionPending = false;
      cancelPending = false;
      controls();
    }
  });
  refresh.addEventListener('click', async () => {
    await readStatus();
    if (active) beginPolling();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearPoll();
    else if (active && readsLeft > 0 && consecutiveFailures < 3) { void readStatus(); schedulePoll(); }
  });
  window.addEventListener('pagehide', clearPoll);

  controls();
  // A reload only reads durable status. It never starts or resumes model work.
  void readStatus().then(() => { if (active) beginPolling(); });
})();
