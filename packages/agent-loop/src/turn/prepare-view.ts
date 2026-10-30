/**
 * Rich model view (full+): image contact-sheet, refusal, micro-compact, fold budget.
 * Product I/O (image assets, episodic picker, dyn-tools annotate) is injected.
 */

import { createId, envInt } from '../helpers.js';
import { applyRefusalPreservationGuard } from '../model/refusal-preservation.js';
import {
  DEFAULT_MICRO_COMPACT_CONFIG,
  microCompactMessages,
  type MicroCompactConfig,
} from '../session/micro-compact.js';
import { clampFoldToVisible, MAX_VISIBLE_MESSAGES } from '../session/fold-budget.js';
import type { ImagePart, MessagePart, SessionMessage, SessionRecord } from '../types.js';

export { MAX_VISIBLE_MESSAGES };

export const SESSION_CACHE_MAX = 512;

export function capSessionMap<V>(map: Map<string, V>, max = SESSION_CACHE_MAX): void {
  if (map.size <= max) return;
  for (const key of map.keys()) {
    map.delete(key);
    if (map.size <= max) return;
  }
}

export function capRollingSummaryText(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  return `…[earlier summary truncated]\n\n${text.slice(-maxChars)}`;
}

export function compactSummaryMaxChars(
  env: Record<string, string | undefined>,
  tokenThreshold: number
): number {
  return envInt(env, 'RAW_AGENT_COMPACT_SUMMARY_MAX_CHARS', tokenThreshold * 2);
}

export interface PrepareViewImageAsset {
  mimeType: string;
  sourceUrl?: string;
  retentionTier?: string;
}

export interface PrepareViewPorts {
  getImageAsset?: (id: string) => PrepareViewImageAsset | undefined;
  annotateRetired?: (messages: SessionMessage[], session: SessionRecord) => SessionMessage[];
  selectEpisodic?: (folded: SessionMessage[], session: SessionRecord) => SessionMessage[];
  refusalPreservation?: boolean;
  microCompact?: MicroCompactConfig;
  emitTrace?: (sessionId: string, event: { kind: string; payload?: unknown }) => void;
  maxVisibleMessages?: number;
}

function textPart(text: string): MessagePart {
  return { type: 'text', text };
}

export function prepareRichView(
  session: SessionRecord,
  messages: SessionMessage[],
  ports: PrepareViewPorts = {}
): SessionMessage[] {
  let sourceMessages = ports.annotateRetired ? ports.annotateRetired(messages, session) : messages;

  const mapped: SessionMessage[] = sourceMessages.map((msg) => ({
    ...msg,
    parts: msg.parts.flatMap((part): MessagePart[] => {
      if (part.type !== 'image') return [part];
      if (part.source) return [part];
      const asset = ports.getImageAsset?.(part.assetId);
      if (!asset || asset.retentionTier === 'cold') {
        return [{ type: 'text', text: `[archived image ${part.assetId}]` }];
      }
      const tier = asset.retentionTier;
      const im: ImagePart = {
        type: 'image',
        assetId: part.assetId,
        mimeType: asset.mimeType,
        sourceUrl: part.sourceUrl ?? asset.sourceUrl,
        retentionTier:
          tier === 'hot' || tier === 'warm' || tier === 'cold' ? tier : undefined,
      };
      return [im];
    }),
  }));

  const warmId = session.metadata?.imageWarmContactAssetId;
  const warmIdStr = typeof warmId === 'string' ? warmId : undefined;
  if (warmIdStr && ports.getImageAsset) {
    const warmAsset = ports.getImageAsset(warmIdStr);
    const already = mapped.some((m) =>
      m.parts.some((p) => p.type === 'image' && p.assetId === warmIdStr)
    );
    if (warmAsset && !already) {
      const contactSheet: SessionMessage = {
        id: createId('msg'),
        sessionId: session.id,
        role: 'user',
        parts: [
          textPart('Earlier screenshots (contact sheet, compressed memory):'),
          {
            type: 'image',
            assetId: warmIdStr,
            mimeType: warmAsset.mimeType,
            retentionTier: 'warm',
          },
        ],
        createdAt: new Date(0).toISOString(),
      };
      const lastUserIdx = mapped.reduceRight(
        (found, _, i) => (found === -1 && mapped[i]!.role === 'user' ? i : found),
        -1
      );
      if (lastUserIdx > 0) mapped.splice(lastUserIdx, 0, contactSheet);
      else mapped.push(contactSheet);
    }
  }

  let guardedMessages = mapped;
  if (ports.refusalPreservation !== false) {
    const { messages: guarded, result } = applyRefusalPreservationGuard(mapped);
    if (result.shouldInjectReminder) {
      ports.emitTrace?.(session.id, {
        kind: 'refusal_preservation',
        payload: {
          refusalCount: result.refusalMessageIds.length,
          isRedirectAttempt: result.isRedirectAttempt,
        },
      });
      guardedMessages = guarded;
    }
  }

  const compactCfg = ports.microCompact ?? DEFAULT_MICRO_COMPACT_CONFIG;
  const micro = microCompactMessages(guardedMessages, compactCfg);
  if (micro.stats.collapsed > 0 || micro.stats.trimmed > 0) {
    ports.emitTrace?.(session.id, {
      kind: 'micro_compact',
      payload: { ...micro.stats },
    });
  }
  return micro.messages;
}

export function applyOptionalFoldBudget(
  session: SessionRecord,
  folded: SessionMessage[],
  ports: PrepareViewPorts = {}
): SessionMessage[] {
  const max = ports.maxVisibleMessages ?? MAX_VISIBLE_MESSAGES;
  if (folded.length <= max) return folded;
  if (ports.selectEpisodic) {
    const selected = ports.selectEpisodic(folded, session);
    const kept = new Set(selected.map((m) => m.id));
    const droppedSeqs = folded
      .filter((m) => !kept.has(m.id) && typeof m.seq === 'number')
      .map((m) => m.seq as number);
    if (droppedSeqs.length > 0) {
      ports.emitTrace?.(session.id, {
        kind: 'fold_budget_drop',
        payload: { droppedSeqs, kept: selected.length, folded: folded.length },
      });
    }
    return selected;
  }
  return clampFoldToVisible(folded, max);
}
