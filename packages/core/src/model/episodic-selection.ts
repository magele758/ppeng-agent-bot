/**
 * Episodic message selection inspired by EpiCache (arXiv:2509.17396).
 *
 * Key insight: Long conversations form coherent "episodes" (topic clusters).
 * Preserving key context from earlier episodes improves multi-turn QA accuracy
 * compared to simple truncation or uniform compression.
 *
 * This module:
 * 1. Detects episode boundaries (time gaps, task boundaries, tool patterns)
 * 2. Selects representative messages from each episode
 * 3. Maintains token budget while preserving episodic context
 * 4. Adapts selection based on cognitive state (phase detection)
 *
 * Cognitive state integration (arXiv:2603.10034):
 * - Different phases (exploration, debugging, implementation) benefit from
 *   different context selection strategies.
 * - Debugging prioritizes error context and recent tool interactions.
 * - Exploration prioritizes broader historical context.
 */

import type { SessionMessage } from '../types.js';
import { estimateMessageTokens } from './token-estimate.js';
import {
  computeCognitiveMetrics,
  detectCognitivePhase,
  getEpisodicSelectionParams,
  type CognitiveMetrics,
  type CognitivePhase
} from './cognitive-state.js';

/** Minimum time gap (ms) to consider as episode boundary. Default: 5 minutes. */
const EPISODE_TIME_GAP_MS = 5 * 60 * 1000;

/** Messages with these tool names suggest task/episode completion. */
const EPISODE_BOUNDARY_TOOLS = new Set([
  'write_file', 'edit_file', 'run_tests', 'commit', 'create_pr',
  'task_complete', 'send_message', 'spawn_agent'
]);

/** Representative message types to preserve per episode. */
interface EpisodeSummary {
  /** Index range in original message array. */
  startIndex: number;
  endIndex: number;
  /** First user message in episode (sets context). */
  firstUser?: SessionMessage;
  /** Last assistant message in episode (conclusion/summary). */
  lastAssistant?: SessionMessage;
  /** Last tool result (often contains important state). */
  lastToolResult?: SessionMessage;
  /** Estimated tokens for this episode summary. */
  tokens: number;
}

/**
 * Detects if a message represents an episode boundary.
 * Boundaries occur on:
 * - Significant time gaps (>5 min between messages)
 * - Task completion tools
 * - Explicit task switches
 */
function isEpisodeBoundary(
  prev: SessionMessage | undefined,
  curr: SessionMessage
): boolean {
  if (!prev) return false;

  // Time gap detection
  const prevTime = Date.parse(prev.createdAt);
  const currTime = Date.parse(curr.createdAt);
  if (currTime - prevTime > EPISODE_TIME_GAP_MS) {
    return true;
  }

  // Tool-based boundary detection
  if (curr.role === 'tool') {
    for (const part of curr.parts) {
      if (part.type === 'tool_result' && EPISODE_BOUNDARY_TOOLS.has(part.name)) {
        return true;
      }
    }
  }

  // Assistant message with completion tools
  if (curr.role === 'assistant') {
    for (const part of curr.parts) {
      if (part.type === 'tool_call' && EPISODE_BOUNDARY_TOOLS.has(part.name)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Groups messages into episodes based on boundaries.
 */
function groupIntoEpisodes(messages: SessionMessage[]): SessionMessage[][] {
  if (messages.length === 0) return [];

  const episodes: SessionMessage[][] = [];
  let current: SessionMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const curr = messages[i];
    if (!curr) continue;

    const prev = i > 0 ? messages[i - 1] : undefined;

    if (prev && isEpisodeBoundary(prev, curr) && current.length > 0) {
      episodes.push(current);
      current = [];
    }
    current.push(curr);
  }

  if (current.length > 0) {
    episodes.push(current);
  }

  return episodes;
}

/**
 * Creates a compact summary of an episode by selecting representative messages.
 */
function summarizeEpisode(episode: SessionMessage[]): EpisodeSummary {
  const result: EpisodeSummary = {
    startIndex: 0,
    endIndex: episode.length - 1,
    tokens: 0
  };

  // Find first user message (sets episode context)
  for (const msg of episode) {
    if (msg.role === 'user') {
      result.firstUser = msg;
      break;
    }
  }

  // Find last assistant message (episode conclusion)
  for (let i = episode.length - 1; i >= 0; i--) {
    const msg = episode[i];
    if (msg && msg.role === 'assistant') {
      result.lastAssistant = msg;
      break;
    }
  }

  // Find last tool result (often contains state)
  for (let i = episode.length - 1; i >= 0; i--) {
    const msg = episode[i];
    if (msg && msg.role === 'tool') {
      result.lastToolResult = msg;
      break;
    }
  }

  // Estimate tokens for selected messages
  const selected: SessionMessage[] = [];
  if (result.firstUser) selected.push(result.firstUser);
  if (result.lastAssistant && result.lastAssistant !== result.firstUser) {
    selected.push(result.lastAssistant);
  }
  if (result.lastToolResult && !selected.includes(result.lastToolResult)) {
    selected.push(result.lastToolResult);
  }
  result.tokens = estimateMessageTokens(selected);

  return result;
}

/**
 * Selects messages from episodes to fit within token budget.
 * Strategy:
 * - Always keep the last episode fully (most recent context)
 * - For older episodes, keep representative summaries
 * - Respect token budget
 */
export function selectEpisodicMessages(
  messages: SessionMessage[],
  maxTokens: number,
  options?: {
    /** Minimum messages to keep from the end (default: 8). */
    minRecentMessages?: number;
    /** Always include first episode's first user message (initial context). */
    includeInitialContext?: boolean;
  }
): SessionMessage[] {
  if (estimateMessageTokens(messages) <= maxTokens) return messages;
  const selected = selectHistoricalEpisodes(messages, maxTokens, options);
  const latestUser = messages.findLastIndex(message => message.role === 'user');
  if (latestUser < 0) return selected;
  // The history budget may evict old episodes, never the active request or its
  // tool waves. Compaction, not an arbitrary tail slice, bounds an active turn.
  const ids = new Set(selected.map(message => message.id));
  for (const message of messages.slice(latestUser)) ids.add(message.id);
  return messages.filter(message => ids.has(message.id));
}

function selectHistoricalEpisodes(
  messages: SessionMessage[],
  maxTokens: number,
  options?: Parameters<typeof selectEpisodicMessages>[2]
): SessionMessage[] {
  if (messages.length === 0) return [];

  const minRecent = options?.minRecentMessages ?? 8;
  const includeInitial = options?.includeInitialContext ?? true;

  // If we have few messages, return all
  if (messages.length <= minRecent) {
    return messages;
  }

  const episodes = groupIntoEpisodes(messages);

  // If only one episode, fall back to simple truncation
  if (episodes.length <= 1) {
    return messages.slice(-minRecent);
  }

  // Always keep the last episode + some buffer from previous
  const lastEpisode = episodes[episodes.length - 1];
  if (!lastEpisode) {
    return messages.slice(-minRecent);
  }

  const lastEpisodeTokens = estimateMessageTokens(lastEpisode);

  // Check if we can fit everything
  const totalTokens = estimateMessageTokens(messages);
  if (totalTokens <= maxTokens) {
    return messages;
  }

  // Build selection: prioritize last episode, then add older episode summaries
  const selected: SessionMessage[] = [];
  let usedTokens = 0;

  // Reserve budget for last episode
  const reservedForLast = Math.min(lastEpisodeTokens, maxTokens * 0.6);
  const budgetForOlder = maxTokens - reservedForLast;

  // Process older episodes (all except the last)
  const olderEpisodes = episodes.slice(0, -1);
  const episodeSummaries: Array<{ episode: SessionMessage[]; summary: EpisodeSummary }> = [];

  for (const episode of olderEpisodes) {
    const summary = summarizeEpisode(episode);
    episodeSummaries.push({ episode, summary });
  }

  // Always include first episode's initial context if requested
  if (includeInitial && episodeSummaries.length > 0) {
    const firstSummary = episodeSummaries[0]?.summary;
    if (firstSummary?.firstUser) {
      selected.push(firstSummary.firstUser);
      usedTokens += estimateMessageTokens([firstSummary.firstUser]);
    }
  }

  // Add summaries from older episodes in reverse order (most recent first)
  for (let i = episodeSummaries.length - 1; i >= 0 && usedTokens < budgetForOlder; i--) {
    const item = episodeSummaries[i];
    if (!item) continue;

    const { summary } = item;
    if (!summary.firstUser && !summary.lastAssistant && !summary.lastToolResult) continue;

    const episodeMessages: SessionMessage[] = [];
    if (summary.lastAssistant && !selected.includes(summary.lastAssistant)) {
      episodeMessages.push(summary.lastAssistant);
    }
    if (summary.lastToolResult && !selected.includes(summary.lastToolResult)) {
      episodeMessages.push(summary.lastToolResult);
    }

    const episodeTokens = estimateMessageTokens(episodeMessages);
    if (usedTokens + episodeTokens <= budgetForOlder) {
      selected.push(...episodeMessages);
      usedTokens += episodeTokens;
    }
  }

  // Finally, add the last episode
  selected.push(...lastEpisode);
  usedTokens += lastEpisodeTokens;

  // Sort by original order
  const messageIds = new Set(selected.map(m => m.id));
  return messages.filter(m => messageIds.has(m.id));
}

/**
 * Estimates the compression ratio achievable with episodic selection.
 * Returns the estimated token count after selection.
 */
export function estimateEpisodicCompression(
  messages: SessionMessage[],
  maxTokens: number
): { originalTokens: number; selectedTokens: number; episodeCount: number } {
  const originalTokens = estimateMessageTokens(messages);
  const episodes = groupIntoEpisodes(messages);
  const selected = selectEpisodicMessages(messages, maxTokens);
  const selectedTokens = estimateMessageTokens(selected);

  return {
    originalTokens,
    selectedTokens,
    episodeCount: episodes.length
  };
}

/**
 * Episodic selection with cognitive state adaptation.
 * Adjusts selection parameters based on detected cognitive phase.
 */
export function selectEpisodicMessagesWithCognitiveState(
  messages: SessionMessage[],
  maxTokens: number,
  options?: {
    /** Override cognitive phase detection. */
    cognitivePhase?: CognitivePhase;
    /** Override metrics computation. */
    metrics?: CognitiveMetrics;
  }
): {
  selected: SessionMessage[];
  cognitivePhase: CognitivePhase;
  cognitiveConfidence: number;
} {
  if (messages.length === 0) {
    return {
      selected: [],
      cognitivePhase: 'idle',
      cognitiveConfidence: 1
    };
  }

  // Compute cognitive metrics and phase
  const metrics = options?.metrics ?? computeCognitiveMetrics(messages);
  const state = detectCognitivePhase(messages, metrics);

  // Get adaptive selection parameters
  const params = getEpisodicSelectionParams(state);

  // Use cognitive phase override if provided
  const effectivePhase = options?.cognitivePhase ?? state.phase;

  // If prioritizing errors, include more recent messages with error context
  if (params.prioritizeErrors && metrics.errorRate > 0.1) {
    const errorMessages = messages.filter((msg) => {
      if (msg.role !== 'tool') return false;
      return msg.parts.some((part) => {
        if (part.type !== 'tool_result') return false;
        return !part.ok || ERROR_PATTERNS.some((p) => p.test(part.content));
      });
    });

    // If we have error messages, ensure they're included in selection
    if (errorMessages.length > 0) {
      const selected = selectEpisodicMessages(messages, maxTokens, {
        minRecentMessages: params.minRecentMessages,
        includeInitialContext: params.includeInitialContext
      });

      // Ensure error messages are included
      const selectedIds = new Set(selected.map((m) => m.id));
      const missingErrors = errorMessages.filter((m) => !selectedIds.has(m.id));

      if (missingErrors.length > 0) {
        // Add most recent error messages
        const recentErrors = missingErrors.slice(-4);
        const result = [...selected];
        // Insert errors before the last user message
        const lastUserIdx = result.reduceRight((found, _, i) =>
          found === -1 && result[i]?.role === 'user' ? i : found, -1);
        if (lastUserIdx > 0) {
          result.splice(lastUserIdx, 0, ...recentErrors);
        } else {
          result.push(...recentErrors);
        }
        return {
          selected: result,
          cognitivePhase: effectivePhase,
          cognitiveConfidence: state.confidence
        };
      }

      return {
        selected,
        cognitivePhase: effectivePhase,
        cognitiveConfidence: state.confidence
      };
    }
  }

  // Standard episodic selection with cognitive-adapted parameters
  const selected = selectEpisodicMessages(messages, maxTokens, {
    minRecentMessages: params.minRecentMessages,
    includeInitialContext: params.includeInitialContext
  });

  return {
    selected,
    cognitivePhase: effectivePhase,
    cognitiveConfidence: state.confidence
  };
}

/** Error patterns for error-focused context selection. */
const ERROR_PATTERNS = [
  /error/i,
  /failed/i,
  /exception/i,
  /cannot/i,
  /unable to/i,
  /not found/i,
  /invalid/i,
  /timeout/i
];

export {
  groupIntoEpisodes,
  isEpisodeBoundary,
  computeCognitiveMetrics,
  detectCognitivePhase,
  getEpisodicSelectionParams
};
