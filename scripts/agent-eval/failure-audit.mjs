/** Offline evidence audit. Never changes the suite, recorded calls, or grades. */
import { isDeepStrictEqual } from 'node:util';
import { gradeTask } from './quality.mjs';

function firstToolMismatch(expected, calls) {
  for (const [index, step] of (expected.toolPrefix ?? []).entries()) {
    const actual = calls[index] ?? null;
    const differs = Object.entries(step).some(([key, value]) => !isDeepStrictEqual(actual?.[key], value));
    if (differs) return { index, expected: step, actual };
  }
  return null;
}

function classification(trial, grade) {
  const sameLabels = isDeepStrictEqual([...(trial.failures ?? [])].sort(), [...grade.failures].sort());
  if (trial.pass !== grade.pass || !sameLabels) return 'grading_discrepancy';
  const harnessFailure = grade.failures.some(label => ['tools not offered', 'transcript invariants'].includes(label));
  if (trial.infrastructureError || trial.error || harnessFailure) return 'infrastructure';
  return grade.pass ? 'pass' : 'model_execution';
}

export function auditTrial(task, trial) {
  const grade = gradeTask(task, trial);
  const answerFailures = new Set(['exact final answer', 'JSON final answer', 'invalid JSON final answer']);
  const hasAnswerOracle = Object.hasOwn(task.expected, 'exact') || Object.hasOwn(task.expected, 'json');
  return {
    classification: classification(trial, grade),
    pass: grade.pass,
    failures: grade.failures,
    finalAnswerCorrect: hasAnswerOracle ? !grade.failures.some(failure => answerFailures.has(failure)) : null,
    firstToolMismatch: firstToolMismatch(task.expected, trial.toolCalls ?? []),
  };
}
