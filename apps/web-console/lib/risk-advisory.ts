const SIGNALS = ['iteration_near_limit', 'budget_high', 'tool_error_streak', 'tool_repeat', 'output_repeat'] as const;
export type RiskSignal = typeof SIGNALS[number] | 'unknown';
export interface RiskAdvisory {
  severity: 'info' | 'warning';
  signals: RiskSignal[];
  raw: string;
}
/** Only callers rendering system messages should use this presentation parser. */
export function parseRiskAdvisory(text: string): RiskAdvisory | null {
  if (!/^\[risk-advisory\](?:\r?\n|$)/.test(text.trimStart())) return null;
  const signals: RiskSignal[] = [];
  for (const match of text.matchAll(/^- ([a-z_]+) \(magnitude=[^\r\n)]*\)/gm)) {
    const signal = SIGNALS.find(s => s === match[1]) ?? 'unknown';
    if (!signals.includes(signal)) signals.push(signal);
  }
  if (!signals.length) signals.push('unknown');
  return {
    severity: signals.some(s => s === 'tool_error_streak' || s === 'tool_repeat' || s === 'output_repeat') ? 'warning' : 'info',
    signals,
    raw: text
  };
}
