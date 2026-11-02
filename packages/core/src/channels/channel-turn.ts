/**
 * Channel turn adapter (L6 IM / webhook) — normalize inbound messages →
 * agent turn → outbound reply. Not the L3 session turn kernel.
 */

export type ChannelInboundKind = 'message' | 'command' | 'callback';

export interface ChannelInboundEnvelope {
  channelId: string;
  channelType: string;
  kind: ChannelInboundKind;
  /** Stable conversation / thread key */
  conversationKey: string;
  senderId?: string;
  text: string;
  /** Email / claimed-inbox message-id for reply threading (r5-25). */
  messageId?: string;
  /** Original subject of the inbound message (r5-25 replyToSubject). */
  subject?: string;
  raw?: unknown;
}

export interface ChannelOutboundEnvelope {
  channelId: string;
  conversationKey: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelTurnResult {
  reply?: ChannelOutboundEnvelope;
  sessionId?: string;
  error?: string;
}

export interface ChannelTurnKernelDeps {
  /** Run one user message against an agent; returns assistant text */
  runAgentTurn: (input: {
    agentId: string;
    conversationKey: string;
    text: string;
    channelId: string;
  }) => Promise<{ sessionId: string; assistantText: string }>;
  defaultAgentId?: string;
  /** Optional allowlist of sender ids */
  allowedSenders?: Set<string>;
}

/**
 * Process one inbound envelope. Blocks empty text and disallowed senders.
 */
export async function processChannelTurn(
  inbound: ChannelInboundEnvelope,
  deps: ChannelTurnKernelDeps
): Promise<ChannelTurnResult> {
  const text = inbound.text.trim();
  if (!text) {
    return { error: 'empty_message' };
  }
  if (deps.allowedSenders && (!inbound.senderId || !deps.allowedSenders.has(inbound.senderId))) {
    return { error: 'sender_not_allowed' };
  }

  // Slash commands that must not start a model turn
  if (text === '/ping') {
    return {
      reply: {
        channelId: inbound.channelId,
        conversationKey: inbound.conversationKey,
        text: 'pong'
      }
    };
  }

  const agentId = deps.defaultAgentId ?? 'general';
  try {
    const { sessionId, assistantText } = await deps.runAgentTurn({
      agentId,
      conversationKey: inbound.conversationKey,
      text,
      channelId: inbound.channelId
    });
    return {
      sessionId,
      reply: {
        channelId: inbound.channelId,
        conversationKey: inbound.conversationKey,
        text: assistantText || '(no reply)',
        metadata: { sessionId }
      }
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Parse a generic webhook JSON body into an inbound envelope (Telegram-ish / custom). */
export function parseGenericWebhookInbound(
  channelId: string,
  channelType: string,
  body: Record<string, unknown>
): ChannelInboundEnvelope | undefined {
  // Telegram Update
  const message = (body.message ?? body.edited_message) as
    | { text?: string; chat?: { id?: number | string }; from?: { id?: number | string } }
    | undefined;
  const messageId =
    typeof body.messageId === 'string' && body.messageId.trim()
      ? body.messageId.trim()
      : typeof body.message_id === 'string' && body.message_id.trim()
        ? body.message_id.trim()
        : undefined;
  const subject = typeof body.subject === 'string' ? body.subject : undefined;

  if (message?.text && message.chat?.id != null) {
    return {
      channelId,
      channelType,
      kind: 'message',
      conversationKey: String(message.chat.id),
      senderId: message.from?.id != null ? String(message.from.id) : undefined,
      text: message.text,
      ...(messageId ? { messageId } : {}),
      ...(subject !== undefined ? { subject } : {}),
      raw: body
    };
  }

  // Generic { text, conversationKey?, senderId?, messageId?, subject? }
  if (typeof body.text === 'string') {
    return {
      channelId,
      channelType,
      kind: 'message',
      conversationKey: String(body.conversationKey ?? body.chatId ?? body.senderId ?? 'default'),
      senderId: body.senderId != null ? String(body.senderId) : undefined,
      text: body.text,
      ...(messageId ? { messageId } : {}),
      ...(subject !== undefined ? { subject } : {}),
      raw: body
    };
  }

  return undefined;
}
