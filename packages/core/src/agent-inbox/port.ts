import { ValidationError, NotFoundError } from '../errors.js';
import type { SqliteStateStore } from '../storage.js';
import {
  botPrincipalKey,
  type BotPrincipal
} from '../bots/bot-identity.js';

/**
 * Agent-native email inbox port.
 * 
 * Per user at most 1 claimed local-part@product-domain.
 * Product-domain inbound does not depend only on external HMAC relay.
 */

const LOCAL_PART = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;

export interface AgentInbox {
  localPart: string;
  /** Fully qualified address: `${localPart}@${productDomain}` */
  address: string;
  claimedAt: string;
}

export interface EmailThread {
  threadId: string;
  subject: string;
  participants: string[];
  lastReceivedAt: string;
  messageCount: number;
  snippet?: string;
}

export interface EmailMessage {
  messageId: string;
  threadId: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  receivedAt: string;
  /** Raw body text - MUST be fenced as untrusted by tools */
  body: string;
}

export interface AgentInboxPort {
  /**
   * Check if a local-part is available for claiming.
   * Forbids guessing/random usernames - validates format only.
   */
  checkAvailability(localPart: string): { available: boolean; reason?: string };
  
  /**
   * List claimed inbox for the principal (at most 1).
   */
  list(principal: BotPrincipal): AgentInbox | undefined;
  
  /**
   * Claim a local-part@product-domain inbox.
   * Requires explicit local-part naming. One per user.
   */
  claim(principal: BotPrincipal, localPart: string): AgentInbox;
  
  /**
   * Release the claimed inbox.
   */
  release(principal: BotPrincipal): boolean;
  
  /**
   * Search email threads for a claimed inbox.
   * Returns threads matching query (subject/participants).
   */
  searchThreads(principal: BotPrincipal, query?: string, limit?: number): EmailThread[];
  
  /**
   * Read all messages in a thread.
   */
  readThread(principal: BotPrincipal, threadId: string): EmailMessage[];
  
  /**
   * Store an inbound email message.
   * Used by email/received routine.
   */
  storeInbound(localPart: string, message: EmailMessage): void;
  
  /**
   * Check if a localPart (including +tag) matches a claimed inbox.
   */
  matchesClaimedInbox(principal: BotPrincipal, localPart: string): boolean;
}

interface StoredInbox {
  localPart: string;
  claimedAt: string;
}

interface StoredMessage {
  messageId: string;
  threadId: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  receivedAt: string;
  body: string;
}

function inboxKey(principal: BotPrincipal): string {
  return 'agent.inbox:' + botPrincipalKey(principal);
}

function messagesKey(localPart: string): string {
  return 'agent.inbox.messages:' + localPart;
}

function parseLocalPart(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('localPart must be string');
  const clean = value.trim().toLowerCase();
  if (!LOCAL_PART.test(clean)) {
    throw new ValidationError('Invalid localPart format');
  }
  return clean;
}

function stripTag(localPart: string): string {
  const plusIndex = localPart.indexOf('+');
  return plusIndex >= 0 ? localPart.slice(0, plusIndex) : localPart;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createAgentInboxPort(
  store: SqliteStateStore,
  productDomain: string = 'agent.local'
): AgentInboxPort {
  function requireClaimed(principal: BotPrincipal): AgentInbox {
    const key = inboxKey(principal);
    const stored = store.getDaemonControl<StoredInbox>(key);
    if (!stored || !stored.localPart) {
      throw new NotFoundError('AgentInbox', 'No claimed inbox');
    }
    return {
      localPart: stored.localPart,
      address: `${stored.localPart}@${productDomain}`,
      claimedAt: stored.claimedAt
    };
  }
  
  function readMessages(localPart: string): StoredMessage[] {
    const key = messagesKey(stripTag(localPart));
    const stored = store.getDaemonControl<{ messages: StoredMessage[] }>(key);
    return stored?.messages ?? [];
  }
  
  function writeMessages(localPart: string, messages: StoredMessage[]): void {
    const key = messagesKey(stripTag(localPart));
    store.setDaemonControl(key, { messages });
  }

  return {
    checkAvailability(localPart) {
      try {
        parseLocalPart(localPart);
        return { available: true };
      } catch (err) {
        return { 
          available: false, 
          reason: err instanceof Error ? err.message : 'Invalid format' 
        };
      }
    },
    
    list(principal) {
      const key = inboxKey(principal);
      const stored = store.getDaemonControl<StoredInbox>(key);
      if (!stored || !stored.localPart) return undefined;
      return {
        localPart: stored.localPart,
        address: `${stored.localPart}@${productDomain}`,
        claimedAt: stored.claimedAt
      };
    },
    
    claim(principal, localPart) {
      const clean = parseLocalPart(localPart);
      const key = inboxKey(principal);
      const inbox: StoredInbox = {
        localPart: clean,
        claimedAt: nowIso()
      };
      store.setDaemonControl(key, inbox);
      return {
        localPart: clean,
        address: `${clean}@${productDomain}`,
        claimedAt: inbox.claimedAt
      };
    },
    
    release(principal) {
      const key = inboxKey(principal);
      const existed = store.getDaemonControl<StoredInbox>(key);
      if (!existed || !existed.localPart) return false;
      store.setDaemonControl(key, null);
      return true;
    },
    
    searchThreads(principal, query, limit = 50) {
      const inbox = requireClaimed(principal);
      const messages = readMessages(inbox.localPart);
      
      // Group by threadId
      const threads = new Map<string, EmailMessage[]>();
      for (const msg of messages) {
        if (!threads.has(msg.threadId)) threads.set(msg.threadId, []);
        threads.get(msg.threadId)!.push(msg as EmailMessage);
      }
      
      const results: EmailThread[] = [];
      for (const entry of Array.from(threads.entries())) {
        const [threadId, msgs] = entry;
        const sorted = msgs.sort((a, b) => 
          new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
        );
        const latest = sorted[0];
        if (!latest) continue;
        
        // Filter by query if provided
        if (query) {
          const lowerQuery = query.toLowerCase();
          const matchSubject = latest.subject.toLowerCase().includes(lowerQuery);
          const matchParticipants = [latest.from, ...latest.to]
            .some(p => p.toLowerCase().includes(lowerQuery));
          if (!matchSubject && !matchParticipants) continue;
        }
        
        const participants = Array.from(
          new Set([latest.from, ...latest.to, ...(latest.cc ?? [])])
        );
        
        results.push({
          threadId,
          subject: latest.subject,
          participants,
          lastReceivedAt: latest.receivedAt,
          messageCount: msgs.length,
          snippet: latest.body.slice(0, 200)
        });
      }
      
      // Sort by most recent first
      results.sort((a, b) => 
        new Date(b.lastReceivedAt).getTime() - new Date(a.lastReceivedAt).getTime()
      );
      
      return results.slice(0, limit);
    },
    
    readThread(principal, threadId) {
      const inbox = requireClaimed(principal);
      const messages = readMessages(inbox.localPart);
      
      const thread = messages
        .filter(m => m.threadId === threadId)
        .sort((a, b) => 
          new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime()
        );
      
      return thread as EmailMessage[];
    },
    
    storeInbound(localPart, message) {
      const clean = stripTag(localPart);
      const messages = readMessages(clean);
      
      // Dedupe by messageId
      const exists = messages.some(m => m.messageId === message.messageId);
      if (exists) return;
      
      messages.push({
        messageId: message.messageId,
        threadId: message.threadId,
        from: message.from,
        to: message.to,
        cc: message.cc,
        subject: message.subject,
        receivedAt: message.receivedAt,
        body: message.body
      });
      
      // Keep last 500 messages
      if (messages.length > 500) {
        messages.sort((a, b) => 
          new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
        );
        messages.splice(500);
      }
      
      writeMessages(clean, messages);
    },
    
    matchesClaimedInbox(principal, localPart) {
      const inbox = this.list(principal);
      if (!inbox) return false;
      const cleanInput = stripTag(localPart.toLowerCase());
      return cleanInput === inbox.localPart;
    }
  };
}
