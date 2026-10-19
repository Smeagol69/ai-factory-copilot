# Team room portal design

Date: 2026-10-18 · Project 2 of 3 (1 = one repo, done; 3 = creative Architect research)

## Why

The owner wants to open one page and **watch every model work live**, the way
they can watch Claude and Codex in their own chat apps. They want to plug a model
(their Ollama Qwen first) into the shared MCP easily, with all models sharing
memory and working toward milestones the owner types in and marks complete.
Today's hub Overview (`http://127.0.0.1:8795/#overview`) shows connection checks
and dated job reports. The owner "can't really tell who's working or plug in
models easily".

The overall milestone this serves: **the owner gives a prompt and the models work
together until a blueprint exists that works in game**: bases, factories,
tunnels. Codex's curved tunnel was the proof of concept.

## Decided by the owner

- Layout **A, "Team room"**: a milestone strip across the top, and below it one
  live column per model, like several chat windows side by side.
- Milestones: the owner adds them and marks them complete. Models don't.
- Team: Claude (Claude Code) and Codex on the owner's subscriptions. The local
  model works **only when every other model is out of usage**, and the others
  check its work. Paid API models (DeepSeek, Grok) are a later "add model" option,
  not built now.
- Local model: **HauhauCS Qwen3.5 9B** (`copilot-hauhau-game:latest`).
- Satisfactory only for now.

## Goals

1. **Live columns.** Each model's column shows what it's doing now, built from
   the logs its own app already writes:
   - what it says
   - the tools it calls, with a short summary (a command's description, a file path)
   - the results of those calls
   - its Agent Pair messages

   Newest at the bottom, updating every 2 s without a reload.
2. **Status per column:**
   - **working**: an event in the last 2 min
   - **idle**
   - **out of usage**, with the reset time
   - **standby**: the local model, waiting for its shift
3. **Milestone strip.** Add, rename, reorder, set active, mark complete, reopen.
   Each change is saved and published to Agent Pair shared memory (key
   `milestones`), so every MCP-connected model sees the same list through
   `pair_recall`/`pair_context`.
4. **Connect a model:**
   - Claude Code and Codex: shown connected when a session is working in this
     repo. A "Connect" card explains that you open the repo folder in that app;
     the MCP launchers are already written on every hub start.
   - Ollama: lists the installed models and adds or removes one as a column with
     a role (backup worker or reviewer).
5. **Backup shift.** When every subscription model is out of usage and a
   milestone is active, the local model takes the next step:
   - It works in its own git worktree on a `local/…` branch.
   - Its column streams what it does.
   - The result is posted to Agent Pair as "needs review".
   - The first subscription model back reviews it before anything is merged.
   - It's off by default; the owner turns it on, and the column has a **Stop** button.

## Non-goals

- No paid API models, keys or billing.
- The hub can't stop or steer a Claude Code or Codex session. Those stay in their
  own apps, and the column says so instead of showing a fake Stop button.
- No replacing the Agent Pair coordinator or editing its pinned runtime.
- Not a chat client for Claude or Codex.

## Anti-goals

- Showing activity that isn't real. Every line comes from a real log entry with
  its timestamp; stale stays stale.
- Leaking secrets from transcripts. Thinking blocks are never shown, text is
  truncated, and key-shaped strings are redacted. The page is local-only (the
  existing origin checks).
- The local model changing master or the game on its own. Its work only lands
  through review.
- A heavy page: Codex logs reach 150 MB, so they're only ever read from the tail.

## How it works

**Feed sources (read-only):**
- Codex: `~/.codex/sessions/**/rollout-*.jsonl`. A session belongs to this project
  when its first line's `session_meta.payload.cwd` is under the repo root or a
  legacy `Documents\satisfactory*` path. Its events:
  - `response_item` messages (assistant text)
  - `function_call` / `custom_tool_call` (tool and arguments)
  - `*_output` (results)
  - `token_count.rate_limits` (usage: `primary.used_percent` ≥ 100 means out,
    until `resets_at`)
- Claude Code: `~/.claude/projects/*/*.jsonl`, keeping only lines whose `cwd`
  is under those paths. Assistant `text` and `tool_use` (name plus description,
  command, file path) are shown; `thinking` never is. Usage limit comes from API
  error lines matching "usage limit / hit your limit / limit reached", or from
  the owner marking it out by hand.
- Local model: the hub's own event log `state/team/local-events.jsonl`.
- Agent Pair: recent messages in this project, routed to the column of their
  sender's provider.
- Files are found by modification time within the last 48 h. Only the last 512 KB
  of each is read, and the reader caches by size and modification time.

**Server.** New routes on the existing app server:
- `GET /api/team` returns the columns, milestones and roster.
- `POST /api/team/milestones` takes `{action, …}`.
- `POST /api/team/models` takes `{action: add|remove|mark-out|clear-out, …}`.
- `POST /api/team/shift` takes `{action: enable|disable|stop}`.

Request bodies are JSON of 16 KB or less, with the same origin rules as today.

**Page.** "Team room" becomes the first and default tab, with the others kept as
they are. It uses plain JS like the existing pages; the CSP allows no inline
script.

**State.** Under `hub/state/team/` (gitignored): `milestones.json`,
`roster.json`, `shift.json`, `local-events.jsonl`.

## Phases

1. Feeds, columns, statuses, milestone strip (with shared-memory publishing),
   roster and Ollama add/remove.
2. Backup shift worker (worktree, runner, review request, Stop).

## Builder's choices

Exact visual styling (matching the existing hub theme), event summarising rules,
the polling cadence (around 2 s), and the review-request message wording.

## Phase 2: the backup shift (decisions, 2026-10-18)

- **When:** the shift is on (owner toggle in the local column, off by default),
  a milestone is ACTIVE, and every subscription column (Codex, Claude) shows
  "out of usage" (from its own log, or the owner's manual mark). Checked every
  60 s; at most one step at a time, a 15-minute pause between steps and 8
  steps per outage, so a stuck model can't loop all night.
- **Where:** a persistent git worktree `hub/workspaces/local-shift` on branch
  `local/shift`, cut from `master` the first time. The local model can only:
  read text files in the worktree; make one exact replacement (or create a new
  file) under `companion/`, `hub/`, `docs/`, `scripts/` or `Source/` with text
  extensions; run `node --test` on one test file under `companion/test` or
  `hub/test`. No game access, no network, no push, no other branch.
- **One step:** the model gets the active milestone, its notes, the last steps'
  summaries and the worktree's recent commits, and is asked for ONE small,
  verifiable step that needs no game (a focused test, a small fix, a write-up of
  a finding), ending with what changed and what a reviewer should check. The
  existing local runner's limits apply (10 requests, 8 tool calls, 4 minutes).
- **After a step:** if files changed, the engine commits them on `local/shift`
  as "HauhauCS (local)" and posts an Agent Pair message "Review requested:
  local/shift <sha>" with the summary. A step is "merged" once its commit is in
  `master`; until then it shows as **needs review** in the Team room. Reviewers
  merge or discard it; the shift never merges itself.
- **Seen live:** every model request, tool call and result goes to
  `state/team/local-events.jsonl` and streams into the local model's column.
  **Stop** aborts the running step and turns the shift off.
