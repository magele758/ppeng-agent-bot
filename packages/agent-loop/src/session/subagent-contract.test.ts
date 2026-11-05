import { describe, expect, it } from 'vitest';
import { formatSubagentSummary } from './subagent-contract.js';

describe('formatSubagentSummary', () => {
  it('sets truncated without changing the summary into a failure', () => {
    const summary = formatSubagentSummary({
      text: 'x'.repeat(100),
      sessionId: 'sub1',
      summaryMaxChars: 20
    });
    expect(summary.truncated).toBe(true);
    expect(summary.text).toContain('…[truncated]');
    expect(summary).not.toHaveProperty('ok');
  });

  it('omits truncated when the text fits', () => {
    const summary = formatSubagentSummary({ text: 'short', sessionId: 'sub1' });
    expect(summary.truncated).toBeUndefined();
    expect(summary.text).toBe('short');
  });
});
