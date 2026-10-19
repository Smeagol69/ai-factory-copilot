// The conductor's two workers, on the owner's subscriptions, adapted from the
// reviewed Agent Pair clients (runtime/agent-pair/claude-client.mjs and
// codex-client.mjs) with scoped permissions instead of "skip all checks":
//   Claude: claude -p stream-json, subscription login required, permission mode
//           dontAsk with an explicit tool list (files in its worktree, shared
//           memory and studio MCP tools, git, node/npm). Anything else is refused.
//   Codex:  codex app-server, ChatGPT login required, approval never, sandbox
//           workspace-write (writes only inside its worktree).
// Both load the same two MCP servers: agent_pair (shared memory, mailbox) and
// studio (design and the logged game actions). One persistent session each;
// run(text) is one turn. Usage reports come from the clients themselves.
import { EventEmitter } from 'node:events';

const CLAUDE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'mcp__agent_pair__*', 'mcp__studio__*',
  ...['git status', 'git diff', 'git log', 'git show', 'git add', 'git commit', 'git rev-parse', 'git branch', 'git switch', 'git merge', 'git fetch',
    'node', 'npm test', 'npm --prefix companion test'].flatMap(c => [`Bash(${c})`, `Bash(${c} *)`])];

export function normaliseUsage(raw) {
  // Codex: {rateLimits:{primary:{usedPercent,resetsAt}}} (or snake_case); Claude: {status, resetsAt, utilization}.
  const r = raw?.rateLimits ?? raw?.rate_limits ?? raw;
  const p = r?.primary;
  if (p) {
    // The 5-hour window, and the weekly one: either at 100% means out until it resets.
    const ms = v => Number.isFinite(v) ? (v < 1e12 ? v * 1000 : v) : null;
    const used = p.usedPercent ?? p.used_percent, reset = ms(p.resetsAt ?? p.resets_at);
    const s = r.secondary, sUsed = s ? (s.usedPercent ?? s.used_percent) : null, sReset = s ? ms(s.resetsAt ?? s.resets_at) : null;
    const full = [used >= 100 ? reset : null, sUsed >= 100 ? sReset : null].filter(v => v !== null);
    return { usedPercent: Number.isFinite(used) ? used : null, weeklyPercent: Number.isFinite(sUsed) ? sUsed : null, resetsAt: full.length ? Math.max(...full) : reset, out: used >= 100 || sUsed >= 100 }; }
  if (r?.status) { const reset = r.resetsAt ?? r.resets_at; const used = Number.isFinite(r.utilization) ? r.utilization * (r.utilization <= 1 ? 100 : 1) : null;
    return { usedPercent: used, resetsAt: Number.isFinite(reset) ? (reset < 1e12 ? reset * 1000 : reset) : null, out: r.status === 'rejected' }; }
  return null;
}

class Worker extends EventEmitter {
  constructor(name) { super(); this.name = name; this.busy = false; this.usage = null; this.waiting = null; }
  setUsage(raw) { const u = normaliseUsage(raw); if (u) { this.usage = { ...u, at: Date.now() }; this.emit('usage', this.usage); } }
  // Resolves when the turn ends; rejects on a fault. One turn at a time.
  run(text) {
    if (this.busy) return Promise.reject(new Error(`${this.name} is already working`));
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject }; this.busy = true;
      this.prompt(text).catch(e => { this.busy = false; this.waiting = null; reject(e); }); });
  }
  finish(result) { this.busy = false; const w = this.waiting; this.waiting = null; w?.resolve(result); this.emit('done', result); }
  fault(error) { this.busy = false; const w = this.waiting; this.waiting = null; w?.reject(error); this.emit('fault', error); }
}

export class ClaudeWorker extends Worker {
  constructor({ runtime, cwd, mcpServers, addDirs = [], guidance = '' }) { super('claude'); Object.assign(this, { runtime, cwd, mcpServers, addDirs, guidance }); }
  args() {
    return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk',
      '--allowedTools', CLAUDE_TOOLS.join(','), '--mcp-config', JSON.stringify({ mcpServers: this.mcpServers }), '--strict-mcp-config',
      '--settings', JSON.stringify({ forceLoginMethod: 'claudeai' }), ...this.addDirs.flatMap(d => ['--add-dir', d]),
      ...(this.guidance ? ['--append-system-prompt', this.guidance] : [])];
  }
  async start() {
    const { launch, runJson, resolveClientCommand } = this.runtime;
    const command = resolveClientCommand('claude', 'claude');
    const auth = await runJson(command, ['auth', 'status'], this.cwd);
    if (!auth.loggedIn || auth.authMethod === 'api_key' || auth.apiProvider !== 'firstParty') throw new Error('Claude subscription sign-in required; API spending stays disabled');
    this.child = launch(command, this.args(), this.cwd, msg => this.receive(msg), (code, signal, stderr) => { if (!this.stopping) this.fault(new Error(`Claude worker exited (${code}): ${String(stderr).slice(-400)}`)); }, e => this.fault(e));
  }
  receive(msg) {
    if (msg.type === 'system' && msg.subtype === 'init') this.sessionId = msg.session_id;
    if (msg.type === 'rate_limit_event') this.setUsage(msg.rate_limit_info ?? msg.rateLimitInfo ?? msg);
    if (msg.type === 'assistant') for (const b of msg.message?.content ?? []) if (b.type === 'tool_use') this.emit('tool', { name: b.name });
    if (msg.type === 'result') this.finish({ status: msg.is_error || msg.subtype !== 'success' ? 'failed' : 'completed', text: String(msg.result ?? '').slice(-4000) });
  }
  async prompt(text) {
    if (!this.child?.stdin.writable) throw new Error('Claude worker input is closed');
    this.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: this.sessionId ?? '' }) + '\n');
  }
  async stop() { this.stopping = true; await this.runtime.terminate(this.child); if (this.busy) this.fault(new Error('Stopped')); }
}

export class CodexWorker extends Worker {
  // resumeThreadId continues an existing thread (the session keeper); ownConfig runs it
  // with the owner's normal Codex configuration instead of the conductor's overrides.
  constructor({ runtime, cwd, mcpServers, resumeThreadId = null, ownConfig = false }) { super('codex'); Object.assign(this, { runtime, cwd, mcpServers, resumeThreadId, ownConfig, pending: new Map(), seq: 0, text: '' }); }
  args() {
    const cfg = Object.entries(this.mcpServers).flatMap(([name, s]) => ['-c', `mcp_servers.${name}.command=${JSON.stringify(s.command)}`, '-c', `mcp_servers.${name}.args=${JSON.stringify(s.args)}`]);
    if (this.ownConfig) return ['app-server', '--listen', 'stdio://'];
    return ['app-server', '--listen', 'stdio://', '-c', 'plugins."agent-pair@personal".enabled=false', ...cfg];
  }
  async start() {
    const { launch, resolveClientCommand } = this.runtime;
    this.child = launch(resolveClientCommand('codex', 'codex'), this.args(), this.cwd, m => this.receive(m), (code, signal, stderr) => { this.failPending(new Error('Codex worker exited')); if (!this.stopping) this.fault(new Error(`Codex worker exited (${code}): ${String(stderr).slice(-400)}`)); }, e => { this.failPending(e); this.fault(e); });
    await this.rpc('initialize', { clientInfo: { name: 'copilot_conductor', title: 'Copilot conductor', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized' });
    const account = await this.rpc('account/read', {});
    if (!account.account || !String(account.account.type).toLowerCase().includes('chatgpt')) throw new Error('Codex needs the ChatGPT subscription login; API-key fallback is disabled');
    try { this.setUsage(await this.rpc('account/rateLimits/read', {})); } catch { /* usage unknown until the first update */ }
    // A resumed thread keeps its own saved settings (model, sandbox, approvals).
    const r = this.resumeThreadId
      ? await this.rpc('thread/resume', { threadId: this.resumeThreadId, excludeTurns: true })
      : await this.rpc('thread/start', { serviceName: 'copilot_conductor', ephemeral: false, cwd: this.cwd, modelProvider: 'openai', approvalPolicy: 'never', sandbox: 'workspace-write' });
    this.threadId = r.thread.id;
  }
  send(v) { if (!this.child?.stdin.writable) throw new Error('Codex worker input is closed'); this.child.stdin.write(JSON.stringify(v) + '\n'); }
  rpc(method, params) { const id = ++this.seq; return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, 60000); this.pending.set(id, { resolve, reject, timer }); try { this.send({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); } }); }
  failPending(e) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); } this.pending.clear(); }
  receive(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); clearTimeout(p.timer); this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); return; }
    if (msg.params?.threadId && this.threadId && msg.params.threadId !== this.threadId) { if (msg.id !== undefined && msg.method) this.send({ id: msg.id, error: { code: -32601, message: 'Not approved for conductor workers' } }); return; }
    // Any request for approval is refused: approval policy is never, so nothing should ask.
    if (msg.id !== undefined && msg.method) { this.send({ id: msg.id, error: { code: -32601, message: 'Interactive approval is not available to conductor workers' } }); return; }
    const p = msg.params ?? {};
    if (msg.method === 'account/rateLimits/updated') this.setUsage(p);
    if (msg.method === 'turn/started') this.turnId = p.turn?.id;
    if (msg.method === 'item/agentMessage/delta') this.text += p.delta ?? '';
    if (msg.method === 'item/completed' && p.item?.type === 'agentMessage') this.finalText = p.item.text;
    if (msg.method === 'item/started' && p.item?.type) this.emit('tool', { name: p.item.type });
    if (msg.method === 'turn/completed') { const text = this.finalText || this.text; this.text = ''; this.finalText = ''; this.turnId = null;
      this.finish({ status: p.turn?.status === 'completed' ? 'completed' : String(p.turn?.status ?? 'failed'), text: String(text).slice(-4000), error: p.turn?.error ?? null }); }
    if (msg.method === 'error' && !p.willRetry) this.fault(new Error(p.error?.message ?? 'Codex turn error'));
  }
  async prompt(text) { const r = await this.rpc('turn/start', { threadId: this.threadId, input: [{ type: 'text', text }] }); this.turnId = r.turn?.id; }
  async stop() { this.stopping = true; if (this.turnId) await this.rpc('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {}); await this.runtime.terminate(this.child); this.failPending(new Error('Stopped')); if (this.busy) this.fault(new Error('Stopped')); }
}

export const conductorToolList = () => [...CLAUDE_TOOLS];
