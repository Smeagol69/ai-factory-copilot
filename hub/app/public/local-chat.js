(() => {
  'use strict';

  // This module reads local status on load. Only submitting the form starts inference.
  const team = document.getElementById('team');
  if (!team || document.getElementById('local-chat')) return;

  const MAX_INPUT = 6000;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const STORAGE_KEY = 'satisfactory-mcp-lab.local-chat';
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

  const section = make('section', null, 'panel');
  section.id = 'local-chat';
  section.setAttribute('aria-labelledby', 'local-chat-title');
  const heading = make('div', null, 'section-heading');
  const title = make('div');
  const h2 = make('h2', 'Chat with HauhauCS');
  h2.id = 'local-chat-title';
  title.append(make('div', 'DIRECT LOCAL CONVERSATION', 'eyebrow'), h2);
  const modelStatus = make('div', 'Checking local model…', 'local-chat-model');
  modelStatus.setAttribute('role', 'status');
  heading.append(title, modelStatus);
  section.append(heading, make('p', 'Local inference · no API credits. Shared project and MCP context; game changes still require authoritative game validation.', 'muted local-chat-context'));

  const toolbar = make('div', null, 'local-chat-toolbar');
  const savedLabel = make('label', 'Saved conversations', 'local-chat-saved');
  const select = make('select');
  select.id = 'local-chat-conversation';
  savedLabel.htmlFor = select.id;
  savedLabel.append(select);
  const newChat = button('New chat');
  const checkStatus = button('Check status');
  toolbar.append(savedLabel, newChat, checkStatus);
  const transcript = make('div', null, 'local-chat-transcript');
  transcript.id = 'local-chat-messages';
  transcript.setAttribute('role', 'log');
  transcript.setAttribute('aria-label', 'Conversation with HauhauCS and MCP evidence');
  transcript.setAttribute('aria-live', 'polite');
  transcript.setAttribute('aria-relevant', 'additions');
  transcript.tabIndex = 0;
  const activity = make('p', '', 'local-chat-activity');
  activity.setAttribute('role', 'status');
  activity.setAttribute('aria-live', 'polite');
  const errorBox = make('p', '', 'local-chat-error');
  errorBox.setAttribute('role', 'alert');
  errorBox.hidden = true;
  const form = make('form', null, 'local-chat-compose');
  const inputLabel = make('label', 'Message HauhauCS');
  const input = make('textarea');
  input.id = 'local-chat-input';
  inputLabel.htmlFor = input.id;
  input.rows = 4;
  input.maxLength = MAX_INPUT;
  input.placeholder = 'Ask about this project, inspect evidence, or work through an idea…';
  input.setAttribute('aria-describedby', 'local-chat-hint local-chat-count');
  const composeFooter = make('div', null, 'local-chat-compose-footer');
  const hint = make('span', 'Ctrl / ⌘ + Enter to send. Enter adds a new line.', 'muted');
  hint.id = 'local-chat-hint';
  const count = make('span', `0 / ${MAX_INPUT}`, 'local-chat-count');
  count.id = 'local-chat-count';
  const actions = make('div', null, 'local-chat-actions');
  const stop = button('Stop');
  const send = make('button', 'Send');
  send.type = 'submit';
  actions.append(stop, send);
  composeFooter.append(hint, count, actions);
  form.append(inputLabel, input, composeFooter);
  section.append(toolbar, transcript, activity, errorBox, form);
  team.insertAdjacentElement('afterend', section);
  const nav = document.querySelector('aside nav');
  if (nav && !nav.querySelector('a[href="#local-chat"]')) {
    const anchor = make('a', 'Chat with HauhauCS');
    anchor.href = '#local-chat';
    nav.append(anchor);
  }

  let conversationId = null;
  let messages = [];
  let conversations = [];
  let sending = false;
  let loading = false;
  let cancelling = false;
  let statusKnown = false;
  let installed = false;
  let activeId = null;
  let remoteBusy = false;
  let statusRequest = null;
  let pollTimer = null;
  let pollsRemaining = 0;
  let loadVersion = 0;
  let pendingMessage = null;

  const showError = message => {
    errorBox.textContent = message;
    errorBox.hidden = !message;
  };
  const outcomeError = record => {
    const labels = {
      failed: 'The last local response failed.',
      cancelled: 'The last local response was cancelled.',
      interrupted: 'The previous local response was interrupted.'
    };
    const label = labels[record.status];
    if (!label && !record.lastError) return '';
    const detail = plain(record.lastError?.message);
    const outcome = record.lastError?.outcome === 'unknown'
      ? 'Its outcome is unknown. Check saved tool evidence before retrying; the request was not replayed.'
      : record.lastError?.outcome === 'not_started' ? 'Inference did not start.' : '';
    return [label || 'The saved request needs attention.', detail, outcome].filter(Boolean).join(' ');
  };
  const remember = id => {
    try {
      if (id) localStorage.setItem(STORAGE_KEY, id);
      else localStorage.removeItem(STORAGE_KEY);
    } catch { /* Saved server conversations remain usable without browser storage. */ }
  };
  function controls() {
    const busy = sending || remoteBusy;
    select.disabled = loading || sending;
    newChat.disabled = loading || sending;
    input.disabled = loading || sending;
    send.disabled = loading || busy || !statusKnown || !installed || !input.value.trim();
    stop.disabled = cancelling || !activeId || !busy;
    stop.textContent = cancelling ? 'Stopping…' : 'Stop';
    form.setAttribute('aria-busy', String(sending));
    count.textContent = `${input.value.length} / ${MAX_INPUT}`;
  }
  function renderOptions() {
    const blank = make('option', 'New conversation');
    blank.value = '';
    const options = conversations.filter(c => validId(c.id)).map(c => {
      const terminal = ['failed', 'cancelled', 'interrupted'].includes(c.status) ? ` · ${c.status}` : '';
      const option = make('option', `${c.title || 'Untitled conversation'}${terminal}`);
      option.value = c.id;
      const date = new Date(c.updatedAt);
      if (Number.isFinite(date.getTime())) option.title = `Updated ${date.toLocaleString()}`;
      return option;
    });
    if (conversationId && !options.some(o => o.value === conversationId)) {
      const currentOption = make('option', 'Current conversation');
      currentOption.value = conversationId;
      options.unshift(currentOption);
    }
    select.replaceChildren(blank, ...options);
    select.value = conversationId || '';
    controls();
  }
  function messageNode(message, pending = false) {
    const role = ['user', 'assistant', 'tool', 'system'].includes(message.role) ? message.role : 'evidence';
    const node = make('article', null, `local-chat-message local-chat-${role}${pending ? ' local-chat-pending' : ''}`);
    const labels = { user: 'You', assistant: 'HauhauCS', tool: 'MCP tool evidence', system: 'Project context', evidence: 'Evidence' };
    node.append(make('div', `${labels[role]}${pending ? ' · sending' : ''}`, 'local-chat-message-label'));
    if (message.content != null && message.content !== '') node.append(make('div', plain(message.content), 'local-chat-message-content'));
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const detail = make('details', null, 'local-chat-tool-calls');
      detail.append(make('summary', 'MCP tool requests'), make('pre', plain(message.tool_calls)));
      node.append(detail);
    }
    return node;
  }
  function renderMessages() {
    const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100;
    const nodes = messages.map(m => messageNode(m));
    if (pendingMessage) nodes.push(messageNode({ role: 'user', content: pendingMessage }, true));
    if (!nodes.length) {
      const empty = make('div', null, 'local-chat-empty');
      empty.append(make('strong', 'A direct line to your local model.'), make('p', 'Start a conversation or reopen a saved one. Reading status and conversation history does not run the model.', 'muted'));
      nodes.push(empty);
    }
    transcript.replaceChildren(...nodes);
    if (nearBottom || pendingMessage) transcript.scrollTop = transcript.scrollHeight;
  }
  async function request(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    // Inference has its own server-side bound. Stop must use the cancellation endpoint.
    const timeout = method === 'GET' || path.endsWith('/cancel')
      ? setTimeout(() => controller.abort(), 15000) : null;
    try {
      const response = await fetch(path, {
        method, cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
      });
      let data;
      try { data = await response.json(); }
      catch { throw new Error(`Local chat returned an unreadable response (HTTP ${response.status}).`); }
      if (!response.ok || data.error) {
        const error = new Error(plain(data.error?.message ?? data.error) || `Local chat request failed (HTTP ${response.status}).`);
        error.status = response.status;
        error.conversationId = data.conversationId;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Local chat did not respond within 15 seconds. Check status and try again.');
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  function clearPoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }
  function schedulePoll() {
    clearPoll();
    if ((!sending && !remoteBusy) || pollsRemaining <= 0 || document.hidden) return;
    pollTimer = setTimeout(async () => {
      pollsRemaining -= 1;
      await refreshStatus();
      schedulePoll();
    }, 5000);
  }
  function beginPolling() {
    pollsRemaining = 120;
    schedulePoll();
  }
  async function refreshStatus() {
    if (statusRequest) return statusRequest;
    checkStatus.disabled = true;
    statusRequest = (async () => {
      try {
        const result = await request('/api/local-chat/status');
        const previousActiveId = activeId;
        const wasBusy = remoteBusy;
        statusKnown = true;
        installed = result.installed === true;
        const active = result.active;
        activeId = [active?.conversationId, result.activeConversationId, typeof active === 'string' ? active : null].find(validId) || null;
        remoteBusy = Boolean(result.busy === true || activeId || active || result.status === 'busy' || result.status === 'running');
        const model = plain(result.model) || 'HauhauCS';
        const state = remoteBusy ? 'In progress' : !installed ? 'Model not installed' : plain(result.status) || 'Installed';
        modelStatus.textContent = `${model} · ${state}`;
        modelStatus.classList.toggle('local-chat-unavailable', !installed);
        if (!sending) activity.textContent = remoteBusy
          ? 'A local conversation is running. Stop cancels that active run.'
          : installed ? 'Only Send starts a local model response.' : 'Waiting for local model installation. Use Check status when it is ready.';
        if (!sending && wasBusy && !remoteBusy && previousActiveId === conversationId && conversationId) {
          void loadConversation(conversationId);
          void refreshConversations().catch(error => showError(`Could not refresh saved conversations: ${error.message}`));
        }
      } catch (error) {
        statusKnown = false;
        modelStatus.textContent = 'Local model status unavailable';
        modelStatus.classList.add('local-chat-unavailable');
        if (!sending) activity.textContent = `Status check failed: ${error.message}`;
      } finally {
        statusRequest = null;
        checkStatus.disabled = false;
        controls();
      }
    })();
    return statusRequest;
  }
  async function refreshConversations() {
    const result = await request('/api/local-chat/conversations');
    if (!Array.isArray(result.conversations)) throw new Error('Saved conversation list has an unexpected format.');
    conversations = result.conversations;
    renderOptions();
  }
  async function loadConversation(id) {
    if (!validId(id)) return;
    const version = ++loadVersion;
    loading = true;
    activity.textContent = 'Loading saved conversation…';
    controls();
    try {
      const result = await request(`/api/local-chat/conversations/${encodeURIComponent(id)}`);
      if (version !== loadVersion) return;
      if (result.id !== id || !Array.isArray(result.messages)) throw new Error('Saved conversation has an unexpected format.');
      conversationId = result.id;
      messages = result.messages;
      pendingMessage = null;
      remember(conversationId);
      renderOptions();
      renderMessages();
      transcript.scrollTop = transcript.scrollHeight;
      const savedError = outcomeError(result);
      showError(savedError);
      activity.textContent = savedError
        ? `Saved conversation loaded with status: ${result.status || 'needs attention'}.`
        : 'Saved conversation loaded. Only Send starts a local model response.';
    } catch (error) {
      if (version === loadVersion) { showError(`Could not open conversation: ${error.message}`); select.value = conversationId || ''; }
    } finally {
      if (version === loadVersion) { loading = false; controls(); }
    }
  }
  function resetConversation() {
    loadVersion += 1;
    conversationId = null;
    messages = [];
    pendingMessage = null;
    input.value = '';
    remember(null);
    showError('');
    renderOptions();
    renderMessages();
    activity.textContent = 'New conversation. It will be saved when you send a message.';
    input.focus();
  }

  input.addEventListener('input', controls);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      if (!send.disabled) form.requestSubmit();
    }
  });
  newChat.addEventListener('click', resetConversation);
  select.addEventListener('change', () => {
    if (select.value) void loadConversation(select.value);
    else resetConversation();
  });
  checkStatus.addEventListener('click', async () => {
    await refreshStatus();
    if (remoteBusy) beginPolling();
    try { await refreshConversations(); }
    catch (error) { showError(`Could not refresh saved conversations: ${error.message}`); }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const message = input.value.trim();
    if (sending || loading || remoteBusy || !statusKnown || !installed || !message) return;
    if (message.length > MAX_INPUT) { showError(`Keep the message to ${MAX_INPUT} characters.`); return; }
    sending = true;
    cancelling = false;
    pendingMessage = message;
    showError('');
    activity.textContent = 'HauhauCS is working locally. Waiting for its saved response and any MCP evidence…';
    controls();
    renderMessages();
    beginPolling();
    void refreshStatus();
    try {
      const result = await request('/api/local-chat/send', {
        method: 'POST', body: { ...(conversationId ? { conversationId } : {}), message }
      });
      if (!validId(result.id) || !Array.isArray(result.messages)) throw new Error('Local chat returned an unexpected conversation format. Check saved conversations before resending.');
      conversationId = result.id;
      messages = result.messages;
      pendingMessage = null;
      const savedError = outcomeError(result);
      if (!savedError) input.value = '';
      remember(conversationId);
      renderOptions();
      renderMessages();
      showError(savedError);
      activity.textContent = savedError
        ? `Request saved with status: ${result.status || 'needs attention'}. Your draft remains in the composer; check saved evidence before retrying.`
        : 'Local response saved.';
    } catch (error) {
      pendingMessage = null;
      if (validId(error.conversationId)) {
        conversationId = error.conversationId;
        remember(conversationId);
        try {
          const saved = await request(`/api/local-chat/conversations/${encodeURIComponent(conversationId)}`);
          if (Array.isArray(saved.messages)) messages = saved.messages;
        } catch { /* Keep the actionable send error and the user's draft. */ }
      }
      renderOptions();
      renderMessages();
      showError(error.status === 409 ? `Local model is busy: ${error.message}` : `Local response failed: ${error.message}`);
      activity.textContent = 'Your message remains in the composer. Check saved history before sending it again.';
    } finally {
      sending = false;
      cancelling = false;
      clearPoll();
      await refreshStatus();
      if (remoteBusy) beginPolling();
      try { await refreshConversations(); }
      catch (error) { showError(`${errorBox.textContent ? `${errorBox.textContent} ` : ''}Could not refresh saved conversations: ${error.message}`); }
      controls();
      input.focus();
    }
  });
  stop.addEventListener('click', async () => {
    if (!activeId || cancelling) return;
    const target = activeId;
    cancelling = true;
    controls();
    activity.textContent = 'Requesting cancellation of the active local response…';
    try {
      const result = await request('/api/local-chat/cancel', { method: 'POST', body: { conversationId: target } });
      activity.textContent = result.cancelled
        ? 'Cancellation accepted. Waiting for the local run to finish stopping…'
        : 'No matching active run was cancelled. Check status for its current state.';
    } catch (error) {
      showError(`Could not stop local response: ${error.message}`);
    } finally {
      cancelling = false;
      await refreshStatus();
      controls();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearPoll();
    else if ((sending || remoteBusy) && pollsRemaining > 0) { void refreshStatus(); schedulePoll(); }
  });
  window.addEventListener('pagehide', clearPoll);

  renderOptions();
  renderMessages();
  void refreshStatus().then(() => { if (remoteBusy) beginPolling(); });
  void refreshConversations().then(async () => {
    let remembered;
    try { remembered = localStorage.getItem(STORAGE_KEY); } catch { /* Optional browser state. */ }
    if (validId(remembered) && conversations.some(c => c.id === remembered)) await loadConversation(remembered);
  }).catch(error => showError(`Could not load saved conversations: ${error.message}`));
})();
