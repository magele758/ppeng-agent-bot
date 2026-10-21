/** Display-only defense. Authorization and actual arguments remain server-owned. */
function sanitized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitized);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key, /password|secret|token|api.?key|authorization|cookie|private.?key/i.test(key) ? '[REDACTED]' : sanitized(entry),
    ]));
  }
  return value;
}

export function approvalPreview(args: Record<string, unknown> | undefined) {
  const details = sanitized(args ?? {}) as Record<string, unknown>;
  const first = (keys: string[]): string | null => {
    for (const key of keys) if (typeof details[key] === 'string' && details[key]) return details[key] as string;
    return null;
  };
  return {
    target: first(['receiveId', 'recipient', 'to', 'botId', 'roomId', 'sessionId', 'path', 'url', 'id']),
    content: first(['text', 'message', 'body']),
    details,
  };
}
