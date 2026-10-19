// Owner-controlled Team room state: milestones, the model roster and manual
// "out of usage" marks. Kept under state/team/ (gitignored) with atomic writes.
// Only the owner changes milestones (through the page); models read them from
// shared memory, where every change is published by the caller.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const STATUSES = ['planned', 'active', 'complete'];
const ROLES = ['backup worker', 'reviewer'];
const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const text = (value, max, field) => {
  if (typeof value !== 'string' || !value.trim()) throw bad(`${field} is required`);
  const s = value.replace(/\s+/g, ' ').trim();
  if (s.length > max) throw bad(`${field} is longer than ${max} characters`);
  return s;
};
const modelName = value => {
  const s = text(value, 120, 'Model name');
  if (!/^[A-Za-z0-9._:/@-]+$/.test(s)) throw bad('Model name has unexpected characters');
  return s;
};

export function createTeamState(root, { now = Date.now, defaultLocal = [] } = {}) {
  const dir = join(root, 'state/team');
  const file = name => join(dir, name);
  const load = (name, fallback) => {
    try { if (existsSync(file(name))) { const v = JSON.parse(readFileSync(file(name), 'utf8').replace(/^﻿/, '')) /* a BOM from hand edits is fine */; if (v && typeof v === 'object') return v; } } catch { /* corrupt → start empty, never guess */ }
    return fallback;
  };
  const save = (name, value) => {
    mkdirSync(dir, { recursive: true });
    const tmp = file(name + '.tmp');
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    renameSync(tmp, file(name));
  };
  let milestones = load('milestones.json', { items: [] });
  // Until the owner changes the roster, the configured default local model is on it.
  let roster = load('roster.json', { local: defaultLocal.map(model => ({ model, role: 'backup worker', addedAt: null })), out: {} });

  const find = id => { const m = milestones.items.find(x => x.id === id); if (!m) throw bad('Milestone not found', 404); return m; };
  const stamp = m => { m.updatedAt = new Date(now()).toISOString(); };

  return {
    milestones: () => structuredClone(milestones.items),
    roster: () => structuredClone(roster),

    // One action per call; returns the full list so the page re-renders from truth.
    changeMilestones(args) {
      const action = args?.action;
      if (action === 'add') {
        if (milestones.items.length >= 50) throw bad('Up to 50 milestones');
        const m = { id: randomUUID(), title: text(args.title, 160, 'Title'), status: 'planned', notes: '' };
        if (args.notes != null) m.notes = args.notes === '' ? '' : text(args.notes, 2000, 'Notes');
        stamp(m); milestones.items.push(m);
      } else if (action === 'update') {
        const m = find(args.id);
        if (args.title != null) m.title = text(args.title, 160, 'Title');
        if (args.notes != null) m.notes = args.notes === '' ? '' : text(args.notes, 2000, 'Notes');
        if (args.status != null) {
          if (!STATUSES.includes(args.status)) throw bad('Unknown milestone status');
          // One active milestone at a time keeps "what the team is on" unambiguous.
          if (args.status === 'active') for (const other of milestones.items) if (other !== m && other.status === 'active') { other.status = 'planned'; stamp(other); }
          m.status = args.status;
          m.completedAt = args.status === 'complete' ? new Date(now()).toISOString() : undefined;
        }
        stamp(m);
      } else if (action === 'move') {
        const i = milestones.items.findIndex(x => x.id === args.id);
        if (i < 0) throw bad('Milestone not found', 404);
        const j = i + (args.by === -1 ? -1 : args.by === 1 ? 1 : 0);
        if (j < 0 || j >= milestones.items.length || j === i) throw bad('Cannot move further');
        [milestones.items[i], milestones.items[j]] = [milestones.items[j], milestones.items[i]];
      } else if (action === 'remove') {
        find(args.id);
        milestones.items = milestones.items.filter(x => x.id !== args.id);
      } else throw bad('Unknown milestone action');
      save('milestones.json', milestones);
      return structuredClone(milestones.items);
    },

    changeRoster(args) {
      const action = args?.action;
      if (action === 'add') {
        const name = modelName(args.model);
        const role = args.role ?? 'backup worker';
        if (!ROLES.includes(role)) throw bad('Unknown role');
        if (roster.local.some(m => m.model === name)) throw bad('That model is already on the team');
        if (roster.local.length >= 6) throw bad('Up to 6 local models');
        roster.local.push({ model: name, role, addedAt: new Date(now()).toISOString() });
      } else if (action === 'remove') {
        const name = modelName(args.model);
        if (!roster.local.some(m => m.model === name)) throw bad('Model not on the team', 404);
        roster.local = roster.local.filter(m => m.model !== name);
      } else if (action === 'mark-out' || action === 'clear-out') {
        if (!['claude', 'codex'].includes(args.column)) throw bad('Unknown column');
        if (action === 'mark-out') {
          const until = args.until == null ? null : Number(args.until);
          if (until != null && (!Number.isFinite(until) || until < now())) throw bad('The reset time must be in the future');
          roster.out[args.column] = { at: new Date(now()).toISOString(), until };
        } else delete roster.out[args.column];
      } else throw bad('Unknown roster action');
      save('roster.json', roster);
      return structuredClone(roster);
    },

    // A manual mark ends by itself at its reset time.
    manualOut(column) {
      const mark = roster.out[column];
      if (!mark) return null;
      if (mark.until && mark.until <= now()) return null;
      return mark;
    },
  };
}

// The plain-text form models read from shared memory (pair_recall "milestones").
export function milestonesForMemory(items) {
  if (!items.length) return 'No milestones set by the owner yet.';
  const mark = { active: '▶ ACTIVE', planned: '○ planned', complete: '✓ complete' };
  return ['Owner milestones for the Satisfactory team, in order. Only the owner marks one complete.',
    ...items.map((m, i) => `${i + 1}. [${mark[m.status]}] ${m.title}${m.notes ? ` — ${m.notes}` : ''}`)].join('\n');
}
