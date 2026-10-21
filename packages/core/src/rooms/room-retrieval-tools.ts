import { AuthorizationError } from '../errors.js';
import { principalFromSession, sameBotPrincipal, type BotPrincipal } from '../bots/bot-identity.js';
import { fenceExternalContent } from '../safety/external-content.js';
import { sourcePage } from '../session/history-retrieval.js';
import { readPagedArtifactSlice } from '../artifact/paged-artifact.js';
import type { SqliteStateStore } from '../storage.js';
import type { RunContext, ToolContract, ToolExecutionResult } from '../types.js';
import { assertRoomMemberAccess, listRoomMessages, type RoomTranscriptMessage } from './rolling-summary.js';

/** One read returns at most this many full messages. */
export const ROOM_HISTORY_READ_CAP = 20;

export const ROOM_RETRIEVAL_TOOL_NAMES = [
  'room_history_search',
  'room_history_read',
  'room_material_list',
  'room_material_read'
] as const;

interface RoomAttachment {
  id: string;
  sessionId: string;
  fileName: string;
  kind?: string;
  emitText?: string;
  artifactHandle?: string;
  imageAssetId?: string;
}

export interface RoomHistoryMatch {
  seq: number;
  messageId: string;
  senderName: string;
  createdAt: string;
  excerpt: string;
}

export interface RoomHistoryLine {
  seq: number;
  messageId: string;
  senderName: string;
  createdAt: string;
  text: string;
  attachmentIds: string[];
}

export interface RoomMaterialListing {
  materialId: string;
  name: string;
  kind: string;
  sourceSender: string;
  seq: number;
}

function bounded(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

function seqArg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

/** Same principal check BotRoomService uses before a room message may reference an attachment. */
export function roomAttachmentAllowed(store: SqliteStateStore, principal: BotPrincipal, attachment: RoomAttachment): boolean {
  const source = store.getSession(attachment.sessionId);
  if (!source || !sameBotPrincipal(principal, principalFromSession(store, source))) return false;
  if (!attachment.imageAssetId) return true;
  const image = store.getImageAsset(attachment.imageAssetId);
  const imageSession = image ? store.getSession(image.sessionId) : undefined;
  return Boolean(imageSession && sameBotPrincipal(principal, principalFromSession(store, imageSession)));
}

function attachmentOf(store: SqliteStateStore, id: string): RoomAttachment | undefined {
  const row = store.getAttachment(id);
  if (!row) return undefined;
  return row;
}

function messagesFor(store: SqliteStateStore, context: RunContext): { messages: RoomTranscriptMessage[]; principal: BotPrincipal } {
  const access = assertRoomMemberAccess(store, context.session);
  return { messages: listRoomMessages(store, access.roomId), principal: access.principal };
}

export function searchRoomMessages(
  messages: readonly RoomTranscriptMessage[],
  query: string,
  options: { senderBotId?: string; limit?: number } = {}
): RoomHistoryMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const limit = bounded(options.limit, 5, 20);
  const matches: RoomHistoryMatch[] = [];
  for (const message of messages) {
    if (options.senderBotId && message.sender.id !== options.senderBotId) continue;
    const at = message.text.toLocaleLowerCase().indexOf(needle);
    if (at < 0) continue;
    const start = Math.max(0, at - 80);
    matches.push({
      seq: message.seq,
      messageId: message.id,
      senderName: message.sender.name,
      createdAt: message.createdAt,
      excerpt: message.text.slice(start, start + 320)
    });
    if (matches.length === limit) break;
  }
  return matches;
}

export function readRoomMessages(
  messages: readonly RoomTranscriptMessage[],
  fromSeq: number,
  toSeq: number,
  limit?: number
): RoomHistoryLine[] {
  const cap = bounded(limit, ROOM_HISTORY_READ_CAP, ROOM_HISTORY_READ_CAP);
  return messages
    .filter(message => message.seq >= fromSeq && message.seq <= toSeq)
    .slice(0, cap)
    .map(message => ({
      seq: message.seq,
      messageId: message.id,
      senderName: message.sender.name,
      createdAt: message.createdAt,
      text: message.text,
      attachmentIds: message.attachmentIds
    }));
}

export function listRoomMaterials(
  store: SqliteStateStore,
  principal: BotPrincipal,
  messages: readonly RoomTranscriptMessage[]
): RoomMaterialListing[] {
  const seen = new Set<string>();
  const materials: RoomMaterialListing[] = [];
  for (const message of messages) {
    for (const materialId of message.attachmentIds) {
      if (seen.has(materialId)) continue;
      seen.add(materialId);
      const attachment = attachmentOf(store, materialId);
      if (!attachment || !roomAttachmentAllowed(store, principal, attachment)) continue;
      materials.push({
        materialId,
        name: attachment.fileName,
        kind: attachment.kind ?? 'file',
        sourceSender: message.sender.name,
        seq: message.seq
      });
    }
  }
  return materials;
}

const EXTERNAL_FENCE_START = '«external ';
const EXTERNAL_FENCE_END = '«end external»';

/** Ingest already fences emitText. Page the inner body, then fence the returned slice once. */
function unwrapExternalFence(text: string): string {
  if (!text.startsWith(EXTERNAL_FENCE_START) || !text.endsWith(EXTERNAL_FENCE_END)) return text;
  const headerEnd = text.indexOf('»\n');
  const footerAt = text.lastIndexOf(`\n${EXTERNAL_FENCE_END}`);
  if (headerEnd < 0 || footerAt <= headerEnd) return text;
  return text.slice(headerEnd + 2, footerAt);
}

function attachmentReference(attachment: RoomAttachment): string {
  return `Attachment reference: ${attachment.id}; artifact: ${attachment.artifactHandle ?? ''}`;
}

/**
 * Full text lives in the paged artifact under the uploader's session.
 * The room member's own session id does not contain that file.
 */
function archivedSlice(
  attachment: RoomAttachment,
  stateDir: string,
  offset?: number,
  limit?: number
): { text: string; offset: number; nextOffset: number | null; totalChars: number } | undefined {
  if (!attachment.artifactHandle || !stateDir) return undefined;
  const startOffset = typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  try {
    const page = readPagedArtifactSlice({
      stateDir,
      sessionId: attachment.sessionId,
      handle: attachment.artifactHandle,
      startOffset,
      maxChars: typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? limit : undefined
    });
    return {
      text: page.content,
      offset: page.startOffset,
      nextOffset: page.hasNext ? page.endOffset : null,
      totalChars: page.totalChars
    };
  } catch {
    return undefined;
  }
}

export function readRoomMaterial(
  store: SqliteStateStore,
  principal: BotPrincipal,
  messages: readonly RoomTranscriptMessage[],
  materialId: string,
  options: { offset?: number; limit?: number; stateDir?: string } = {}
): { materialId: string; name: string; text: string; offset: number; nextOffset: number | null; totalChars: number } {
  const linked = messages.some(message => message.attachmentIds.includes(materialId));
  const attachment = linked ? attachmentOf(store, materialId) : undefined;
  if (!attachment || !roomAttachmentAllowed(store, principal, attachment)) throw new AuthorizationError();
  const inline = unwrapExternalFence(attachment.emitText ?? '') || attachmentReference(attachment);
  const page = archivedSlice(attachment, options.stateDir ?? '', options.offset, options.limit)
    ?? sourcePage(inline, options.offset, options.limit);
  return {
    materialId,
    name: attachment.fileName,
    text: fenceExternalContent({ source: 'attachment', label: attachment.fileName, body: page.text }),
    offset: page.offset,
    nextOffset: page.nextOffset,
    totalChars: page.totalChars
  };
}

function denied(error: unknown): ToolExecutionResult {
  return { ok: false, content: error instanceof Error && error.message ? error.message : 'Forbidden' };
}

/** Read-only room tools. They follow session.metadata.roomId and ignore any room id in the arguments. */
export function createRoomRetrievalTools(store: SqliteStateStore): ToolContract<Record<string, unknown>>[] {
  const search: ToolContract<Record<string, unknown>> = {
    name: 'room_history_search',
    description: 'Search this room\'s messages by keyword. Returns excerpts from this room only, never other rooms or private chats. Use room_history_read for the full text.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        senderBotId: { type: 'string' },
        limit: { type: 'number' }
      },
      required: ['query']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc: { kind: 'read' },
    async execute(context, args): Promise<ToolExecutionResult> {
      try {
        if (typeof args.query !== 'string' || !args.query.trim()) return { ok: false, content: 'query is required' };
        const senderBotId = typeof args.senderBotId === 'string' ? args.senderBotId : undefined;
        const { messages } = messagesFor(store, context);
        return { ok: true, content: JSON.stringify({ matches: searchRoomMessages(messages, args.query, { senderBotId, limit: args.limit as number | undefined }) }) };
      } catch (error) {
        return denied(error);
      }
    }
  };

  const read: ToolContract<Record<string, unknown>> = {
    name: 'room_history_read',
    description: 'Read up to 20 full messages from this room by seq range, including attachment ids. Does not read other rooms or private chats.',
    inputSchema: {
      type: 'object',
      properties: {
        fromSeq: { type: 'integer' },
        toSeq: { type: 'integer' },
        limit: { type: 'integer' }
      },
      required: ['fromSeq', 'toSeq']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc: { kind: 'read' },
    async execute(context, args): Promise<ToolExecutionResult> {
      try {
        const fromSeq = seqArg(args.fromSeq);
        const toSeq = seqArg(args.toSeq);
        if (fromSeq === undefined || toSeq === undefined || toSeq < fromSeq) return { ok: false, content: 'fromSeq and toSeq are required' };
        const { messages } = messagesFor(store, context);
        return { ok: true, content: JSON.stringify({ messages: readRoomMessages(messages, fromSeq, toSeq, args.limit as number | undefined) }) };
      } catch (error) {
        return denied(error);
      }
    }
  };

  const list: ToolContract<Record<string, unknown>> = {
    name: 'room_material_list',
    description: 'List attachments linked to this room that the room owner can read.',
    inputSchema: { type: 'object', properties: {} },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc: { kind: 'read' },
    async execute(context): Promise<ToolExecutionResult> {
      try {
        const { messages, principal } = messagesFor(store, context);
        return { ok: true, content: JSON.stringify({ materials: listRoomMaterials(store, principal, messages) }) };
      } catch (error) {
        return denied(error);
      }
    }
  };

  const material: ToolContract<Record<string, unknown>> = {
    name: 'room_material_read',
    description: 'Read one attachment linked to this room. offset and limit page the file text. The body is fenced as untrusted attachment text.',
    inputSchema: {
      type: 'object',
      properties: {
        materialId: { type: 'string' },
        offset: { type: 'integer' },
        limit: { type: 'integer' }
      },
      required: ['materialId']
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc: { kind: 'read' },
    async execute(context, args): Promise<ToolExecutionResult> {
      try {
        if (typeof args.materialId !== 'string' || !args.materialId.trim()) return { ok: false, content: 'materialId is required' };
        const { messages, principal } = messagesFor(store, context);
        const page = readRoomMaterial(store, principal, messages, args.materialId, {
          offset: args.offset as number | undefined,
          limit: args.limit as number | undefined,
          stateDir: context.stateDir
        });
        return { ok: true, content: JSON.stringify(page) };
      } catch (error) {
        return denied(error);
      }
    }
  };

  return [search, read, list, material];
}
