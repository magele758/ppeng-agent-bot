import { describe, expect, it } from 'vitest';
import { AdvisoryGrace, formatRecoveryAdvisory } from './advisory-grace.js';
import { formatRiskAdvisory } from './risk-engine.js';

describe('recovery advisory wording', () => {
  it('asks for a change of strategy first and the user only as a last resort [AC:bot-finish-follow-through#AC-16]', () => {
    const text = formatRecoveryAdvisory('same tool call repeated');
    expect(text).toContain('change strategy first');
    expect(text).toContain('Ask the user only when the blocker is something only they can resolve');
    expect(text).not.toMatch(/, or ask the user\)/);
    expect(text.indexOf('change strategy')).toBeLessThan(text.indexOf('Ask the user'));
  });

  it('injects that wording when the loop guard spends its grace turn [AC:bot-finish-follow-through#AC-16]', () => {
    const grace = new AdvisoryGrace(1);
    const outcome = grace.apply({ abort: true, reason: 'tool failures' });
    expect(outcome.action).toBe('advise');
    expect(outcome.action === 'advise' ? outcome.advisory : '').toContain('Ask the user only when');
    expect(grace.apply({ abort: true, reason: 'tool failures' }).action).toBe('abort');
  });

  it('uses the same order in the multi-signal risk advisory [AC:bot-finish-follow-through#AC-16]', () => {
    const text = formatRiskAdvisory([{ type: 'tool_failures', magnitude: 3 } as never]);
    expect(text).toContain('Change strategy first');
    expect(text).toContain('Ask the user only when');
  });
});
