import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeExecutionLog, attachExecutionFindings } from '../src/stores/analyze-execution-log.ts';
import { resolveSkillLoad } from '../dist/runtime/skill-load.js';

describe('execution log findings', () => {
  it('lists model errors, truncation, and recovery stops from the log alone [AC:execution-log-analysis#AC-2]', () => {
    const findings = analyzeExecutionLog([
      { ts: '2026-11-04T00:00:00.000Z', sessionId: 's1', kind: 'turn_start', payload: { turn: 1 } },
      { ts: '2026-11-04T00:00:01.000Z', sessionId: 's1', kind: 'model_error', payload: { message: 'upstream 503' } },
      { ts: '2026-11-04T00:00:02.000Z', sessionId: 's1', kind: 'turn_truncated', payload: {} },
      { ts: '2026-11-04T00:00:03.000Z', sessionId: 's1', kind: 'turn_end', payload: { stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } },
      { ts: '2026-11-04T00:00:04.000Z', sessionId: 's1', kind: 'repetition_abort', payload: { reason: 'char_run' } },
    ]);
    assert.deepEqual(findings.map((finding) => finding.code), ['model_error', 'truncated', 'recovery_stop']);
    assert.equal(findings[0]?.message, 'Model error: upstream 503');
    assert.ok(findings.every((finding) => finding.ts && finding.message));
  });

  it('points a failed unknown tool at its call id [AC:execution-log-analysis#AC-4]', () => {
    const findings = analyzeExecutionLog([
      {
        ts: '2026-11-04T00:00:01.000Z',
        sessionId: 's1',
        kind: 'tool_end',
        payload: { name: 'nope', ok: false, toolCallId: 'nope-1', ran: false, code: 'UNKNOWN_TOOL' },
      },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.code, 'tool_failed');
    assert.equal(findings[0]?.toolCallId, 'nope-1');
    assert.match(findings[0]?.message ?? '', /UNKNOWN_TOOL/);
  });

  it('treats a held call as waiting, not a lost start [AC:execution-log-analysis#AC-5]', () => {
    const findings = analyzeExecutionLog([
      { ts: '2026-11-04T00:00:00.000Z', kind: 'turn_start', payload: { turn: 0 } },
      { ts: '2026-11-04T00:00:01.000Z', kind: 'tool_start', payload: { name: 'bash', toolCallId: 'bash-wait' } },
      {
        ts: '2026-11-04T00:00:02.000Z',
        kind: 'tool_end',
        payload: { name: 'bash', ok: false, toolCallId: 'bash-wait', ran: false, hold: 'approval' },
      },
      {
        ts: '2026-11-04T00:00:03.000Z',
        kind: 'turn_end',
        payload: { terminal: true, reason: 'waiting_approval' },
      },
    ]);
    assert.deepEqual(findings.map((finding) => finding.code), ['waiting_approval']);
    assert.equal(findings[0]?.toolCallId, 'bash-wait');
  });

  it('returns the problem list with the execution log [AC:execution-log-analysis#AC-6]', () => {
    const page = attachExecutionFindings({
      sessionId: 's1',
      omittedEarlier: 0,
      events: [
        {
          ts: '2026-11-04T00:00:01.000Z',
          kind: 'tool_end',
          payload: { name: 'bash', ok: false, toolCallId: 'bash-bad', code: 'EXIT_127' },
        },
      ],
    });
    assert.equal(page.events.length, 1);
    assert.equal(page.findings[0]?.toolCallId, 'bash-bad');
    assert.equal(page.findings[0]?.code, 'tool_failed');
  });
});

describe('skill load execution log', () => {
  it('records a missing or ambiguous skill load [AC:execution-log-analysis#AC-3]', async () => {
    const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
    const host = {
      promptBuilder: {
        skillsForSession: async () => [],
      },
      emitTrace(_sessionId: string, event: { kind: string; payload?: Record<string, unknown> }) {
        events.push(event);
      },
    };
    const missing = await resolveSkillLoad(host as never, 'missing-skill', 's1');
    assert.match(missing.error ?? '', /not found/);
    assert.deepEqual(events[0], {
      kind: 'skill_load',
      payload: { name: 'missing-skill', rejected: true, reason: 'not_found' },
    });

    events.length = 0;
    const ambiguous = await resolveSkillLoad({
      ...host,
      promptBuilder: {
        skillsForSession: async () => [
          { name: 'dup', id: 'a', content: 'one' },
          { name: 'dup', id: 'b', content: 'two' },
        ],
      },
    } as never, 'dup', 's1');
    assert.match(ambiguous.error ?? '', /Ambiguous/);
    assert.equal(events[0]?.payload?.reason, 'ambiguous');
    assert.equal(events[0]?.payload?.name, 'dup');
  });
});
