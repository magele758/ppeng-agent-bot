/**
 * Product view ports around A's prepareRichView / fold budget.
 */

import { envBool } from '../env.js';
import { resolveMicroCompactConfig } from '../session/compact-settings.js';
import { resolveHistoryTokenBudget } from '../session/session-budget.js';
import {
  selectEpisodicMessages,
  selectEpisodicMessagesWithCognitiveState
} from '../model/episodic-selection.js';
import type { ImageAssetRecord, SessionMessage, SessionRecord } from '../types.js';
import { annotateRetiredToolParts, messagesMayNeedRetiredAnnotation } from '../dyn-tools/annotate-retired.js';
import { readDynToolSettings } from '../dyn-tools/settings.js';
import { tryCreateDynToolStore } from '../dyn-tools/store.js';
import { microCompactMessages } from '@ppeng/agent-loop/session';
import { coordinatorViewOf } from '../bots/concurrent-fork.js';
import { sealSharedExposure, sharedMessageVisible } from '../bots/shared-context-isolation.js';
import {
  applyOptionalFoldBudget as applyOptionalFoldBudgetA,
  capRollingSummaryText,
  capSessionMap,
  compactSummaryMaxChars,
  MAX_VISIBLE_MESSAGES,
  prepareRichView,
  SESSION_CACHE_MAX
} from '@ppeng/agent-loop';

export {
  capRollingSummaryText,
  capSessionMap,
  compactSummaryMaxChars,
  MAX_VISIBLE_MESSAGES,
  SESSION_CACHE_MAX
};

export interface PrepareViewHost {
  store: {
    getImageAsset(id: string): ImageAssetRecord | undefined;
    getDaemonControl?(key: string): unknown;
    setDaemonControl?(key: string,value: unknown): void;
    agentMemory?(): unknown;
    upsertSessionMemory?(input: unknown): unknown;
    listSessionMemory?(sessionId: string): unknown[];
    deleteSessionMemory?(sessionId: string, scope: 'scratch' | 'long', key: string): boolean;
  };
  emitTrace(sessionId: string, event: { kind: string; payload?: unknown }): void;
  turnShapeBySession: Map<string, { systemPromptChars: number; toolCount: number }>;
  promptBuilder: {
    lastCognitivePhaseBySession: Map<string, { phase: string; confidence: number }>;
  };
}

export async function prepareMessagesForModel(
  host: PrepareViewHost,
  session: SessionRecord,
  messages: SessionMessage[]
): Promise<SessionMessage[]> {
  const dynSettings = readDynToolSettings(host.store);
  const mayNeedRetired =
    dynSettings.enabled || messagesMayNeedRetiredAnnotation(messages, session);
  sealSharedExposure(host.store,session.id,messages);
  const scoped=messages.filter(message=>sharedMessageVisible(host.store,session.id,message));
  return prepareRichView(session, coordinatorViewOf(session, scoped), {
    getImageAsset: (id) => host.store.getImageAsset(id),
    annotateRetired: (msgs, sess) => {
      if (!mayNeedRetired) return msgs;
      const dynStore = tryCreateDynToolStore(host.store as Parameters<typeof tryCreateDynToolStore>[0]);
      const retiredNames = dynStore ? dynStore.listRetiredNames(sess.id) : new Set<string>();
      if (retiredNames.size === 0) return msgs;
      return annotateRetiredToolParts(msgs, retiredNames);
    },
    refusalPreservation: envBool(process.env, 'RAW_AGENT_REFUSAL_PRESERVATION', true),
    microCompact: resolveMicroCompactConfig({ store: host.store, env: process.env }),
    emitTrace: (sessionId, event) => host.emitTrace(sessionId, event)
  });
}

export function applyOptionalFoldBudget(
  host: PrepareViewHost,
  session: SessionRecord,
  folded: SessionMessage[]
): SessionMessage[] {
  const compacted = microCompactMessages(
    folded,
    resolveMicroCompactConfig({ store: host.store, env: process.env })
  ).messages;
  return applyOptionalFoldBudgetA(session, compacted, {
    maxVisibleMessages: MAX_VISIBLE_MESSAGES,
    selectEpisodic: (msgs, sess) => selectEpisodicForHost(host, sess, msgs),
    emitTrace: (sessionId, event) => host.emitTrace(sessionId, event)
  });
}

function selectEpisodicForHost(
  host: PrepareViewHost,
  session: SessionRecord,
  folded: SessionMessage[]
): SessionMessage[] {
  const forceCut =
    session.metadata?.sessionCut === true || session.metadata?.canonicalBotChat === true;
  const useEpisodic = forceCut || envBool(process.env, 'RAW_AGENT_EPISODIC_SELECTION', true);
  if (!useEpisodic) {
    return folded.slice(-MAX_VISIBLE_MESSAGES);
  }
  const useCognitiveState = envBool(process.env, 'RAW_AGENT_COGNITIVE_STATE_SELECTION', true);
  const tokenBudget = resolveHistoryTokenBudget(
    'RAW_AGENT_EPISODIC_TOKEN_BUDGET',
    host.turnShapeBySession.get(session.id) ?? {}
  );
  if (useCognitiveState) {
    const result = selectEpisodicMessagesWithCognitiveState(folded, tokenBudget);
    host.promptBuilder.lastCognitivePhaseBySession.set(session.id, {
      phase: result.cognitivePhase,
      confidence: result.cognitiveConfidence
    });
    capSessionMap(host.promptBuilder.lastCognitivePhaseBySession);
    return result.selected;
  }
  return selectEpisodicMessages(folded, tokenBudget, {
    minRecentMessages: MAX_VISIBLE_MESSAGES,
    includeInitialContext: true
  });
}
