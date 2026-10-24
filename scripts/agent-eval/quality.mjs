/** Objective graders and paired, per-task reliability comparisons. No LLM self-grading. */
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { gradeBotEvidence } from './bot-quality.mjs';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
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
      if (!['exact', 'json', 'state', 'requiredTools', 'forbiddenTools', 'maxToolCalls', 'status', 'botEvidence','observedTools'].includes(key)) throw new Error(`unknown grader ${key}`);
    }
    if (c.expected.exact != null && typeof c.expected.exact !== 'string') throw new Error(`exact grader must be text: ${c.id}`);
  }
  return suite;
}

/** Accept folded messages: grade only the final assistant's text, never its reasoning. */
export function finalAssistantOutput(messages) {
  const assistant = messages.findLast(message => message.role === 'assistant');
  return assistant?.parts.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? '';
}

export function gradeTask(task, trial) {
  const failures = [];
  const e = task.expected;
  if (trial.error) failures.push(`execution: ${trial.error}`);
  if (trial.infrastructureError) failures.push('infrastructure failure');
  if (trial.status !== (e.status ?? 'idle')) failures.push(`terminal status: ${trial.status}`);
  if (trial.invariantsOk !== true) failures.push('transcript invariants');
  if (Object.hasOwn(e, 'exact') && trial.output?.trim() !== e.exact) failures.push('exact final answer');
  if (Object.hasOwn(e, 'json')) {
    try { if (!isDeepStrictEqual(JSON.parse(trial.output), e.json)) failures.push('JSON final answer'); }
    catch { failures.push('invalid JSON final answer'); }
  }
  if (Object.hasOwn(e, 'state') && !isDeepStrictEqual(trial.state, e.state)) failures.push('actual tool side effects');
  const calls = trial.toolCalls ?? [];
  for(const observation of e.observedTools??[])if(!calls.some(call=>Object.entries(observation).every(([key,value])=>isDeepStrictEqual(call[key],value))))failures.push('missing recorded observation: '+observation.name);
  for (const name of e.requiredTools ?? []) if (!calls.some(c => c.name === name && c.ok === true)) failures.push(`missing successful tool: ${name}`);
  for (const name of e.forbiddenTools ?? []) if (calls.some(c => c.name === name)) failures.push(`forbidden tool: ${name}`);
  if (e.maxToolCalls != null && calls.length > e.maxToolCalls) failures.push('tool call budget');
  if(e.botEvidence) failures.push(...gradeBotEvidence(e.botEvidence,trial.botEvidence).failures);
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

export function compareQuality(suite, records, { trials, policy: overrides = {}, simulation = false } = {}) {
  validateSuite(suite);
  const policy = { ...DEFAULT_POLICY, ...overrides };
  if (!Number.isInteger(trials) || trials < 1) throw new Error('trials must be a positive integer');
  for (const key of Object.keys(overrides)) if (!(key in DEFAULT_POLICY)) throw new Error(`unknown policy ${key}`);
  for (const key of ['minCases', 'minTrials']) if (!Number.isInteger(policy[key]) || policy[key] < 1) throw new Error(`invalid ${key}`);
  for (const key of ['minBaselinePassRate', 'nonInferiorityMargin', 'maxCategoryDrop']) if (!Number.isFinite(policy[key]) || policy[key] < 0 || policy[key] > 1) throw new Error(`invalid ${key}`);
  for (const key of ['maxTokenRatio', 'maxLatencyRatio']) if (!Number.isFinite(policy[key]) || policy[key] <= 0) throw new Error(`invalid ${key}`);
  if (typeof policy.requireUsage !== 'boolean') throw new Error('invalid requireUsage');
  const invalid = [], regressions = [], blockers = [], uncertain = [], pairs = [];
  const seen = new Set();
  for (const r of records) {
    const key = `${r.caseId}/${r.trial}/${r.variant}`;
    if (seen.has(key) || !['baseline', 'candidate'].includes(r.variant) || !suite.some(c => c.id === r.caseId) || !Number.isInteger(r.trial) || r.trial < 0 || r.trial >= trials) invalid.push(`invalid/duplicate record: ${key}`);
    seen.add(key);
    if (r.infrastructureError) invalid.push(`infrastructure: ${key}`);
    if (typeof r.pass !== 'boolean') invalid.push(`missing grade: ${key}`);
  }
  for (const c of suite) {
    const rows = records.filter(r => r.caseId === c.id);
    const baseline = rows.filter(r => r.variant === 'baseline'), candidate = rows.filter(r => r.variant === 'candidate');
    if (baseline.length !== trials || candidate.length !== trials) { invalid.push(`missing trials: ${c.id}`); continue; }
    const b = baseline.filter(r => r.pass).length / trials, a = candidate.filter(r => r.pass).length / trials;
    pairs.push({ id: c.id, category: c.category, baselineRate: b, candidateRate: a, baselineReliable: b === 1, candidateReliable: a === 1 });
    if (c.critical && candidate.some(r => !r.pass)) {
      if (b === 1) regressions.push(`critical task regressed: ${c.id}`);
      else blockers.push(`critical task fails in the candidate (baseline also imperfect): ${c.id}`);
    }
  }
  const categories = [...new Set(suite.map(c => c.category))];
  const summary = pairedSummary(pairs, categories.length + 1);
  const byCategory = Object.fromEntries(categories.map(category => [category, pairedSummary(pairs.filter(p => p.category === category), categories.length + 1)]));
  if (suite.length < policy.minCases) uncertain.push(`only ${suite.length} distinct tasks; need ${policy.minCases}`);
  if (trials < policy.minTrials) uncertain.push(`only ${trials} trials; need ${policy.minTrials}`);
  if (summary && summary.baselinePassRate < policy.minBaselinePassRate) uncertain.push('baseline floor not met; first calibrate tasks/grader/model');
  if (summary) {
    if (summary.candidatePassRate < summary.baselinePassRate - policy.nonInferiorityMargin) regressions.push('overall observed success rate regression');
    if (summary.deltaInterval[0] < -policy.nonInferiorityMargin) uncertain.push('overall non-inferiority not established');
  }
  for (const [category, s] of Object.entries(byCategory)) if (s) {
    if (s.candidatePassRate < s.baselinePassRate - policy.maxCategoryDrop) regressions.push(`category regression: ${category}`);
    if (s.deltaInterval[0] < -policy.maxCategoryDrop) uncertain.push(`category non-inferiority not established: ${category}`);
  }
  const metrics = {};
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
  const verdict = invalid.length ? 'invalid' : regressions.length ? 'regressed' : blockers.length ? 'blocked' : uncertain.length ? 'inconclusive'
    : summary.deltaInterval[0] > 0 ? 'improved' : 'non_inferior';
  return { schemaVersion: 1, evaluationKind: simulation ? 'simulation' : 'live', verdict,
    promotionEligible: !simulation && ['improved', 'non_inferior'].includes(verdict),
    invalid, regressions, blockers, uncertain, policy, summary, byCategory, metrics, pairs };
}
