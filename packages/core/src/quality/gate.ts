import type { SessionMessage } from '../types.js';

export interface QualityCheck { criterion: string; passed: boolean; evidence: string[] }
export interface QualityReport { passed: boolean; summary: string; checks: QualityCheck[]; sessionId?: string }
export const failedQuality = (summary: string): QualityReport => ({ passed: false, summary, checks: [] });

export function qualityCriteria(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

export function parseQualityReport(value: unknown): QualityReport | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as QualityReport;
  if (typeof r.passed !== 'boolean' || typeof r.summary !== 'string' || !r.summary.trim() || !Array.isArray(r.checks) || !r.checks.length) return undefined;
  for (const check of r.checks) {
    if (!check || typeof check.criterion !== 'string' || typeof check.passed !== 'boolean' || !Array.isArray(check.evidence)) return undefined;
    if (!check.evidence.length || !check.evidence.every(id => typeof id === 'string' && id.trim().length > 0)) return undefined;
  }
  return r;
}

export function qualityPassed(value: unknown): value is QualityReport {
  const report = parseQualityReport(value);
  return !!report && report.passed && report.checks.every(check => check.passed);
}

function successfulVerification(content: string): boolean {
  try {
    const verify = JSON.parse(content).verify;
    return verify?.exit_code === 0 && typeof verify.command === 'string' && verify.command.trim().length > 0 && !verify.signal;
  } catch { return false; }
}

function unresolvedTestFailure(messages: Pick<SessionMessage, 'parts'>[]): boolean {
  const latest = new Map<string, boolean>();
  for (const part of messages.flatMap(message => message.parts)) {
    if (part.type !== 'tool_result' || part.name !== 'work_evidence') continue;
    try {
      const verify = JSON.parse(part.content).verify;
      if (typeof verify?.command === 'string') latest.set(verify.command, part.ok && successfulVerification(part.content));
      else if (!part.ok) latest.set(part.toolCallId, false);
    } catch { if (!part.ok) latest.set(part.toolCallId, false); }
  }
  return [...latest.values()].some(passed => !passed);
}

/** Gateways may hide/remap call IDs; resolve human-readable receipts against persisted calls. */
function evidenceId(reference: string, messages: Pick<SessionMessage, 'parts'>[]): string {
  const calls = messages.flatMap(message => message.parts).filter(part => part.type === 'tool_call');
  const found = calls.findLast(call => {
    const selector = call.name === 'work_evidence' ? call.input.verify_command
      : call.name === 'grep_files' ? call.input.pattern : call.input.path;
    return typeof selector === 'string' && reference === `${call.name}:${selector}`;
  });
  return found?.toolCallId ?? reference;
}

/** Evidence IDs must resolve to this independent checker's actual successful tool results. */
export function validateQualityReport(input: {
  report: unknown; criteria: string[]; messages: Pick<SessionMessage, 'parts'>[];
  status: string; stage: 'review' | 'test';
}): QualityReport {
  if (!['completed', 'idle'].includes(input.status)) return failedQuality(`Checker unfinished: ${input.status}`);
  if (input.stage === 'test' && unresolvedTestFailure(input.messages)) return failedQuality('Unresolved failed test execution');
  const report = parseQualityReport(input.report);
  if (!report) return failedQuality('Missing or malformed structured quality report');
  const criteria = qualityCriteria(input.criteria);
  const reported = report.checks.map(check => check.criterion);
  if (reported.length !== criteria.length || new Set(reported).size !== criteria.length || criteria.some(c => !reported.includes(c))) return failedQuality('Quality report does not cover exactly all acceptance criteria');
  const results = new Map(input.messages.flatMap(message => message.parts).filter(part => part.type === 'tool_result').map(part => [part.toolCallId, part]));
  const checks = report.checks.map(check => ({ ...check, evidence: check.evidence.map(ref => evidenceId(ref, input.messages)) }));
  for (const check of checks) {
    for (const id of check.evidence) {
      const result = results.get(id);
      if (!result?.ok) return failedQuality(`Missing or failed evidence: ${id}`);
      if (input.stage === 'test' && (result.name !== 'work_evidence' || !successfulVerification(result.content))) return failedQuality(`No successful test execution for ${check.criterion}`);
    }
  }
  return { ...report, checks, passed: qualityPassed(report) };
}
