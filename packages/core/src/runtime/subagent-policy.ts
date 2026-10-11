/**
 * Delegated child (mode subagent) privilege drop and crash recovery.
 *
 * The child starts from its own prompt. These tools are removed from the
 * child's catalog even when a parent allowlist names them. A process restart
 * marks a still-running child `unknown` and does not run it again.
 */

import type { SessionRecord } from '../types.js';

/** Write memory, outbound IM, cron/routine creation, and asking the user. */
export const SUBAGENT_DENIED_TOOLS = [
  'memory_set',
  'memory_delete',
  'handoff_state',
  'save_user_info',
  'send_message',
  'message_agent',
  'cron_create',
  'ask_user'
] as const;

const DENIED = new Set<string>(SUBAGENT_DENIED_TOOLS);

export function isSubagentDeniedTool(name: string): boolean {
  return DENIED.has(name);
}

export function stripSubagentDeniedTools<T extends { name: string }>(
  session: { mode?: string } | undefined,
  tools: readonly T[]
): T[] {
  if (session?.mode !== 'subagent') return tools as T[];
  return tools.filter((tool) => !DENIED.has(tool.name));
}

type SubagentRecoveryStore = {
  listSessions(): SessionRecord[];
  updateSession(
    sessionId: string,
    patch: Partial<Omit<SessionRecord, 'id' | 'createdAt'>>
  ): SessionRecord;
};

/**
 * In-flight subagents left `running` when the process died. Side effects may
 * already have happened, so they are `unknown` and must not be replayed.
 */
export function markInterruptedSubagentsUnknown(store: SubagentRecoveryStore): SessionRecord[] {
  const marked: SessionRecord[] = [];
  for (const session of store.listSessions()) {
    if (session.mode !== 'subagent' || session.status !== 'running') continue;
    marked.push(
      store.updateSession(session.id, {
        status: 'unknown',
        metadata: {
          ...(session.metadata ?? {}),
          subagentDisposition: 'unknown'
        }
      })
    );
  }
  return marked;
}
