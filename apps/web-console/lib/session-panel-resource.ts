/** An old panel's success or failure must never replace the newly selected panel. */
export async function loadSessionPanelResource<T>(load: () => Promise<T>, current: () => boolean, apply: (value: T) => void, fallback: T): Promise<void> {
  let value: T;
  try { value = await load(); } catch { value = fallback; }
  if (current()) apply(value);
}

function isCompactSummary(message: unknown): boolean {
  return typeof message === 'object' && message !== null && 'key' in message && message.key === 'compact-summary';
}

export function transcriptModelView<T>(bound: boolean, enabled: boolean, modelView: T[] | undefined, messages: T[]): T[] {
  if (bound && enabled && modelView) return modelView;
  return messages.some(isCompactSummary) ? messages.filter(message => !isCompactSummary(message)) : messages;
}
