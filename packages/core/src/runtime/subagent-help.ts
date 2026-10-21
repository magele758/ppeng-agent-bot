/**
 * Bot sub-agents can ask their parent and sibling sub-agents for help.
 * This is not external IM, cron, or a memory write.
 */

import type { SessionRecord, ToolContract } from '../types.js';
import type { SqliteStateStore } from '../storage.js';
import { resolveBotMemoryAgentId, type BotMemorySession } from '../memory/bot-memory-scope.js';
import { primaryWorkspacePath } from '../workspace/index.js';
import { loadForkSiblingFileFacts, privateFileFragments, redactHelpMessage } from '../bots/fork-sibling-isolation.js';

export const ASK_BOT_HELP_TOOL = 'ask_bot_help';

const MAX_CHARS = 4000;

type Audience = 'parent' | 'siblings' | 'both';

function parentIdOf(session: BotMemorySession): string {
  if (session.parentSessionId?.trim()) return session.parentSessionId.trim();
  const fromMeta = session.metadata?.parentSessionId;
  return typeof fromMeta === 'string' ? fromMeta.trim() : '';
}

function parseAudience(raw: unknown): Audience | undefined {
  if (raw === undefined || raw === 'both') return 'both';
  if (raw === 'parent' || raw === 'siblings') return raw;
  return undefined;
}

function deliver(store: SqliteStateStore, sessionId: string, key: string, text: string): boolean {
  try {
    store.appendMessage(sessionId, 'system', [{ type: 'text', text }], { key });
    return true;
  } catch {
    try {
      store.enqueueSteer(sessionId, text, { target: 'next-step', role: 'system', key });
      return true;
    } catch {
      return false;
    }
  }
}

export function subagentHelpTargets(
  store: SqliteStateStore,
  session: SessionRecord,
  audience: Audience
): SessionRecord[] {
  if (session.mode !== 'subagent') return [];
  const botAgentId = resolveBotMemoryAgentId(session, store);
  const parentId = parentIdOf(session);
  if (!botAgentId || !parentId) return [];
  const targets: SessionRecord[] = [];
  if (audience === 'parent' || audience === 'both') {
    const parent = store.getSession(parentId);
    if (parent && resolveBotMemoryAgentId(parent, store) === botAgentId) targets.push(parent);
  }
  if (audience === 'siblings' || audience === 'both') {
    const su = typeof session.metadata?.userId === 'string' ? session.metadata.userId.trim() : '';
    const st = typeof session.metadata?.tenantId === 'string' ? session.metadata.tenantId.trim() : '';
    for (const candidate of store.listSessions()) {
      if (candidate.id === session.id || candidate.mode !== 'subagent') continue;
      if (parentIdOf(candidate) !== parentId) continue;
      if (resolveBotMemoryAgentId(candidate, store) !== botAgentId) continue;
      // same-owner guard — mirror sameOwner in bot-activity.ts
      const cu = typeof candidate.metadata?.userId === 'string' ? candidate.metadata.userId.trim() : '';
      const ct = typeof candidate.metadata?.tenantId === 'string' ? candidate.metadata.tenantId.trim() : '';
      // A userId on either side must match on both. Tenant equality is only the
      // fallback when neither side has a userId (both empty = single-user local mode).
      if (su || cu ? su !== cu || st !== ct : st !== ct) continue;
      targets.push(candidate);
    }
  }
  return targets;
}

export function createSubagentHelpTool(store: SqliteStateStore): ToolContract<{ message?: string; audience?: string }> {
  return {
    name: ASK_BOT_HELP_TOOL,
    description:
      'Ask the parent bot or a sibling sub-agent of the same bot for help. Does not send external messages, schedule work, or change memory.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        audience: { type: 'string', enum: ['parent', 'siblings', 'both'] }
      },
      required: ['message']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(context, args) {
      if (context.session.mode !== 'subagent') {
        return { ok: false, content: JSON.stringify({ ok: false, error: 'Only a sub-agent can ask its bot family for help.' }) };
      }
      const audience = parseAudience(args?.audience);
      if (!audience) {
        return { ok: false, content: JSON.stringify({ ok: false, error: 'audience must be parent, siblings, or both.' }) };
      }
      const message = typeof args?.message === 'string' ? args.message.trim() : '';
      if (!message || message.length > MAX_CHARS) {
        return { ok: false, content: JSON.stringify({ ok: false, error: 'Message must contain 1–4000 characters.' }) };
      }
      const targets = subagentHelpTargets(store, context.session, audience);
      if (targets.length === 0) {
        return { ok: false, content: JSON.stringify({ ok: false, error: 'No parent or sibling of this bot is available.' }) };
      }
      const facts = loadForkSiblingFileFacts(
        store,
        context.session,
        primaryWorkspacePath(context),
        context.stateDir
      );
      const visible = redactHelpMessage(message, privateFileFragments(facts));
      const note = `[bot-help] Sub-agent ${context.session.id} asks: ${visible}`;
      const delivered: string[] = [];
      for (const target of targets) {
        if (deliver(store, target.id, `bot-help:${context.session.id}:${target.id}`, note)) delivered.push(target.id);
      }
      return {
        ok: delivered.length > 0,
        content: JSON.stringify({ ok: delivered.length > 0, delivered, audience })
      };
    }
  };
}
