import { principalFromSession } from '../bots/bot-identity.js';
import type { SqliteStateStore } from '../storage.js';
/**
 * Turn-end auto-write: dialogue extract + curator (+ dreamer after accept).
 * Fire-and-forget, fail-soft.
 */

import { createLogger } from '../logger.js';
import { isMemoryContextAppendixText } from './memory-gate.js';
import { publishTaskEndObservation } from './memory-curator.js';
import { extractDialogueFacts, shouldAttemptDialogueExtract } from './memory-dialogue-extract.js';
import { dreamNowForUser } from './memory-dreamer.js';
import { resolveMemorySettings } from './memory-settings.js';
import { resolveBotMemoryAgentId, type BotMemoryLookup } from './bot-memory-scope.js';
import { saveSemanticFact } from './memory-writer.js';
import type { AgentMemoryStore } from './store.js';
import type { SessionMessage, SessionRecord } from '../types.js';

const log = createLogger('memory-turn-end');

export function lastUserTextFromMessages(messages: SessionMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    const texts = m.parts
      .filter((p): p is Extract<(typeof m.parts)[number], { type: 'text' }> => p.type === 'text')
      .map((p) => p.text.trim())
      .filter(Boolean)
      .filter((t) => !isMemoryContextAppendixText(t));
    if (texts.length > 0) return texts[texts.length - 1]!;
  }
  return '';
}

export function collectToolsUsed(messages: SessionMessage[]): string[] {
  const names = new Set<string>();
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'tool_call' && p.name) names.add(p.name);
    }
  }
  return [...names];
}

export function resolveSessionUserId(session: SessionRecord): string | undefined {
  const fromMeta = session.metadata?.userId;
  if (typeof fromMeta === 'string' && fromMeta.trim()) return fromMeta.trim();
  const env = process.env.RAW_AGENT_DEFAULT_USER_ID?.trim();
  return env || undefined;
}

export function scheduleMemoryTurnEnd(input: {
  store: AgentMemoryStore;
  settingsStore?: { getDaemonControl?(key: string): unknown };
  session: SessionRecord;
  messages: SessionMessage[];
  agentId?: string;
  /** Resolves metadata.botId / session.agentId to the bot's memory namespace. */
  botLookup?: BotMemoryLookup;
  assistantText?: string;
  stateDir?: string;
  completeText?: (input: { system: string; user: string }) => Promise<string>;
}): void {
  try {
    const settings = resolveMemorySettings(input.settingsStore);
    const userText = lastUserTextFromMessages(input.messages);
    const botAgentId = resolveBotMemoryAgentId(input.session, input.botLookup);
    const identityStore = input.botLookup as SqliteStateStore | undefined;
    const principal = botAgentId && identityStore?.setDaemonControl ? principalFromSession(identityStore, input.session) : undefined;
    const userId = principal?.userId ?? resolveSessionUserId(input.session);
    const toolsUsed = collectToolsUsed(input.messages);
    const tenantId =
      typeof input.session.metadata?.tenantId === 'string' ? input.session.metadata.tenantId : undefined;

    if (settings.dialogueExtract && userId && shouldAttemptDialogueExtract(userText)) {
      void extractDialogueFacts({
        userText,
        assistantText: input.assistantText,
        completeText: input.completeText
      })
        .then((facts) => {
          for (const fact of facts) {
            saveSemanticFact(input.store, {
              userId,
              tenantId,
              sessionId: input.session.id,
              category: fact.category,
              content: fact.content,
              importance: fact.importance,
              source: 'dialogue_extract',
              sourceRefs: input.messages.filter(message => message.role === 'user').slice(-1).map(message => ({sessionId: input.session.id, messageId: message.id, seq: message.seq})),
              agentId: botAgentId
            });
          }
          if (facts.length > 0) {
            input.store.insertObservation({
              kind: 'dialogue_extract',
              sessionId: input.session.id,
              userId,
              agentId: input.agentId,
              tenantId,
              taskContent: userText.slice(0, 400),
              toolsUsed,
              gate: 'accepted',
              gateReason: `extracted_${facts.length}`
            });
          }
        })
        .catch((e) => {
          log.warn(`dialogue extract failed: ${e instanceof Error ? e.message : String(e)}`);
        });
    }

    if (settings.curatorMode !== 'off') {
      publishTaskEndObservation(
        input.store,
        {
          sessionId: input.session.id,
          taskContent: userText,
          outcome: 'success',
          toolsUsed,
          userId,
          agentId: input.agentId,
          tenantId,
          rawSummary: input.assistantText?.slice(0, 280)
        },
        {
          settingsStore: input.settingsStore,
          memoryAgentId: botAgentId,
          afterAccept: (obs) => {
            if (!settings.dreamerEnabled || !obs.userId) return;
            void dreamNowForUser({
              store: input.store,
              userId: obs.userId,
              tenantId: obs.tenantId,
              messagesText: `user: ${userText}\nassistant: ${input.assistantText || ''}`,
              settingsStore: input.settingsStore,
              stateDir: input.stateDir,
              completeText: input.completeText,
              agentId: botAgentId
            });
          }
        }
      );
    }
  } catch (e) {
    log.warn(`scheduleMemoryTurnEnd failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
