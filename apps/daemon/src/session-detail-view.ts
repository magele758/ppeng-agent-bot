/**
 * Run logs kept inside session metadata. They grow with every step (megabytes on
 * long chats) and the console reads them through `/api/sessions/:id/trajectory`,
 * never through the session itself.
 */
const INTERNAL_LOG_KEYS = ['eventLog', 'stepCheckpoints'] as const;

/** Copy of the session for console reads, without the run logs. The stored session is untouched. */
export function withoutRunLogs<T extends { metadata?: Record<string, unknown> }>(session: T): T {
  const metadata = session.metadata;
  if (!metadata || !INTERNAL_LOG_KEYS.some((key) => key in metadata)) return session;
  const slim = { ...metadata };
  for (const key of INTERNAL_LOG_KEYS) delete slim[key];
  return { ...session, metadata: slim };
}
