import type { AgentInboxPort, EmailMessage } from './port.js';
import { stripEmailTag } from './port.js';

/** Extract local-part from an address like `name+tag@domain` or bare local-part. */
export function localPartFromAddress(address: string): string | undefined {
  const raw = address.trim().toLowerCase();
  if (!raw) return undefined;
  const at = raw.indexOf('@');
  const local = (at >= 0 ? raw.slice(0, at) : raw).trim();
  if (!local) return undefined;
  return local;
}

/**
 * Product-domain inbound: store a message for a claimed local-part (+tag ok).
 * Does not require external HMAC — used by email/received binding and direct ingest.
 */
export function ingestProductDomainEmail(
  port: AgentInboxPort,
  input: {
    to: string | string[];
    from: string;
    subject: string;
    body: string;
    messageId?: string;
    threadId?: string;
    receivedAt?: string;
    cc?: string[];
  }
): { stored: boolean; localPart?: string; reason?: string } {
  const recipients = Array.isArray(input.to) ? input.to : [input.to];
  let target: string | undefined;
  for (const addr of recipients) {
    const local = localPartFromAddress(addr);
    if (!local) continue;
    const base = stripEmailTag(local);
    if (port.ownerOfLocalPart(base)) {
      target = local;
      break;
    }
  }
  if (!target) return { stored: false, reason: 'no_claimed_recipient' };

  const messageId =
    input.messageId?.trim() ||
    `prod:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  const threadId = input.threadId?.trim() || messageId;
  const message: EmailMessage = {
    messageId,
    threadId,
    from: input.from,
    to: recipients,
    cc: input.cc,
    subject: input.subject,
    receivedAt: input.receivedAt ?? new Date().toISOString(),
    body: input.body
  };
  port.storeInbound(target, message);
  return { stored: true, localPart: stripEmailTag(target) };
}

/**
 * Whether an email/received job should run for this delivery given optional bind.
 * `bindLocalPart` may include +tag; matching uses strip-tag equality against claimed inbox.
 */
export function emailReceivedMatchesBind(
  port: AgentInboxPort,
  principal: { userId: string; botId?: string },
  bindLocalPart: string | undefined,
  recipientAddresses: string[]
): boolean {
  if (!bindLocalPart) {
    // Unbound: accept if any recipient matches the principal's claimed inbox (+tag ok).
    const inbox = port.list(principal);
    if (!inbox) return true; // no claim yet — keep webhook compatibility
    return recipientAddresses.some((addr) => {
      const local = localPartFromAddress(addr);
      return local ? port.matchesClaimedInbox(principal, local) : false;
    });
  }
  return recipientAddresses.some((addr) => {
    const local = localPartFromAddress(addr);
    if (!local) return false;
    const base = stripEmailTag(local);
    const bindBase = stripEmailTag(bindLocalPart.toLowerCase());
    if (base !== bindBase) return false;
    return port.matchesClaimedInbox(principal, local);
  });
}

export function recipientsFromEmailBody(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const rec = body as Record<string, unknown>;
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
    else if (Array.isArray(v)) for (const item of v) if (typeof item === 'string' && item.trim()) out.push(item.trim());
  };
  push(rec.to);
  push(rec.recipient);
  push(rec.recipients);
  const envelope = rec.envelope;
  if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
    push((envelope as Record<string, unknown>).to);
  }
  return out;
}

export function productEmailFieldsFromBody(body: unknown, deliveryId: string): {
  from: string;
  subject: string;
  text: string;
  messageId: string;
  threadId: string;
} | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const rec = body as Record<string, unknown>;
  const from = typeof rec.from === 'string' ? rec.from : typeof rec.sender === 'string' ? rec.sender : '';
  const subject = typeof rec.subject === 'string' ? rec.subject : '(no subject)';
  const text =
    typeof rec.text === 'string'
      ? rec.text
      : typeof rec.body === 'string'
        ? rec.body
        : typeof rec.html === 'string'
          ? rec.html
          : '';
  const messageId =
    typeof rec.messageId === 'string'
      ? rec.messageId
      : typeof rec.message_id === 'string'
        ? rec.message_id
        : deliveryId;
  const threadId =
    typeof rec.threadId === 'string'
      ? rec.threadId
      : typeof rec.thread_id === 'string'
        ? rec.thread_id
        : messageId;
  return { from, subject, text, messageId, threadId };
}
