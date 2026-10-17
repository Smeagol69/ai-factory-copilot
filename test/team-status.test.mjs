import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('model reports distinguish authentication from useful execution and exclude private worker state', async () => {
  assert(existsSync(new URL('../lib/team-status.mjs', import.meta.url)), 'Visible model work reports must exist');
  const { readTeamStatus } = await import('../lib/team-status.mjs');
  const root = mkdtempSync(join(tmpdir(), 'architect-team-'));
  const dir = join(root, 'state/architect'); mkdirSync(join(dir, 'claude-workflow'), { recursive: true });
  try {
    writeFileSync(join(dir, 'provider-catalog.json'), JSON.stringify([{ provider: 'anthropic', status: 'authenticated' }]));
    assert.deepEqual(readTeamStatus(root).workers, []);
    writeFileSync(join(dir, 'claude-config.json'), JSON.stringify({ builder: { model: 'claude-sonnet-5-5', budgetCents: 500 } }));
    writeFileSync(join(dir, 'claude-workflow/workflow.json'), JSON.stringify({ phase: 'building' }));
    writeFileSync(join(dir, 'claude-workflow/builder-state.json'), JSON.stringify({ status: 'running', sessionId: 'private-session', claim_token: 'private-capability', toolCalls: [{ name: 'read_reference', status: 'completed', arguments: { secret: 'do-not-show' } }] }));
    const team = readTeamStatus(root);
    assert.equal(team.workers[0].provider, 'anthropic');
    assert.equal(team.workers[0].phase, 'building');
    assert.equal(team.workers[0].toolCallsCompleted, 1);
    assert.equal(team.workers[0].lastTool, 'read_reference');
    assert(!JSON.stringify(team).includes('private-'));
    assert(!JSON.stringify(team).includes('do-not-show'));
    assert.equal(readTeamStatus(root, Date.now() + 300000).workers[0].fresh, false);
    assert.equal(readTeamStatus(root, Date.now() + 300000).workers[0].activity, 'unknown');
    writeFileSync(join(dir, 'adapter-review.json'), JSON.stringify({ verdict: 'approve', commit: '7cd6743cbf03b9d1edf5bfec00d9e1392bc1fe5e', tests: { passed: 8 } }));
    writeFileSync(join(dir, 'integration-report.json'), JSON.stringify({ provider: 'codex', phase: 'testing', summary: 'Typed revisions integrated', tests: { passed: 1270 }, claim_token: 'private-integration' }));
    const reviewed = readTeamStatus(root);
    assert.equal(reviewed.workers[0].review, 'approve');
    assert.equal(reviewed.workers[0].reviewedCommit, '7cd6743cbf03b9d1edf5bfec00d9e1392bc1fe5e');
    assert.equal(reviewed.workers[0].reviewCurrent, false);
    writeFileSync(join(dir, 'claude-workflow/workflow.json'), JSON.stringify({ phase: 'built', artifact: { commit: '7cd6743cbf03b9d1edf5bfec00d9e1392bc1fe5e' } }));
    assert.equal(readTeamStatus(root).workers[0].reviewCurrent, true);
    writeFileSync(join(dir, 'claude-workflow/workflow.json'), JSON.stringify({ phase: 'built', artifact: { commit: 'a'.repeat(40) } }));
    assert.equal(readTeamStatus(root).workers[0].reviewCurrent, false);
    assert.equal(reviewed.workers[1].provider, 'codex');
    assert.equal(reviewed.workers[1].summary, 'Typed revisions integrated');
    assert(!JSON.stringify(reviewed).includes('private-integration'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
