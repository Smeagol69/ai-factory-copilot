// Live model activity for the Team room, read from the logs each model's own app
// already writes: Codex rollouts (~/.codex/sessions) and Claude Code transcripts
// (~/.claude/projects). Read-only. Only the tail of each file is read (Codex logs
// reach 150 MB), only lines from this project's folders are kept, thinking is
// never shown and key-shaped strings are redacted.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TAIL_BYTES = 524288, HEAD_BYTES = 65536;
export const WORKING_MS = 120000;
const LIMIT_TEXT = /usage limit|hit your limit|limit reached|out of (?:extra )?usage/i;

export function redact(text) {
  return String(text ?? '')
    .replace(/\b(?:sk-ant-|sk-proj-|sk-|xai-|ghp_|gho_|github_pat_)[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, '[redacted]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1[redacted]');
}
const clip = (text, n = 280) => { const s = redact(text).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const norm = p => String(p ?? '').replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
// A string prefix on purpose: "…\satisfactory" also matches the legacy
// "…\satisfactory-mcp-lab" and "…\satisfactory-claude" folders.
export const inProject = (cwd, roots) => !!cwd && roots.some(r => norm(cwd).startsWith(norm(r)));

function readRange(file, start, length) {
  const fd = openSync(file, 'r');
  try { const buf = Buffer.alloc(length); const n = readSync(fd, buf, 0, length, start); return buf.subarray(0, n).toString('utf8'); }
  finally { closeSync(fd); }
}
export function tailLines(file, size = statSync(file).size, maxBytes = TAIL_BYTES) {
  const start = Math.max(0, size - maxBytes);
  const lines = readRange(file, start, size - start).split('\n');
  if (start > 0) lines.shift(); // the first line is cut in half
  return lines.filter(Boolean);
}
const parse = line => { try { return JSON.parse(line); } catch { return null; } };
const ms = iso => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

export function summariseTool(name, input) {
  const n = String(name ?? 'tool');
  if (typeof input === 'string') {
    const cmd = input.match(/cmd:\s*"((?:[^"\\]|\\.)*)"/);
    return clip(cmd ? `${n}: ${cmd[1].replace(/\\(.)/g, '$1')}` : `${n}: ${input.split('\n')[0]}`, 200);
  }
  const i = input && typeof input === 'object' ? input : {};
  const short = p => String(p).replaceAll('\\', '/').split('/').slice(-3).join('/');
  if (i.description) return clip(`${n}: ${i.description}`, 200);
  if (i.command) return clip(`${n}: ${i.command}`, 200);
  if (i.file_path) return clip(`${n}: ${short(i.file_path)}`, 200);
  if (i.pattern) return clip(`${n}: ${i.pattern}`, 200);
  if (i.url) return clip(`${n}: ${i.url}`, 200);
  const label = n.startsWith('mcp__') ? n.split('__').slice(-1)[0] : n;
  const keys = Object.keys(i).slice(0, 3).map(k => `${k}=${typeof i[k] === 'string' ? i[k] : JSON.stringify(i[k])}`).join(', ');
  return clip(keys ? `${label}: ${keys}` : label, 200);
}
const textOf = content => Array.isArray(content) ? content.map(c => c?.text ?? (typeof c === 'string' ? c : '')).join(' ') : String(content ?? '');
const injected = text => /^\s*(?:#\s*AGENTS\.md|<)/.test(text);

// ---- Codex -----------------------------------------------------------------
export function codexMeta(file) {
  const first = readRange(file, 0, HEAD_BYTES).split('\n')[0];
  const j = parse(first);
  if (j?.type !== 'session_meta') return null;
  const p = j.payload ?? {};
  return { id: p.id ?? null, cwd: p.cwd ?? null, parent: p.parent_thread_id ?? null, startedAt: ms(p.timestamp ?? j.timestamp) };
}

export function parseCodex(lines) {
  const events = [], out = { events, usage: null, limitAt: null, title: null };
  for (const line of lines) {
    const j = parse(line); if (!j) continue;
    const t = ms(j.timestamp), p = j.payload ?? {};
    if (j.type === 'response_item') {
      if (p.type === 'message' && p.role === 'assistant') { const s = clip(textOf(p.content), 600); if (s) events.push({ t, kind: 'say', text: s }); }
      else if (p.type === 'message' && p.role === 'user') { const s = textOf(p.content); if (s.trim() && !injected(s)) events.push({ t, kind: 'prompt', text: clip(s, 400) }); }
      else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        let input = p.input ?? p.arguments; if (typeof input === 'string' && p.type === 'function_call') input = parse(input) ?? input;
        events.push({ t, kind: 'tool', text: summariseTool(p.name, input) });
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        let s = (typeof p.output === 'string' ? p.output : textOf(p.output)).replace(/^\s*Script completed\s*Wall time [\d.]+ seconds\s*Output:\s*/i, '');
        // Codex shell results are JSON with an exit code; show "exit N: output".
        // Long outputs arrive cut off, so read the fields rather than parsing whole JSON.
        const exit = s.trim().startsWith('{') ? s.match(/"exit_code":\s*(-?\d+)/) : null;
        if (exit) {
          const output = s.match(/"output":\s*"((?:[^"\\]|\\.)*)/)?.[1]?.replace(/\\n/g, ' ').replace(/\\(.)/g, '$1') ?? '';
          events.push({ t, kind: 'result', text: clip(`exit ${exit[1]}: ${output}`, 160), error: exit[1] !== '0' });
        } else events.push({ t, kind: 'result', text: clip(s, 160), error: /\b(?:error|failed|exception)\b/i.test(s.slice(0, 400)) });
      }
    } else if (j.type === 'event_msg') {
      if (p.type === 'token_count' && p.rate_limits?.primary) {
        const r = p.rate_limits;
        out.usage = { usedPercent: r.primary.used_percent ?? null, resetsAt: r.primary.resets_at ? r.primary.resets_at * 1000 : null,
          weeklyPercent: r.secondary?.used_percent ?? null, weeklyResetsAt: r.secondary?.resets_at ? r.secondary.resets_at * 1000 : null, at: t };
      } else if (p.type === 'task_started') events.push({ t, kind: 'turn', text: 'Started a task' });
      else if (p.type === 'task_complete') {
        const err = p.error?.message;
        if (err && LIMIT_TEXT.test(err)) out.limitAt = t;
        events.push({ t, kind: 'turn', text: err ? clip(err, 240) : 'Finished the task', error: !!err });
      }
    }
  }
  return out;
}

// ---- Claude Code ------------------------------------------------------------
export function parseClaude(lines, roots) {
  const events = [], out = { events, limitAt: null, title: null, sessionId: null };
  for (const line of lines) {
    const j = parse(line); if (!j) continue;
    if (j.type === 'custom-title' && j.customTitle) { out.title = clip(j.customTitle, 80); continue; }
    if (!inProject(j.cwd, roots)) continue;
    out.sessionId ??= j.sessionId ?? null;
    const t = ms(j.timestamp), content = j.message?.content;
    if (j.type === 'assistant') {
      if (j.isApiErrorMessage) {
        const s = textOf(content);
        if (LIMIT_TEXT.test(s)) out.limitAt = t;
        events.push({ t, kind: 'turn', text: clip(s, 240), error: true });
        continue;
      }
      for (const c of Array.isArray(content) ? content : []) {
        if (c?.type === 'text' && c.text?.trim()) events.push({ t, kind: 'say', text: clip(c.text, 600) });
        else if (c?.type === 'tool_use') events.push({ t, kind: 'tool', text: summariseTool(c.name, c.input && Object.keys(c.input).length ? c.input : j.wireToolInputs?.[c.id]) });
      }
    } else if (j.type === 'user') {
      if (typeof content === 'string') { if (content.trim() && !injected(content)) events.push({ t, kind: 'prompt', text: clip(content, 400) }); }
      else for (const c of Array.isArray(content) ? content : []) {
        if (c?.type === 'tool_result') events.push({ t, kind: 'result', text: clip(typeof c.content === 'string' ? c.content : textOf(c.content), 160), error: c.is_error === true });
      }
    }
  }
  return out;
}

// ---- Discovery and caching --------------------------------------------------
function walk(dir, depth, keep, found = []) {
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory() && depth > 0) walk(p, depth - 1, keep, found);
    else if (e.isFile() && keep(e.name)) found.push(p);
  }
  return found;
}
const recent = (files, since) => files.map(file => { try { const s = statSync(file); return { file, size: s.size, mtimeMs: s.mtimeMs }; } catch { return null; } })
  .filter(f => f && f.mtimeMs >= since);

export function createFeedReader({ codexHome, claudeHome, roots, windowMs = 48 * 3600000, limit = 80 } = {}) {
  const cache = new Map(), metas = new Map();
  const cached = (f, parseFn) => {
    const hit = cache.get(f.file);
    if (hit && hit.size === f.size && hit.mtimeMs === f.mtimeMs) return hit.value;
    const value = parseFn(tailLines(f.file, f.size));
    cache.set(f.file, { size: f.size, mtimeMs: f.mtimeMs, value });
    return value;
  };
  const merge = parts => {
    const events = parts.flatMap(p => p.events.map(e => ({ ...e, session: p.session }))).filter(e => e.t).sort((a, b) => a.t - b.t);
    return { events: events.slice(-limit), lastAt: events.at(-1)?.t ?? null };
  };
  return {
    read(now = Date.now()) {
      const since = now - windowMs;
      const codexFiles = codexHome && existsSync(join(codexHome, 'sessions'))
        ? recent(walk(join(codexHome, 'sessions'), 3, n => n.startsWith('rollout-') && n.endsWith('.jsonl')), since) : [];
      const codexParts = [];
      let usage = null, limitAt = null;
      for (const f of codexFiles) {
        if (!metas.has(f.file)) metas.set(f.file, codexMeta(f.file));
        const meta = metas.get(f.file);
        if (!meta || !inProject(meta.cwd, roots)) continue;
        const v = cached(f, parseCodex);
        codexParts.push({ ...v, session: (meta.id ?? '').slice(-6), parent: meta.parent, lastAt: f.mtimeMs });
        if (v.usage && (!usage || v.usage.at > usage.at)) usage = v.usage;
        if (v.limitAt && v.limitAt > (limitAt ?? 0)) limitAt = v.limitAt;
      }
      const claudeFiles = claudeHome && existsSync(join(claudeHome, 'projects'))
        ? recent(walk(join(claudeHome, 'projects'), 1, n => n.endsWith('.jsonl')), since) : [];
      const claudeParts = [];
      let claudeLimit = null;
      for (const f of claudeFiles) {
        const v = cached(f, lines => parseClaude(lines, roots));
        if (!v.events.length) continue;
        claudeParts.push({ ...v, session: (v.sessionId ?? '').slice(0, 6) });
        if (v.limitAt && v.limitAt > (claudeLimit ?? 0)) claudeLimit = v.limitAt;
      }
      const sessions = parts => parts.map(p => ({ id: p.session, title: p.title ?? null, lastAt: p.events.at(-1)?.t ?? null }))
        .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)).slice(0, 6);
      return {
        codex: { ...merge(codexParts), sessions: sessions(codexParts), usage, limitAt },
        claude: { ...merge(claudeParts), sessions: sessions(claudeParts), usage: null, limitAt: claudeLimit },
      };
    },
  };
}

// working / idle / out / standby, from real timestamps only.
export function columnStatus({ lastAt, usage, limitAt, manualOut, standby }, now = Date.now()) {
  if (manualOut) return { state: 'out', detail: 'Marked out of usage by the owner', resetsAt: manualOut.until ?? null };
  if (usage?.usedPercent >= 100 && usage.resetsAt > now) return { state: 'out', detail: `Out of usage (${Math.round(usage.usedPercent)}%)`, resetsAt: usage.resetsAt };
  if (limitAt && (!lastAt || limitAt >= lastAt - 1000) && now - limitAt < 5 * 3600000 && !(usage && usage.at > limitAt && usage.usedPercent < 100))
    return { state: 'out', detail: 'Hit its usage limit', resetsAt: usage?.resetsAt > now ? usage.resetsAt : null };
  if (lastAt && now - lastAt <= WORKING_MS) return { state: 'working', detail: 'Working now', resetsAt: null };
  if (standby) return { state: 'standby', detail: 'Waiting for its shift', resetsAt: null };
  return { state: 'idle', detail: lastAt ? 'Idle' : 'No activity in this project yet', resetsAt: null };
}

// ---- Local model ------------------------------------------------------------
// The hub's own local-chat conversations (requests from the owner or from other
// models through the local_model MCP) are the local model's real activity.
export function readLocalChats(dir, { since = 0, limit = 80 } = {}) {
  let files; try { files = readdirSync(dir).filter(n => n.endsWith('.json')).map(n => join(dir, n)); } catch { return { events: [], lastAt: null, models: {} }; }
  const events = [];
  for (const f of recent(files, since)) {
    if (f.size > 4194304) continue;
    let j; try { j = JSON.parse(readRange(f.file, 0, f.size)); } catch { continue; }
    const session = String(j.id ?? '').slice(0, 6), model = typeof j.model === 'string' ? j.model : null;
    for (const m of Array.isArray(j.messages) ? j.messages : []) {
      const t = ms(m.createdAt); if (!t) continue;
      const content = typeof m.content === 'string' ? m.content : textOf(m.content);
      if (m.role === 'user') events.push({ t, kind: 'prompt', text: clip(content, 400), session, model });
      else if (m.role === 'assistant' && content.trim()) events.push({ t, kind: 'say', text: clip(content, 600), session, model });
      else if (m.role === 'tool') events.push({ t, kind: 'tool', text: clip(m.name ?? 'tool', 120), session, model });
    }
    if (j.status === 'failed' || j.lastError) events.push({ t: ms(j.updatedAt) ?? f.mtimeMs, kind: 'turn', text: clip(j.lastError?.message ?? 'The request failed', 240), error: true, session, model });
  }
  events.sort((a, b) => a.t - b.t);
  return { events: events.slice(-limit), lastAt: events.at(-1)?.t ?? null };
}

// The backup shift's own event log (state/team/local-events.jsonl).
export function readLocalEvents(file, { since = 0, limit = 80 } = {}) {
  let size; try { size = statSync(file).size; } catch { return []; }
  return tailLines(file, size).map(parse).filter(e => e && Number.isFinite(e.t) && e.t >= since && typeof e.text === 'string')
    .map(e => ({ t: e.t, kind: ['say', 'tool', 'result', 'prompt', 'turn'].includes(e.kind) ? e.kind : 'turn', text: clip(e.text, 400), error: e.error === true, session: 'shift', model: typeof e.model === 'string' ? e.model : null }))
    .slice(-limit);
}
