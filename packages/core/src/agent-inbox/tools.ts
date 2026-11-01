/**
 * Agent inbox tools: list_email_inboxes, claim_email_inbox, search_email_threads, read_email_thread.
 */

import type { ToolContract, ToolExecutionResult } from '../types.js';
import type { AgentInboxPort, EmailMessage } from './port.js';
import type { BotPrincipal } from '../bots/bot-identity.js';
import type { RunContext } from '../types.js';
import { ValidationError, NotFoundError } from '../errors.js';
import { principalFromSession } from '../bots/bot-identity.js';

function fenceEmailBody(message: EmailMessage): string {
  const body = message.body.trim();
  return `[untrusted source=email label=message-body] ${body}`;
}

function handleError(error: unknown): ToolExecutionResult {
  if (error instanceof NotFoundError) {
    return {
      ok: false,
      content: JSON.stringify({
        error: 'no_claimed_inbox',
        message: 'No claimed inbox. Use claim_email_inbox first.'
      })
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, content: JSON.stringify({ error: 'ERROR', message }) };
}

export function createAgentInboxTools(
  store: import('../storage.js').SqliteStateStore | undefined,
  port: AgentInboxPort | undefined
): ToolContract<any>[] {
  if (!store || !port) return [];

  return [
    {
      name: 'list_email_inboxes',
      description: 'List claimed agent native email inboxes (at most 1 per user).',
      approvalMode: 'never',
      sideEffectLevel: 'none',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      async execute(context: RunContext) {
        try {
          const principal = principalFromSession(store, context.session);
          const inbox = port.list(principal);
          return {
            ok: true,
            content: JSON.stringify({ inbox: inbox ?? null })
          };
        } catch (error) {
          return handleError(error);
        }
      }
    },
    {
      name: 'claim_email_inbox',
      description:
        'Claim a local-part@product-domain email inbox. Requires explicit local-part naming (no guessing/random). One per user.',
      approvalMode: 'auto',
      sideEffectLevel: 'heavy',
      inputSchema: {
        type: 'object',
        properties: {
          local_part: {
            type: 'string',
            description: 'Local part of email address (lowercase alphanumeric, dots, hyphens, underscores)'
          }
        },
        required: ['local_part'],
        additionalProperties: false
      },
      async execute(context: RunContext, args: Record<string, unknown>) {
        try {
          const principal = principalFromSession(store, context.session);
          const localPart = args.local_part;

          if (typeof localPart !== 'string') {
            throw new ValidationError('local_part must be string');
          }

          const existing = port.list(principal);
          if (existing) {
            return {
              ok: false,
              content: JSON.stringify({
                error: 'already_claimed',
                message: `Already claimed ${existing.address}`,
                existingInbox: existing
              })
            };
          }

          const availability = port.checkAvailability(localPart);
          if (!availability.available) {
            return {
              ok: false,
              content: JSON.stringify({
                error: 'invalid_local_part',
                message: availability.reason ?? 'Invalid local-part format'
              })
            };
          }

          const inbox = port.claim(principal, localPart);
          return {
            ok: true,
            content: JSON.stringify({ inbox })
          };
        } catch (error) {
          return handleError(error);
        }
      }
    },
    {
      name: 'search_email_threads',
      description: 'Search email threads in the claimed inbox. Returns threads matching query (subject/participants).',
      approvalMode: 'never',
      sideEffectLevel: 'none',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Optional search query for subject or participants'
          },
          limit: {
            type: 'number',
            description: 'Max threads to return (default 50)'
          }
        },
        additionalProperties: false
      },
      async execute(context: RunContext, args: Record<string, unknown>) {
        try {
          const principal = principalFromSession(store, context.session);
          const query = typeof args.query === 'string' ? args.query : undefined;
          const limit = typeof args.limit === 'number' ? args.limit : 50;

          const threads = port.searchThreads(principal, query, limit);
          return {
            ok: true,
            content: JSON.stringify({ threads })
          };
        } catch (error) {
          return handleError(error);
        }
      }
    },
    {
      name: 'read_email_thread',
      description: 'Read all messages in an email thread. Message bodies are fenced as untrusted content.',
      approvalMode: 'never',
      sideEffectLevel: 'none',
      inputSchema: {
        type: 'object',
        properties: {
          thread_id: {
            type: 'string',
            description: 'Thread ID from search_email_threads'
          }
        },
        required: ['thread_id'],
        additionalProperties: false
      },
      async execute(context: RunContext, args: Record<string, unknown>) {
        try {
          const principal = principalFromSession(store, context.session);
          const threadId = args.thread_id;

          if (typeof threadId !== 'string') {
            throw new ValidationError('thread_id must be string');
          }

          const messages = port.readThread(principal, threadId);

          // Fence each message body as untrusted
          const fencedMessages = messages.map((msg) => ({
            messageId: msg.messageId,
            threadId: msg.threadId,
            from: msg.from,
            to: msg.to,
            cc: msg.cc,
            subject: msg.subject,
            receivedAt: msg.receivedAt,
            body: fenceEmailBody(msg)
          }));

          return {
            ok: true,
            content: JSON.stringify({ messages: fencedMessages })
          };
        } catch (error) {
          return handleError(error);
        }
      }
    }
  ];
}
