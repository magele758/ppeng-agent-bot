#!/usr/bin/env node
/** Freeze a live baseline and name later drops. Never reports a capability lift. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function usableBaseline(report) {
  if (!report || report.evaluationKind !== 'live' || report.verdict !== 'baseline_samples') return false;
  return !(Array.isArray(report.invalid) && report.invalid.length > 0);
}

/** Group per-trial rows. A malformed row rejects the whole report. */
export function taskOutcomes(report) {
  const cases = Array.isArray(report?.cases) ? report.cases : null;
  if (!cases || cases.length === 0) return null;
  const byId = new Map();
  for (const row of cases) {
    if (!row || typeof row.caseId !== 'string' || typeof row.pass !== 'boolean') return null;
    const slot = byId.get(row.caseId) ?? { trials: 0, passed: 0, failures: [] };
    slot.trials += 1;
    if (row.pass) slot.passed += 1;
    else if (Array.isArray(row.failures)) slot.failures.push(...row.failures.filter(item => typeof item === 'string'));
    byId.set(row.caseId, slot);
  }
  return byId;
}

function weakTasks(outcomes) {
  const weak = [];
  for (const [id, slot] of outcomes) {
    if (slot.trials > 0 && slot.passed === slot.trials) continue;
    weak.push({ id, passed: slot.passed, trials: slot.trials, failures: [...new Set(slot.failures)] });
  }
  weak.sort((a, b) => a.id.localeCompare(b.id));
  return weak;
}

function droppedTasks(before, after) {
  const dropped = [];
  for (const [id, slot] of before) {
    const next = after.get(id);
    if (!next) return null;
    if (slot.trials > 0 && slot.passed === slot.trials && next.passed !== next.trials) dropped.push(id);
  }
  dropped.sort((a, b) => a.localeCompare(b));
  return dropped;
}

function judged(verdict, reason, outcomes, weak, extra = {}) {
  return { verdict, reason, tasks: outcomes.size, held: outcomes.size - weak.length, weak, ...extra };
}

export function interpretBaselineFloor(current, floor) {
  if (!usableBaseline(current)) return { verdict: 'invalid', reason: 'only a complete live baseline can be judged', weak: [] };
  const now = taskOutcomes(current);
  if (!now) return { verdict: 'invalid', reason: 'baseline report has no per-trial results', weak: [] };
  const weak = weakTasks(now);
  if (!floor) return judged('baseline', 'first sample; this is not a capability gain', now, weak);
  if (!usableBaseline(floor)) return { verdict: 'invalid', reason: 'frozen baseline is not a complete live sample', weak };
  const then = taskOutcomes(floor);
  if (!then) return { verdict: 'invalid', reason: 'frozen baseline has no per-trial results', weak };
  const dropped = droppedTasks(then, now);
  if (dropped == null) return { verdict: 'invalid', reason: 'a frozen task is missing from the new sample', weak };
  if (dropped.length) return judged('dropped', 'a task that passed every trial in the frozen baseline failed', now, weak, { dropped });
  return judged('held', 'frozen tasks did not get worse; this is not a capability gain', now, weak, { dropped });
}

export function interpretSessionBaseline(regressionReport, capabilityReport, floors = {}) {
  const regression = interpretBaselineFloor(regressionReport, floors.regression ?? null);
  const capability = interpretBaselineFloor(capabilityReport, floors.capability ?? null);
  const weak = [
    ...regression.weak.map(item => ({ ...item, suite: 'regression' })),
    ...capability.weak.map(item => ({ ...item, suite: 'capability' })),
  ];
  if (regression.verdict === 'invalid' || capability.verdict === 'invalid') {
    return { verdict: 'invalid', reason: 'one baseline report cannot be judged', regression, capability, weak };
  }
  if (regression.verdict === 'dropped' || capability.verdict === 'dropped') {
    return { verdict: 'dropped', reason: 'a frozen task that used to pass every trial failed', regression, capability, weak };
  }
  if (regression.verdict === 'baseline' || capability.verdict === 'baseline') {
    return { verdict: 'baseline', reason: 'first sample; this is not a capability gain', regression, capability, weak };
  }
  return { verdict: 'held', reason: 'frozen tasks did not get worse; this is not a capability gain', regression, capability, weak };
}

function isCli() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(resolve(entry)).href;
}

function readReport(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

if (isCli()) {
  const usage = 'Usage: node scripts/agent-eval/baseline-floor.mjs --regression <report.json> --capability <report.json> [--regression-floor <report.json>] [--capability-floor <report.json>]';
  const options = {};
  let bad = false;
  const flags = new Set(['--regression', '--capability', '--regression-floor', '--capability-floor']);
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (flags.has(arg) && process.argv[i + 1]) options[arg.slice(2)] = process.argv[++i];
    else bad = true;
  }
  if (bad || !options.regression || !options.capability) {
    console.error(usage);
    process.exit(2);
  }
  let result;
  try {
    result = interpretSessionBaseline(readReport(options.regression), readReport(options.capability), {
      regression: options['regression-floor'] ? readReport(options['regression-floor']) : null,
      capability: options['capability-floor'] ? readReport(options['capability-floor']) : null,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  console.log(`verdict=${result.verdict} reason=${result.reason}`);
  for (const item of result.weak) {
    const why = item.failures.length ? item.failures.join(', ') : 'none';
    console.log(`weak suite=${item.suite} task=${item.id} passed=${item.passed}/${item.trials} failures=${why}`);
  }
  process.exit(result.verdict === 'dropped' ? 1 : result.verdict === 'invalid' ? 2 : 0);
}
