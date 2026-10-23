export type SystemMessageKind = 'recovery' | 'stopped' | 'fallback' | 'goal' | 'compact' | 'hook' | 'collaboration' | 'access' | 'context' | 'generic';
/** Classify explicit producer markers only; free-form text does not establish a status. */
export function classifySystemMessage(raw: string): { kind: SystemMessageKind; warning: boolean; raw: string } {
  const tag = raw.trimStart().match(/^\[([^\]\r\n]+)\]/)?.[1] ?? '';
  let kind: SystemMessageKind = 'generic';
  if (tag === 'recovery' && /^\[recovery\]\s+Stopped:/.test(raw.trimStart())) kind = 'stopped';
  else if (['recovery', 'recovery-advisory', 'recovery:unknown', 'self-heal'].includes(tag)) kind = 'recovery';
  else if (tag === 'model-fallback') kind = 'fallback';
  else if (/^goal(?:\s|$)/.test(tag)) kind = 'goal';
  else if (['pre-compact', 'on-compact'].includes(tag)) kind = 'compact';
  else if (['stop-hook', 'stop-extension'].includes(tag)) kind = 'hook';
  else if (['bot-help', 'team-dag'].includes(tag)) kind = 'collaboration';
  else if (['command-hardline', 'sharing-domain-changed'].includes(tag) || tag.startsWith('os-sandbox:')) kind = 'access';
  else if (['explicit-shared-context', 'skill-review reminder'].includes(tag) || tag.startsWith('routine-context ')) kind = 'context';
  return { kind, warning: kind === 'stopped' || tag === 'recovery:unknown' || tag === 'command-hardline', raw };
}
