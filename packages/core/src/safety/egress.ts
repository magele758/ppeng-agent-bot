const MCP_READ_ONLY_TOOLS = new Set([
  'whoami',
  'list_rooms',
  'list_peers',
  'read_messages',
  'list_tasks',
  'get_task'
]);

const MCP_MUTATION_TOOLS = new Set([
  'say',
  'ask',
  'claim',
  'deliver',
  'lock',
  'unlock',
  'release',
  'submit_design',
  'bid',
  'conclude',
  'decline',
  'heartbeat',
  'ready',
  'review',
  'test'
]);

export class EgressNotApprovedError extends Error {
  readonly code = 'egress_not_approved' as const;

  constructor() {
    super('egress_not_approved');
    this.name = 'EgressNotApprovedError';
  }
}

/** Outbound tools that must wait for a human. `send_message` is the in-process mailbox, not egress. */
export function egressNeedsApproval(toolName: string, _args: unknown): boolean {
  if (toolName === 'send_message') return false;
  return toolName === 'schedule_social_post';
}

export function isMcpReadOnlyTool(name: string, readOnlyHint?: boolean): boolean {
  if (readOnlyHint === true) return true;
  return MCP_READ_ONLY_TOOLS.has(name);
}

/** Unknown MCP tools are not mutations. `readOnlyHint: true` wins over a write-looking name. */
export function isMcpMutationTool(name: string, readOnlyHint?: boolean): boolean {
  if (isMcpReadOnlyTool(name, readOnlyHint)) return false;
  return MCP_MUTATION_TOOLS.has(name);
}

export function modelTriedToSelfApprove(args: unknown): boolean {
  if (!args || typeof args !== 'object') return false;
  const record = args as Record<string, unknown>;
  return record.approval === 'approved' || record.approved === true;
}

/**
 * Arguments actually sent to an MCP tool. `readOnlyHint` is not consulted:
 * a server can mark an outbound tool read-only and still receive a forged approval.
 */
export function mcpCallArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
  return stripModelSelfApproval(args ?? {});
}

/** Drop a model-supplied self-approval. Other fields, including `approval: "pending_approval"`, stay. */
export function stripModelSelfApproval<T>(args: T): T {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const copy: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  if (copy.approval === 'approved') delete copy.approval;
  if (copy.approved === true) delete copy.approved;
  return copy as T;
}

export function requireHumanEgressApproval(approval: unknown): void {
  if (approval !== 'approved') throw new EgressNotApprovedError();
}
