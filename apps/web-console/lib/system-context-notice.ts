const HEADINGS = { Goal: 'goal', Constraints: 'constraints', Progress: 'progress', Decisions: 'decisions', Files: 'files', 'Next steps': 'nextSteps' } as const;
export type ContextSection = { id: typeof HEADINGS[keyof typeof HEADINGS]; body: string };
export type SystemContextNotice =
  | { kind: 'summary'; sections: ContextSection[]; raw: string }
  | { kind: 'jev'; action: 'need_tools' | 'retry' | 'done' | 'unknown'; score?: string; raw: string };

/** Presentation only: callers must restrict this to system messages outside model view. */
export function parseSystemContextNotice(raw: string): SystemContextNotice | null {
  const text = raw.trim();
  if (/^\[jev-[a-z-]+\](?:\s|$)/.test(text)) {
    const route = text.match(/^\[jev-route\]\s+(?:Achieved:\s+)?jev-route (need_tools|retry|done) noul (0(?:\.\d+)?|1(?:\.0+)?)(?:\. Continue working\.)?$/);
    return { kind: 'jev', action: route ? route[1] as 'need_tools' | 'retry' | 'done' : 'unknown', ...(route ? { score: route[2] } : {}), raw };
  }
  const sections: ContextSection[] = [];
  let current: ContextSection | undefined;
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && /^History source:/.test(line)) break;
    const heading = !fenced ? line.match(/^(?:#{1,6}\s+)?(?:\*\*)?(Goal|Constraints|Progress|Decisions|Files|Next steps)(?:\*\*)?:?\s*$/) : null;
    if (heading) {
      if (!current && heading[1] !== 'Goal') return null;
      current = { id: HEADINGS[heading[1] as keyof typeof HEADINGS], body: '' };
      sections.push(current);
    } else if (current) {
      current.body += line + '\n';
    } else if (line.trim()) return null;
  }
  if (!sections.some(s => s.id === 'constraints') || sections.length < 2 || !sections[0]?.body.trim()) return null;
  return { kind: 'summary', sections: sections.map(s => ({ ...s, body: s.body.trim() })), raw };
}
