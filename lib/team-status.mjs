import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function record(root, path) {
  try {
    const file = join(root, 'state/architect', path), stat = statSync(file);
    if (!stat.isFile() || stat.size > 2097152) return null;
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? { value, modified: stat.mtimeMs } : null;
  } catch { return null; }
}
const label = value => typeof value === 'string' ? value.slice(0, 120) : null;

export function readTeamStatus(root, now = Date.now()) {
  const workers = [];
  const config = record(root, 'claude-config.json');
  const workflow = record(root, 'claude-workflow/workflow.json');
  const builder = record(root, 'claude-workflow/builder-state.json');
  const review = record(root, 'adapter-review.json');
  if (workflow || builder) {
    const latest = Math.max(workflow?.modified ?? 0, builder?.modified ?? 0);
    const calls = Array.isArray(builder?.value.toolCalls) ? builder.value.toolCalls : [];
    workers.push({ provider: 'anthropic', model: label(config?.value.builder?.model), role: 'Implementer',
      task: 'Structural Architect revision adapter', phase: label(workflow?.value.phase) ?? 'unknown',
      reportedStatus: label(builder?.value.status) ?? 'unknown', lastReportAt: new Date(latest).toISOString(),
      fresh: now - latest <= 120000, activity: now - latest <= 120000 ? 'reported-state' : 'unknown',
      toolCallsCompleted: calls.filter(c => c.status === 'completed').length,
      lastTool: label(calls.at(-1)?.name), budgetCents: config?.value.builder?.budgetCents ?? null,
      commit: /^[a-f0-9]{40}$/.test(workflow?.value.artifact?.commit ?? '') ? workflow.value.artifact.commit : null,
      review: label(review?.value.verdict),
      reviewCurrent: review?.value.verdict === 'approve' && /^[a-f0-9]{40}$/.test(review.value.commit ?? '') && review.value.commit === workflow?.value.artifact?.commit,
      reviewedCommit: /^[a-f0-9]{40}$/.test(review?.value.commit ?? '') ? review.value.commit : null });
  }
  const integration = record(root, 'integration-report.json');
  if (integration) workers.push({ provider: 'codex', role: 'Integrator', task: 'Structural revisions and game tools',
    phase: label(integration.value.phase) ?? 'unknown', reportedStatus: label(integration.value.phase) ?? 'unknown',
    summary: label(integration.value.summary), testsPassed: Number.isInteger(integration.value.tests?.passed) ? integration.value.tests.passed : null,
    lastReportAt: new Date(integration.modified).toISOString(), fresh: now - integration.modified <= 120000,
    activity: now - integration.modified <= 120000 ? 'reported-state' : 'unknown' });
  const google = record(root, 'google-state.json');
  if (google) {
    const calls = Array.isArray(google.value.toolCalls) ? google.value.toolCalls : [];
    workers.push({ provider: 'google', model: label(google.value.observedModelVersion ?? google.value.model), role: 'Test designer',
      task: 'Architect acceptance cases', phase: label(google.value.status) ?? 'unknown',
      reportedStatus: label(google.value.status) ?? 'unknown', lastReportAt: new Date(google.modified).toISOString(),
      fresh: now - google.modified <= 120000, activity: now - google.modified <= 120000 ? 'reported-state' : 'unknown',
      toolCallsCompleted: calls.filter(c => c.status === 'completed').length,
      lastTool: label(calls.at(-1)?.name), requests: google.value.requests ?? null, error: label(google.value.error) });
  }
  return { workers, source: 'Dated local reports from explicit model jobs; stale reports do not prove current model activity.', inferenceCallsInStatus: 0 };
}
