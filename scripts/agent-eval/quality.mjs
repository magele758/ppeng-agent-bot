/** Objective graders and paired, per-task reliability comparisons. No LLM self-grading. */
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { gradeBotEvidence } from './bot-quality.mjs';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const plainObject = value => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
function isValidToolPrefix(prefix) {
  if (!Array.isArray(prefix) || prefix.length === 0) return false;
  return prefix.every(step => {
    if (!plainObject(step)) return false;
    if (Object.keys(step).some(key => key !== 'name' && key !== 'input' && key !== 'ok')) return false;
    if (typeof step.name !== 'string' || step.name.length === 0) return false;
    if (Object.hasOwn(step, 'input') && !plainObject(step.input)) return false;
    if (Object.hasOwn(step, 'ok') && typeof step.ok !== 'boolean') return false;
    return true;
  });
}
export const DEFAULT_POLICY = {
  minCases: 30, minTrials: 3, minBaselinePassRate: 0.8,
  nonInferiorityMargin: 0.05, maxCategoryDrop: 0.05,
  maxTokenRatio: 1.2, maxLatencyRatio: 1.5, requireUsage: true
};

export function validateSuite(suite) {
  if (!Array.isArray(suite) || suite.length === 0) throw new Error('quality suite must be a non-empty array');
  const ids = new Set();
  for (const c of suite) {
    if (typeof c.id !== 'string' || !/^[a-z0-9_-]+$/.test(c.id) || ids.has(c.id)) throw new Error('case IDs must be unique safe strings');
    ids.add(c.id);
    if (!c.category || !Array.isArray(c.turns) || !c.turns.length || c.turns.some(x => typeof x !== 'string' || !x.trim())) throw new Error(`invalid task: ${c.id}`);
    if (!c.expected || !['exact', 'json', 'state'].some(key => Object.hasOwn(c.expected, key))) throw new Error(`case has no outcome grader: ${c.id}`);
    for (const key of Object.keys(c.expected)) {
      if (!['exact', 'json', 'state', 'requiredTools', 'forbiddenTools', 'maxToolCalls', 'status', 'botEvidence','observedTools','toolPrefix','rounds','currentGoalOnly'].includes(key)) throw new Error(`unknown grader ${key}`);
    }
    if (c.expected.rounds !== undefined && (!Array.isArray(c.expected.rounds) || c.expected.rounds.length !== c.turns.length || c.expected.rounds.some(answer => typeof answer !== 'string' || !answer.trim()))) throw new Error(`expected one answer per turn: ${c.id}`);
    if (c.expected.exact != null && typeof c.expected.exact !== 'string') throw new Error(`exact grader must be text: ${c.id}`);
    if (Object.hasOwn(c.expected, 'toolPrefix') && !isValidToolPrefix(c.expected.toolPrefix)) throw new Error(`invalid tool prefix: ${c.id}`);
  }
  return suite;
}

/** Opening calls must match name, and any declared input or ok. Calls after the prefix are allowed. */
export function gradeToolPrefix(prefix, calls) {
  const failures = [];
  const seen = Array.isArray(calls) ? calls : [];
  if (seen.length < prefix.length) failures.push('tool prefix short');
  for (let i = 0; i < prefix.length; i++) {
    const step = prefix[i];
    const call = seen[i];
    if (!call || call.name !== step.name) failures.push('tool prefix order');
    if (call && Object.hasOwn(step, 'input') && !isDeepStrictEqual(call.input, step.input)) failures.push('tool prefix input');
    if (call && Object.hasOwn(step, 'ok') && call.ok !== step.ok) failures.push('tool prefix result');
  }
  return failures;
}

/** Recorded prompt shapes that omit a needed tool invalidate the trial. Missing shapes are not graded. */
export function gradeOfferedTools(expected, trial) {
  const shapes = trial?.promptShapes;
  if (!Array.isArray(shapes) || shapes.length === 0) return [];
  const prefixNames = Array.isArray(expected.toolPrefix) ? expected.toolPrefix.map(step => step.name) : [];
  const needed = [...(expected.requiredTools ?? []), ...prefixNames];
  const offered = new Set(shapes.flatMap(shape => Array.isArray(shape?.tools) ? shape.tools : []));
  return needed.some(name => !offered.has(name)) ? ['tools not offered'] : [];
}

/** Accept folded messages: grade only the final assistant's text, never its reasoning. */
export function finalAssistantOutput(messages) {
  const assistant = messages.findLast(message => message.role === 'assistant');
  return assistant?.parts.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? '';
}

/** Drop one leading harness written-at line. The model was not asked to emit it. */
export function modelAnswer(output) {
  return String(output ?? '').replace(/^\[written \d{4}-\d{2}-\d{2} \d{2}:\d{2} [^\]\n]+\]\n?/, '').trim();
}

function gradeTurnAnswers(task, trial) {
  const failures = [];
  for (const [i, expected] of (task.expected.rounds ?? []).entries()) {
    if (modelAnswer(trial.rounds?.[i]) !== expected) failures.push(`turn ${i + 1} answer`);
    if (task.expected.currentGoalOnly && !trial.reviewGoals?.[i]?.every(goal => typeof goal === 'string' && goal && task.turns[i].includes(goal))) failures.push(`turn ${i + 1} review ownership`);
  }
  return failures;
}

export function gradeTask(task, trial) {
  const failures = [];
  const e = task.expected;
  const answer = modelAnswer(trial.output);
  if (trial.error) failures.push(`execution: ${trial.error}`);
  if (trial.infrastructureError) failures.push('infrastructure failure');
  if (trial.status !== (e.status ?? 'idle')) failures.push(`terminal status: ${trial.status}`);
  if (trial.invariantsOk !== true) failures.push('transcript invariants');
  if (Object.hasOwn(e, 'exact') && answer !== e.exact) failures.push('exact final answer');
  failures.push(...gradeTurnAnswers(task, trial));
  if (Object.hasOwn(e, 'json')) {
    try { if (!isDeepStrictEqual(JSON.parse(answer), e.json)) failures.push('JSON final answer'); }
    catch { failures.push('invalid JSON final answer'); }
  }
  if (Object.hasOwn(e, 'state') && !isDeepStrictEqual(trial.state, e.state)) failures.push('actual tool side effects');
  const calls = trial.toolCalls ?? [];
  for(const observation of e.observedTools??[])if(!calls.some(call=>Object.entries(observation).every(([key,value])=>isDeepStrictEqual(call[key],value))))failures.push('missing recorded observation: '+observation.name);
  for (const name of e.requiredTools ?? []) if (!calls.some(c => c.name === name && c.ok === true)) failures.push(`missing successful tool: ${name}`);
  for (const name of e.forbiddenTools ?? []) if (calls.some(c => c.name === name)) failures.push(`forbidden tool: ${name}`);
  if (e.maxToolCalls != null && calls.length > e.maxToolCalls) failures.push('tool call budget');
  if(e.botEvidence) failures.push(...gradeBotEvidence(e.botEvidence,trial.botEvidence).failures);
  if (Array.isArray(e.toolPrefix)) failures.push(...gradeToolPrefix(e.toolPrefix, calls));
  failures.push(...gradeOfferedTools(e, trial));
  return { pass: failures.length === 0, failures };
}

const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

// Approximate normal CDF, inverted to choose Bonferroni-adjusted Wilson intervals.
function normalCdf(x) {
  const z = Math.abs(x), t = 1 / (1 + 0.2316419 * z);
  const p = 1 - Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI) * t *
    (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? p : 1 - p;
}
function normalQuantile(p) {
  let low = 0, high = 10;
  for (let i = 0; i < 80; i++) { const mid = (low + high) / 2; if (normalCdf(mid) < p) low = mid; else high = mid; }
  return (low + high) / 2;
}
function wilson(successes, total, z) {
  const p = successes / total, z2 = z * z, denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const radius = z * Math.sqrt(p * (1 - p) / total + z2 / (4 * total * total)) / denominator;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}

/** Repeats are NOT counted as independent tasks. Primary metric is pass-all-trials per case. */
export function pairedSummary(pairs, familyComparisons = 1) {
  if (!pairs.length) return null;
  const wins = pairs.filter(p => !p.baselineReliable && p.candidateReliable).length;
  const losses = pairs.filter(p => p.baselineReliable && !p.candidateReliable).length;
  const z = normalQuantile(1 - 0.05 / (4 * familyComparisons));
  const winCI = wilson(wins, pairs.length, z), lossCI = wilson(losses, pairs.length, z);
  return {
    tasks: pairs.length, wins, losses,
    baselinePassRate: mean(pairs.map(p => p.baselineRate)),
    candidatePassRate: mean(pairs.map(p => p.candidateRate)),
    baselineReliableRate: mean(pairs.map(p => Number(p.baselineReliable))),
    candidateReliableRate: mean(pairs.map(p => Number(p.candidateReliable))),
    reliabilityDelta: (wins - losses) / pairs.length,
    deltaInterval: [winCI[0] - lossCI[1], winCI[1] - lossCI[0]],
    intervalMethod: 'approximate Wilson-Bonferroni, task-level pass-all-trials; not a guarantee outside this suite'
  };
}

function checkedPolicy(overrides) {
  const policy = { ...DEFAULT_POLICY, ...overrides };
  for (const key of Object.keys(overrides)) if (!(key in DEFAULT_POLICY)) throw new Error(`unknown policy ${key}`);
  for (const key of ['minCases', 'minTrials']) if (!Number.isInteger(policy[key]) || policy[key] < 1) throw new Error(`invalid ${key}`);
  for (const key of ['minBaselinePassRate', 'nonInferiorityMargin', 'maxCategoryDrop']) if (!Number.isFinite(policy[key]) || policy[key] < 0 || policy[key] > 1) throw new Error(`invalid ${key}`);
  for (const key of ['maxTokenRatio', 'maxLatencyRatio']) if (!Number.isFinite(policy[key]) || policy[key] <= 0) throw new Error(`invalid ${key}`);
  if (typeof policy.requireUsage !== 'boolean') throw new Error('invalid requireUsage');
  return policy;
}

function recordFaults(record, suite, trials, seen) {
  const key = `${record.caseId}/${record.trial}/${record.variant}`;
  const faults = [];
  if (seen.has(key) || !['baseline', 'candidate'].includes(record.variant) || !suite.some(c => c.id === record.caseId) || !Number.isInteger(record.trial) || record.trial < 0 || record.trial >= trials) faults.push(`invalid/duplicate record: ${key}`);
  seen.add(key);
  if (record.infrastructureError) faults.push(`infrastructure: ${key}`);
  if (typeof record.pass !== 'boolean') faults.push(`missing grade: ${key}`);
  if (Array.isArray(record.failures) && record.failures.includes('tools not offered')) faults.push(`tools not offered: ${key}`);
  return faults;
}

function pairCase(task, records, trials) {
  const rows = records.filter(r => r.caseId === task.id);
  const baseline = rows.filter(r => r.variant === 'baseline'), candidate = rows.filter(r => r.variant === 'candidate');
  if (baseline.length !== trials || candidate.length !== trials) return { invalid: `missing trials: ${task.id}` };
  const b = baseline.filter(r => r.pass).length / trials, a = candidate.filter(r => r.pass).length / trials;
  const pair = { id: task.id, category: task.category, baselineRate: b, candidateRate: a, baselineReliable: b === 1, candidateReliable: a === 1 };
  if (!(task.critical && candidate.some(r => !r.pass))) return { pair };
  if (b === 1) return { pair, regression: `critical task regressed: ${task.id}` };
  return { pair, blocker: `critical task fails in the candidate (baseline also imperfect): ${task.id}` };
}

function sampleSizeFindings(suiteLength, trials, policy) {
  const uncertain = [];
  if (suiteLength < policy.minCases) uncertain.push(`only ${suiteLength} distinct tasks; need ${policy.minCases}`);
  if (trials < policy.minTrials) uncertain.push(`only ${trials} trials; need ${policy.minTrials}`);
  return uncertain;
}

function rateFindings(summary, byCategory, policy) {
  const regressions = [], uncertain = [];
  if (summary && summary.baselinePassRate < policy.minBaselinePassRate) uncertain.push('baseline floor not met; first calibrate tasks/grader/model');
  if (summary && summary.candidatePassRate < summary.baselinePassRate - policy.nonInferiorityMargin) regressions.push('overall observed success rate regression');
  if (summary && summary.deltaInterval[0] < -policy.nonInferiorityMargin) uncertain.push('overall non-inferiority not established');
  for (const [category, s] of Object.entries(byCategory)) if (s) {
    if (s.candidatePassRate < s.baselinePassRate - policy.maxCategoryDrop) regressions.push(`category regression: ${category}`);
    if (s.deltaInterval[0] < -policy.maxCategoryDrop) uncertain.push(`category non-inferiority not established: ${category}`);
  }
  return { regressions, uncertain };
}

function metricBudgets(records, policy) {
  const metrics = {}, regressions = [], uncertain = [];
  for (const [field, cap] of [['tokens', policy.maxTokenRatio], ['durationMs', policy.maxLatencyRatio]]) {
    const b = records.filter(r => r.variant === 'baseline'), a = records.filter(r => r.variant === 'candidate');
    if (!records.length || records.some(r => !Number.isFinite(r[field]) || r[field] < 0)) {
      metrics[field] = { available: false };
      if (field !== 'tokens' || policy.requireUsage) uncertain.push(`missing ${field} telemetry`);
      continue;
    }
    const baseline = mean(b.map(r => r[field])), candidate = mean(a.map(r => r[field]));
    const ratio = baseline > 0 ? candidate / baseline : candidate === 0 ? 1 : null;
    metrics[field] = { available: true, baseline, candidate, ratio, cap };
    if (ratio == null || ratio > cap) regressions.push(`${field} budget regression`);
  }
  return { metrics, regressions, uncertain };
}

function qualityVerdict(summary, lists) {
  if (lists.invalid.length) return 'invalid';
  if (lists.regressions.length) return 'regressed';
  if (lists.blockers.length) return 'blocked';
  if (lists.uncertain.length) return 'inconclusive';
  if (summary.deltaInterval[0] > 0) return 'improved';
  return 'non_inferior';
}

export function compareQuality(suite, records, { trials, policy: overrides = {}, simulation = false } = {}) {
  validateSuite(suite);
  if (!Number.isInteger(trials) || trials < 1) throw new Error('trials must be a positive integer');
  const policy = checkedPolicy(overrides);
  const invalid = [], regressions = [], blockers = [], pairs = [];
  const seen = new Set();
  for (const record of records) invalid.push(...recordFaults(record, suite, trials, seen));
  for (const task of suite) {
    const row = pairCase(task, records, trials);
    if (row.invalid) { invalid.push(row.invalid); continue; }
    pairs.push(row.pair);
    if (row.regression) regressions.push(row.regression);
    if (row.blocker) blockers.push(row.blocker);
  }
  const categories = [...new Set(suite.map(c => c.category))];
  const family = categories.length + 1;
  const summary = pairedSummary(pairs, family);
  const byCategory = Object.fromEntries(categories.map(category => [category, pairedSummary(pairs.filter(p => p.category === category), family)]));
  const rates = rateFindings(summary, byCategory, policy);
  const budget = metricBudgets(records, policy);
  const uncertain = [...sampleSizeFindings(suite.length, trials, policy), ...rates.uncertain, ...budget.uncertain];
  regressions.push(...rates.regressions, ...budget.regressions);
  const verdict = qualityVerdict(summary, { invalid, regressions, blockers, uncertain });
  return { schemaVersion: 1, evaluationKind: simulation ? 'simulation' : 'live', verdict,
    promotionEligible: !simulation && ['improved', 'non_inferior'].includes(verdict),
    invalid, regressions, blockers, uncertain, policy, summary, byCategory, metrics: budget.metrics, pairs };
}
