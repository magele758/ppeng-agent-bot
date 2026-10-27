/**
 * Options for POST /api/sessions/:id/steer.
 * The saved interrupt policy decides where a running-turn message lands.
 * A target left on the page from an older read must not override that policy.
 */
export function steerRequestOptions(body: Record<string, unknown>): {
  key?: string;
  role: 'user' | 'system';
  steerMode?: 'subagent';
  subagentRole?: string;
} {
  const role = body.role === 'system' ? 'system' : 'user';
  const key = typeof body.key === 'string' && body.key.trim() ? body.key.trim() : undefined;
  const steerMode = body.mode === 'subagent' || body.steerMode === 'subagent' ? 'subagent' : undefined;
  const subagentRole =
    typeof body.subagentRole === 'string' && body.subagentRole.trim() ? body.subagentRole.trim() : undefined;
  return {
    role,
    ...(key ? { key } : {}),
    ...(steerMode ? { steerMode } : {}),
    ...(subagentRole ? { subagentRole } : {})
  };
}
