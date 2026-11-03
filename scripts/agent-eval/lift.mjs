#!/usr/bin/env node
/** Combine a regression-set report and a capability-set report. Does not reimplement compareQuality. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const KNOWN = new Set(['improved', 'non_inferior', 'regressed', 'blocked', 'invalid']);

export function interpretSessionLift(regressionReport, capabilityReport) {
  if (!regressionReport || !capabilityReport
    || regressionReport.evaluationKind === 'simulation'
    || capabilityReport.evaluationKind === 'simulation') {
    return { verdict: 'invalid', reason: 'simulation and incomplete reports cannot judge lift' };
  }
  if (regressionReport.verdict === 'invalid' || capabilityReport.verdict === 'invalid') {
    return { verdict: 'invalid', reason: 'experiment invalid' };
  }
  const regressionRegressed = regressionReport.verdict === 'regressed';
  const regressionBlocked = regressionReport.verdict === 'blocked';
  const capabilityRegressed = capabilityReport.verdict === 'regressed';
  if (regressionRegressed || regressionBlocked || capabilityRegressed) {
    const parts = [];
    if (regressionRegressed) parts.push('regression set regressed');
    if (regressionBlocked) parts.push('regression set blocked');
    if (capabilityRegressed) parts.push('capability set regressed');
    return { verdict: 'decline', reason: parts.join('; ') };
  }
  if (regressionReport.verdict === 'inconclusive' || capabilityReport.verdict === 'inconclusive'
    || !KNOWN.has(regressionReport.verdict) || !KNOWN.has(capabilityReport.verdict)) {
    return { verdict: 'inconclusive', reason: 'evidence short of a lift or a decline' };
  }
  const regressionHeld = regressionReport.verdict === 'improved' || regressionReport.verdict === 'non_inferior';
  if (capabilityReport.verdict === 'improved' && regressionHeld) {
    return { verdict: 'lift', reason: 'capability improved and the regression set did not get worse' };
  }
  if (capabilityReport.verdict === 'non_inferior' && regressionHeld) {
    return { verdict: 'held', reason: 'regression held and the capability set did not improve' };
  }
  return { verdict: 'inconclusive', reason: 'evidence short of a lift or a decline' };
}

function isCli() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isCli()) {
  const usage = 'Usage: node scripts/agent-eval/lift.mjs --regression <report.json> --capability <report.json>';
  const options = {};
  let bad = false;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if ((arg === '--regression' || arg === '--capability') && process.argv[i + 1]) options[arg.slice(2)] = process.argv[++i];
    else bad = true;
  }
  if (bad || !options.regression || !options.capability) {
    console.error(usage);
    process.exit(2);
  }
  let regressionReport;
  let capabilityReport;
  try {
    regressionReport = JSON.parse(readFileSync(resolve(options.regression), 'utf8'));
    capabilityReport = JSON.parse(readFileSync(resolve(options.capability), 'utf8'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const result = interpretSessionLift(regressionReport, capabilityReport);
  const counts = report => {
    const summary = report?.summary;
    if (!summary) return 'tasks=? wins=? losses=?';
    return `tasks=${summary.tasks ?? '?'} wins=${summary.wins ?? '?'} losses=${summary.losses ?? '?'}`;
  };
  console.log(`verdict=${result.verdict} reason=${result.reason} regression:${counts(regressionReport)} capability:${counts(capabilityReport)}`);
  process.exit(result.verdict === 'lift' || result.verdict === 'held' ? 0 : result.verdict === 'decline' ? 1 : 2);
}
