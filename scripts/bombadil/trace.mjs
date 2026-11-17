export async function summarizeTrace(lines) {
  const report = { states: 0, selections: 0, sends: 0, reloads: 0, violations: [] };
  const violations = new Set();
  for await (const line of lines) {
    const { action, violations: findings } = JSON.parse(line);
    report.states++;
    if (action?.Custom?.name === 'selectBot') report.selections++;
    if (action?.Custom?.name === 'sendProbe') report.sends++;
    if (action === 'Reload') report.reloads++;
    for (const finding of findings) violations.add(finding.name);
  }
  report.violations = [...violations];
  return report;
}

export function canaryDetected(exitCode, report) {
  return exitCode === 2 && report.violations.includes('transcriptOwnership');
}
