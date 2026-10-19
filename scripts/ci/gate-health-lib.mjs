// Pure helpers for gate-health.mjs (unit-tested in scripts/test/gate-health-lib.test.mjs).

export const QUICK_CHECK = 'Quick gate';
export const GATE_CHECK = 'Release gate / Main release gate';
export const GATE_JOB_PREFIX = 'Release gate / ';

const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

/** main = push to the default branch, pr = pull_request, other = pushes to feature branches etc. */
export function runScope(run, mainBranch = 'main') {
  if (run.event === 'pull_request' || run.event === 'pull_request_target') return 'pr';
  if (run.event === 'push' && run.headBranch === mainBranch) return 'main';
  return 'other';
}

export function gateOutcome(conclusion) {
  if (conclusion === 'success') return 'pass';
  if (FAILED.has(conclusion)) return 'fail';
  if (conclusion == null) return 'missing';
  return 'neutral'; // cancelled (superseded by concurrency), skipped, …
}

/** Reduce one run + its jobs (GitHub jobs API shape) to what the report needs. */
export function summarizeRun(run, jobs, mainBranch = 'main', requiredCheck = GATE_CHECK) {
  const gateJobs = jobs.filter((j) => requiredCheck === QUICK_CHECK ? j.name === QUICK_CHECK : j.name.startsWith(GATE_JOB_PREFIX));
  const gate = gateJobs.find((j) => j.name === requiredCheck);
  const failedJobs = [];
  const failedSteps = [];
  for (const job of gateJobs) {
    if (job === gate || !FAILED.has(job.conclusion)) continue;
    failedJobs.push(job.name);
    for (const step of job.steps ?? []) {
      if (FAILED.has(step.conclusion)) failedSteps.push(`${job.name} › ${step.name}`);
    }
  }
  let outcome = gateOutcome(gate?.conclusion ?? null);
  // The aggregate job runs with if: always(), so a run superseded by concurrency still reports it as failed.
  if (outcome === 'fail' && run.conclusion === 'cancelled') outcome = 'neutral';
  return {
    id: run.databaseId,
    url: run.url,
    title: run.displayTitle,
    createdAt: run.createdAt,
    branch: run.headBranch,
    scope: runScope(run, mainBranch),
    gate: outcome,
    failedJobs,
    failedSteps
  };
}

function countBy(items) {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function emptyTally() {
  return { runs: 0, pass: 0, fail: 0, neutral: 0, missing: 0, passRate: null };
}

/** Pass rate = pass / (pass + fail); cancelled/skipped runs and runs without the gate job are excluded. */
export function aggregateRuns(summaries) {
  const byScope = { main: emptyTally(), pr: emptyTally(), other: emptyTally(), all: emptyTally() };
  for (const s of summaries) {
    for (const t of [byScope[s.scope], byScope.all]) {
      t.runs += 1;
      t[s.gate] += 1;
    }
  }
  for (const t of Object.values(byScope)) {
    t.passRate = t.pass + t.fail ? t.pass / (t.pass + t.fail) : null;
  }
  const failing = summaries.filter((s) => s.gate === 'fail');
  return {
    byScope,
    jobFailures: countBy(failing.flatMap((s) => s.failedJobs)),
    stepFailures: countBy(failing.flatMap((s) => s.failedSteps)),
    failedRuns: failing.map(({ id, url, title, scope, branch }) => ({ id, url, title, scope, branch }))
  };
}

/** Merge retry-failed-tests.mjs JSON reports (one per artifact) into flaky statistics. */
export function summarizeFlaky(entries) {
  const flakyFiles = [];
  const flakyTests = [];
  let failedTwice = 0;
  const runs = new Set();
  const runsWithFlaky = new Set();
  for (const { runId, report } of entries) {
    if (!report || !Array.isArray(report.flaky)) continue;
    runs.add(runId);
    if (report.flaky.length) runsWithFlaky.add(runId);
    for (const g of report.flaky) {
      flakyFiles.push(g.file);
      for (const t of g.tests ?? []) flakyTests.push(`${g.file} › ${t.name}`);
    }
    if (report.retried) failedTwice += (report.failed ?? []).length;
  }
  return {
    runsWithReports: runs.size,
    runsWithFlaky: runsWithFlaky.size,
    occurrences: flakyFiles.length,
    failedTwice,
    byFile: countBy(flakyFiles),
    byTest: countBy(flakyTests)
  };
}

/**
 * Decide whether `main` requires the gate check. `protection` is the (admin-only) protection
 * endpoint result, `branch` the public branch summary, `rules` the public active-rules list.
 */
export function evaluateProtection({ protection, branch, rules, requiredCheck = GATE_CHECK }) {
  const contexts = new Set();
  let strict = null;
  let source;
  if (protection?.status === 200 && protection.body) {
    source = 'branch protection';
    const rsc = protection.body.required_status_checks;
    for (const c of rsc?.contexts ?? []) contexts.add(c);
    for (const c of rsc?.checks ?? []) contexts.add(c.context);
    strict = rsc?.strict ?? null;
  } else if (branch) {
    source = `branch summary (protection endpoint: HTTP ${protection?.status ?? 'n/a'})`;
    const rsc = branch.protection?.required_status_checks;
    for (const c of rsc?.contexts ?? []) contexts.add(c);
    for (const c of rsc?.checks ?? []) contexts.add(c.context);
  } else {
    source = `unavailable (protection endpoint: HTTP ${protection?.status ?? 'n/a'})`;
  }
  let rulesetRequires = false;
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (rule.type !== 'required_status_checks') continue;
    for (const c of rule.parameters?.required_status_checks ?? []) {
      contexts.add(c.context);
      if (c.context === requiredCheck) rulesetRequires = true;
    }
    if (rule.parameters?.strict_required_status_checks_policy) strict = true;
  }
  if (Array.isArray(rules)) source += ' + rulesets';
  const known = protection?.status === 200 || Boolean(branch) || Array.isArray(rules);
  const required = contexts.has(requiredCheck);
  return {
    checkedContext: requiredCheck,
    status: required ? 'required' : known ? 'not-required' : 'unknown',
    source,
    protectedBranch: protection?.status === 200 ? true : branch ? Boolean(branch.protected) : null,
    viaRuleset: rulesetRequires,
    strict,
    requiredChecks: [...contexts].sort()
  };
}

function pct(rate) {
  return rate == null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}

function tallyLine(label, t) {
  return `  ${label.padEnd(6)} ${pct(t.passRate).padStart(6)}  (pass ${t.pass}, fail ${t.fail}, cancelled/skipped ${t.neutral}, no gate job ${t.missing}; ${t.runs} runs)`;
}

export function renderText(report) {
  const { meta, aggregate, flaky, protection } = report;
  const lines = [];
  lines.push(`Release gate health — ${meta.repo}, workflow ${meta.workflow}, last ${meta.runs} completed runs (${meta.from ?? '?'} … ${meta.to ?? '?'})`);
  lines.push('', `Pass rate of "${meta.check ?? GATE_CHECK}" (pass / (pass + fail)):`);
  for (const scope of ['main', 'pr', 'other', 'all']) lines.push(tallyLine(scope, aggregate.byScope[scope]));
  lines.push('', 'Most failing gate jobs:');
  lines.push(...(aggregate.jobFailures.length ? aggregate.jobFailures.map((j) => `  ${j.count}× ${j.name}`) : ['  (none)']));
  lines.push('', 'Most failing gate steps:');
  lines.push(...(aggregate.stepFailures.length ? aggregate.stepFailures.map((j) => `  ${j.count}× ${j.name}`) : ['  (none)']));
  if (aggregate.failedRuns.length) {
    lines.push('', 'Failed gate runs:');
    for (const r of aggregate.failedRuns) lines.push(`  [${r.scope}] ${r.branch}: ${r.title} — ${r.url}`);
  }
  lines.push('', 'Flaky unit tests (from flaky-tests-* artifacts):');
  if (!flaky) lines.push('  (artifact download skipped)');
  else if (flaky.runsWithReports === 0) lines.push('  no flaky-tests artifacts in these runs yet');
  else {
    lines.push(
      `  ${flaky.occurrences} flaky file occurrence(s) in ${flaky.runsWithFlaky}/${flaky.runsWithReports} run(s) with reports; ${flaky.failedTwice} file(s) failed twice`
    );
    for (const f of flaky.byTest.slice(0, 10)) lines.push(`  ${f.count}× ${f.name}`);
  }
  lines.push('', `Branch protection on ${meta.branch}:`);
  const req = { required: 'yes', 'not-required': 'NO', unknown: 'unknown' }[protection.status];
  lines.push(`  "${protection.checkedContext ?? GATE_CHECK}" required: ${req}${protection.viaRuleset ? ' (via ruleset)' : ''}`);
  lines.push(`  protected: ${protection.protectedBranch ?? 'unknown'}; up-to-date required: ${protection.strict ?? 'unknown'}`);
  lines.push(`  required checks: ${protection.requiredChecks.length ? protection.requiredChecks.join(', ') : '(none)'}`);
  lines.push(`  source: ${protection.source}`);
  if (protection.status !== 'required') lines.push('  → see doc/CI.md「启用分支保护」');
  return lines.join('\n');
}
