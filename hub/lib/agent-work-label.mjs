export function evidenceCountLabel({ toolCallsCompleted:tc, verifiedArtifacts:va } = {}) {
  const known = value => Number.isSafeInteger(value) && value >= 0;
  const tcStr = known(tc) ? `${tc} tool ${tc === 1 ? 'call' : 'calls'}` : 'Tool calls unknown';
  const vaStr = known(va) ? `${va} verified ${va === 1 ? 'file' : 'files'}` : 'verified files unknown';

  return `${tcStr} · ${vaStr}`;
}
