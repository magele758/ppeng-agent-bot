import type { SessionRecord } from '../types.js';
import type { BotPrincipal } from './bot-identity.js';
import type { BotFunctionalGroupService, BotSharedScope } from './functional-groups.js';

/**
 * Sole application-facing port for explicit Shared Memory (user-owned scoped facts).
 *
 * Scopes: global → functional group → room. `resolveForSession` merges with
 * room overriding group overriding global. Never copies private chat history
 * or AgentMemoryStore rows — only facts written through this port / setShared.
 *
 * Survives context compaction because appendix injection reads these durable
 * rows each turn (see BotFunctionalGroupService.appendix).
 */
export interface SharedMemoryPort {
  /** Read facts for one scope. */
  get(principal: BotPrincipal, target: BotSharedScope): Record<string, string>;
  /** Replace facts for one scope (full object write). */
  set(principal: BotPrincipal, target: BotSharedScope, entries: Record<string, string>): Record<string, string>;
  /**
   * Merge for the session's bot: room > group > global.
   * Empty when the session cannot authorize a principal/bot subject.
   */
  resolveForSession(session: Pick<SessionRecord, 'id' | 'agentId' | 'metadata' | 'mode' | 'parentSessionId'>): Record<string, string>;
  /** Turn appendix fragment; empty string when no facts apply. */
  appendix(session: SessionRecord): string;
}

export function createSharedMemoryPort(groups: BotFunctionalGroupService): SharedMemoryPort {
  return {
    get(principal, target) {
      return groups.getShared(principal, target);
    },
    set(principal, target, entries) {
      return groups.setShared(principal, target, entries);
    },
    resolveForSession(session) {
      return groups.sharedForSession(session);
    },
    appendix(session) {
      return groups.appendix(session);
    }
  };
}
