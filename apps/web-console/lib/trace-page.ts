/** Ops session-trace page uses the existing reader cap. Do not add an env knob for this. */
export const OPS_TRACE_EVENT_LIMIT = 5000;

export function opsTraceUrl(sessionId: string): string {
  return `/api/traces?sessionId=${encodeURIComponent(sessionId)}&limit=${OPS_TRACE_EVENT_LIMIT}`;
}
