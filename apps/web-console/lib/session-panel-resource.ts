/** An old panel's success or failure must never replace the newly selected panel. */
export async function loadSessionPanelResource<T>(load: () => Promise<T>, current: () => boolean, apply: (value: T) => void, fallback: T): Promise<void> {
  let value: T;
  try { value = await load(); } catch { value = fallback; }
  if (current()) apply(value);
}

export function transcriptModelView<T extends readonly unknown[]>(bound: boolean, enabled: boolean, modelView: T | undefined, messages: T): T {
  return bound && enabled && modelView ? modelView : messages;
}
