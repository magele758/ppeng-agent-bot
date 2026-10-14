/**
 * Default assistant for a new chat.
 * `GET /api/agents` is `ORDER BY id`. The first row is `capability-prober`,
 * a read-only probe with no `bash`. An empty composer selection means the
 * default assistant, not that first row — the catalog can paint one frame
 * before the default-agent effect runs.
 */
export function pickDefaultAgentId(agents: readonly { id: string }[]): string {
  if (agents.length === 0 || agents.some((agent) => agent.id === 'general')) return 'general';
  if (agents.some((agent) => agent.id === 'main')) return 'main';
  return agents[0]?.id ?? 'general';
}

export function resolveComposerAgentId(agentId: string, agents: readonly { id: string }[]): string {
  const current = agentId.trim();
  if (current) return current;
  return pickDefaultAgentId(agents);
}
