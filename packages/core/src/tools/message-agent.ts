import { BotQueueCapacityError, enqueueBotMessage } from '../bots/bot-work.js';
import { botDefinitionOwner, principalFromSession } from '../bots/bot-identity.js';
/**
 * Canonical Bot Chat only: deliver a composed message into another bot's
 * canonical session and, when that session is idle, wake it with the same
 * path cron uses (`startIdleSessionRun`). Not a subprocess CLI.
 */

import { findSimilarToolName } from '@ppeng/agent-loop/recovery';
import type { BotRecord } from '../bots/types.js';
import { CANONICAL_BOT_CHAT_META } from '../bots/types.js';
import type { Logger } from '../logger.js';
import { getPermissionMode } from '../runtime/session-facade.js';
import type { SqliteStateStore } from '../storage.js';
import type { RunContext, SessionRecord, ToolContract, ToolExecutionResult } from '../types.js';

import { MESSAGE_AGENT_TOOL_NAME } from '../bots/bot-tool-names.js';
import { isSilenceToken } from '../bots/silence.js';
export { MESSAGE_AGENT_TOOL_NAME } from '../bots/bot-tool-names.js';
export { isSilenceToken } from '../bots/silence.js';
export const MESSAGE_MAX_CHARS = 4000;
export const RELAY_HOP_META = 'relayHop';
/** Id of the relayed user message that `relayHop` belongs to; the hop is stale once any later user message lands. */
export const RELAY_HOP_MESSAGE_META = 'relayHopMessageId';
export const RELAY_HOP_LIMIT = 3;
/** Room id stamped on a 1:1 that a Room member sent. Absent for ordinary Bot Chat relays. */
export const SOURCE_ROOM_META = 'sourceRoomId';
const ROSTER_SAMPLE = 8;

export interface MessageAgentHost {
  store: SqliteStateStore;
  runSession(sessionId: string): Promise<unknown>;
  /** In-process run registry; covers the window before the kernel persists `status: running`. */
  isSessionRunning?(sessionId: string): boolean;
  log: Logger;
}

export function isCanonicalBotChatSession(session: {
  mode?: string;
  metadata?: Record<string, unknown> | null;
}): boolean {
  if (session.metadata?.[CANONICAL_BOT_CHAT_META] !== true) return false;
  return session.mode === 'chat';
}

/**
 * Hop depth of the run currently driven by this session. `relayHop` is only trusted while the
 * relayed message is still the latest user message; a human (or cron, approval) message after it
 * starts a fresh chain, so a finished 3-hop chain never locks the bot out of message_agent.
 */
export function effectiveRelayHop(store: SqliteStateStore, session: SessionRecord): number {
  const hop = readRelayHop(session.metadata);
  if (hop <= 0) return 0;
  const anchor = session.metadata?.[RELAY_HOP_MESSAGE_META];
  if (typeof anchor !== 'string' || !anchor) return 0;
  const messages = store.foldMessages(session.id);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== 'user' || message.hidden) continue;
    return message.id === anchor ? hop : 0;
  }
  return 0;
}

export function readRelayHop(metadata: Record<string, unknown> | undefined): number {
  const raw = metadata?.[RELAY_HOP_META];
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.floor(raw));
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  }
  return 0;
}

const WAKE_OFF_STRINGS = new Set(['false', '0', 'no']);

/** Only an explicit opt-out ("wake: false"-like) skips the wake; absent / unknown values wake. */
export function wantsWake(raw: unknown): boolean {
  if (raw === false || raw === null || raw === 0) return false;
  return !(typeof raw === 'string' && WAKE_OFF_STRINGS.has(raw.trim().toLowerCase()));
}

export function formatBotMessage(sender: { name: string; id: string }, body: string, sourceRoomId?: string): string {
  const from = sourceRoomId ? ` (from room ${sourceRoomId})` : '';
  return `Message from ${sender.name} / ${sender.id}${from}: ${body}`;
}

/** A Room member session is not a canonical Bot Chat, but it may send one 1:1. */
export function sourceRoomIdOf(session: { metadata?: Record<string, unknown> | null }): string | undefined {
  const raw = session.metadata?.roomId;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function toolJson(ok: boolean, payload: Record<string, unknown>): ToolExecutionResult {
  return { ok, content: JSON.stringify({ ok, ...payload }) };
}

function rosterNames(roster: BotRecord[], limit = ROSTER_SAMPLE): string[] {
  return roster
    .map((bot) => bot.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, limit);
}

function suggestRosterName(raw: string, roster: BotRecord[]): string | null {
  const byName = findSimilarToolName(
    raw,
    roster.map((bot) => bot.name)
  );
  if (byName) return byName;
  const byId = findSimilarToolName(
    raw,
    roster.map((bot) => bot.id)
  );
  if (!byId) return null;
  return roster.find((bot) => bot.id === byId)?.name ?? null;
}

function senderBot(store: SqliteStateStore, session: SessionRecord): BotRecord | undefined {
  const bot = store.getBot(session.agentId);
  if (!bot) return undefined;
  const metaId = session.metadata?.botId;
  if (typeof metaId === 'string' && metaId.trim() && metaId.trim() !== bot.id) return undefined;
  return bot;
}

function resolveRosterBot(roster: BotRecord[], raw: string): BotRecord | undefined {
  const want = raw.trim().replace(/^@+/, '');
  if (!want) return undefined;
  const byId = roster.find((bot) => bot.id === want);
  if (byId) return byId;
  const byName = roster.find((bot) => bot.name === want);
  if (byName) return byName;
  const idCi = roster.filter((bot) => bot.id.toLowerCase() === want.toLowerCase());
  if (idCi.length === 1) return idCi[0];
  const nameCi = roster.filter((bot) => bot.name.toLowerCase() === want.toLowerCase());
  if (nameCi.length === 1) return nameCi[0];
  return undefined;
}

export function createMessageAgentTool(host: MessageAgentHost): ToolContract<{
  target?: string;
  message?: string;
  wake?: boolean;
  idempotencyKey?: string;
  replyTo?: string;
}> {
  return {
    name: MESSAGE_AGENT_TOOL_NAME,
    description:
      'Send a message to ONE other bot on this install roster (id or name). ' +
      'Call with an empty target to get the roster names back. ' +
      'Compose the message yourself: lead with the point and the concrete ask or result. ' +
      "Do not paste the user's private 1:1 chat verbatim. " +
      'Do not fan out to several bots unless the user explicitly asked you to contact each of them. ' +
      'Do not write a "Message from" prefix; the sender name and id are added automatically. ' +
      "Delivery is fire-and-forget into that bot's canonical Bot Chat and wakes it by default; " +
      'this call never returns their reply (they may message you back later). ' +
      'From a Room turn the same rules apply: the note is marked with the Room id, nothing the recipient says is written back to the Room, ' +
      'and waking them does not authorize an action that still needs the user. ' +
      'Set wake=false for a note that needs no action: it is stored but the bot is NOT woken and sees it on its next run. ' +
      'wake is the only switch (default true); wording such as "FYI" in the message does not change it. ' +
      'A bot whose last run failed or ended is restarted by a waking message. ' +
      'Busy or waiting-approval bots durably accept queued messages and process them when ready. ' +
      `The message body is at most ${MESSAGE_MAX_CHARS} characters.`,
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Roster bot id or name. Cannot be yourself.'
        },
        message: {
          type: 'string',
          description: `What you want that bot to know or do (max ${MESSAGE_MAX_CHARS} characters). Do not include a "Message from" prefix.`
        },
        idempotencyKey: { type: 'string', description: 'Stable key for safe retries of this exact message.' },
        replyTo: { type: 'string', description: 'Original message id when replying.' },
        wake: {
          type: 'boolean',
          description:
            'Default true: wake the bot to act on the message. Set false to only store the message without waking it.'
        }
      },
      required: ['target', 'message']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    async execute(context, args) {
      try {
        return await deliverMessageAgent(host, context, args);
      } catch (err) {
        return toolJson(false, {
          error: err instanceof Error ? err.message : String(err),
          error_code: 'DELIVERY_FAILED'
        });
      }
    }
  };
}

async function deliverMessageAgent(
  host: MessageAgentHost,
  context: RunContext,
  args: { target?: string; message?: string; wake?: unknown; idempotencyKey?: string; replyTo?: string }
): Promise<ToolExecutionResult> {
  const live = host.store.getSession(context.session.id) ?? context.session;
  const sourceRoomId = sourceRoomIdOf(live);
  if (!isCanonicalBotChatSession(live) && !sourceRoomId) {
    return toolJson(false, {
      error: 'message_agent is only available in a canonical Bot Chat session or a Room member turn.',
      error_code: 'NOT_CANONICAL'
    });
  }

  const sender = senderBot(host.store, live);
  if (!sender) {
    return toolJson(false, {
      error: 'This canonical Bot Chat has no roster bot.',
      error_code: 'NOT_A_BOT'
    });
  }

  if (getPermissionMode(host.store, live.id) === 'plan') {
    return toolJson(false, {
      error: 'message_agent writes into another bot chat and is blocked while permissionMode=plan.',
      error_code: 'PERMISSION_MODE_PLAN'
    });
  }

  const principal = principalFromSession(host.store, live);
  const installation = principalFromSession(host.store, {metadata:{}});
  const roster = host.store.listBots({ includeHidden: true }).filter(bot => {
    if(bot.id===sender.id)return false;
    const canonical=host.store.getSession(bot.canonicalSessionId);
    const owner=canonical?principalFromSession(host.store,canonical):botDefinitionOwner(host.store,bot.id);
    if(!owner)return false;
    return (owner.userId===principal.userId&&(owner.tenantId??'')===(principal.tenantId??'')) || owner.userId===installation.userId;
  });
  const names = rosterNames(roster);
  const targetRaw = typeof args.target === 'string' ? args.target : '';
  const messageRaw = typeof args.message === 'string' ? args.message : '';
  const body = messageRaw.trim();
  if (!targetRaw.trim()) {
    return toolJson(false, {
      error: 'target is required. Pick a bot from roster.',
      error_code: 'TARGET_REQUIRED',
      did_you_mean: null,
      roster: rosterNames(roster, roster.length),
      rosterTotal: roster.length
    });
  }
  if (!body) {
    return toolJson(false, {
      error: 'message is required. Compose what you want to say.',
      error_code: 'MESSAGE_REQUIRED'
    });
  }
  if (body.length > MESSAGE_MAX_CHARS) {
    return toolJson(false, {
      error: `message is too long (${body.length} chars > ${MESSAGE_MAX_CHARS}).`,
      error_code: 'MESSAGE_TOO_LONG'
    });
  }

  const hop = effectiveRelayHop(host.store, live);
  if (hop >= RELAY_HOP_LIMIT) {
    return toolJson(false, {
      error: `Relay hop limit reached (relayHop >= ${RELAY_HOP_LIMIT}). Message was not sent.`,
      error_code: 'HOP_LIMIT',
      relayHop: hop
    });
  }

  const target = resolveRosterBot(roster, targetRaw);
  if (!target) {
    const selfHit = resolveRosterBot(host.store.listBots({ includeHidden: true }), targetRaw);
    if (selfHit && selfHit.id === sender.id) {
      return toolJson(false, {
        error: "You can't message yourself. Pick another bot from the roster.",
        error_code: 'SELF_TARGET',
        did_you_mean: null,
        roster: names
      });
    }
    const foreign=resolveRosterBot(host.store.listBots({includeHidden:true}),targetRaw);
    if(foreign)return toolJson(false,{error:'Target is not authorized for this principal',error_code:'TARGET_OWNER_MISMATCH'});
    return toolJson(false, {
      error: `No roster bot matches target '${targetRaw.trim()}'.`,
      error_code: 'UNKNOWN_TARGET',
      did_you_mean: suggestRosterName(targetRaw.trim().replace(/^@+/, ''), roster),
      roster: names
    });
  }

  const skip = !wantsWake(args.wake) ? 'wake_false' : isSilenceToken(body) ? 'silent' : null;
  try {
    const previous = host.store.getSession(target.canonicalSessionId)?.status;
    const accepted = enqueueBotMessage(host, { principal, senderBotId: sender.id, targetBotId: target.id,
      message: body, wake: !skip, relayHop: hop + 1, idempotencyKey: args.idempotencyKey, replyTo: args.replyTo,
      ...(sourceRoomId ? { sourceRoomId } : {}) });
    return toolJson(true, { ...accepted, delivered: !accepted.queued, targetId: target.id, targetName: target.name,
      ...(accepted.startedRun && (previous === 'failed' || previous === 'completed') ? { revivedFrom: previous } : {}),
      relayHop: hop + 1, woke: accepted.startedRun, ...(skip ? { skippedRun: skip } : {}),
      note: accepted.queued ? 'Accepted durably and queued until the recipient can execute.' : `Delivered and ${accepted.startedRun ? 'woke it' : 'did NOT wake it'}${previous === 'failed' || previous === 'completed' ? ` (previous run had ${previous})` : ''}. Its reply is NOT returned to this call; use tracked delegation for results.` });
  } catch (error) {
    if(error instanceof BotQueueCapacityError)return toolJson(false,{accepted:false,retryable:true,error_code:error.code,error:error.message,usage:error.usage,limits:error.limits});
    return toolJson(false, { error: error instanceof Error ? error.message : String(error), error_code: error instanceof Error && /principal|belongs/i.test(error.message) ? 'TARGET_OWNER_MISMATCH' : 'DELIVERY_FAILED', targetId: target.id });
  }
}
