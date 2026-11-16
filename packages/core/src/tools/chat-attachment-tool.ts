import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SqliteStateStore } from '../storage.js';
import type { ToolContract } from '../types.js';
import { fenceExternalContent } from '../safety/external-content.js';
import { decodeTextBytes } from '../ingestion/encoding-policy.js';
import type { AttachmentRecord } from '../ingestion/attachment-ingest-service.js';

type ReadArgs = { id?: string; offset?: number; maxChars?: number };

async function attachmentText(row: AttachmentRecord, stateDir: string) {
  if (row.kind === 'rawtext' && row.localRelPath) {
    const bytes = await readFile(join(stateDir, row.localRelPath));
    return decodeTextBytes(bytes, row.encoding === 'gbk').text;
  }
  return row.emitText ?? '';
}

export function chatAttachmentTool(store: SqliteStateStore): ToolContract<ReadArgs> {
  return {
    name: 'read_chat_attachment',
    description:
      'List versions sent in this conversation in message order. Pass an id to reopen an original, including after compaction. Offset is a list index or a character offset when reading. Images return pixels or can be inspected with vision_analyze using the image asset id. Search longer documents using the returned archive handle.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        maxChars: { type: 'integer', minimum: 1, maximum: 16000 }
      },
      additionalProperties: false
    },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    ptc: { kind: 'read' },
    async execute(context, args) {
      const rows = store.listSentAttachments(context.session.id);
      const offset = Math.max(0, Math.trunc(args.offset ?? 0));
      if (!args.id) {
        return {
          ok: true,
          content: JSON.stringify({ versions: rows.slice(offset, offset + 50), total: rows.length, offset })
        };
      }

      const row = rows.some((entry) => entry.id === args.id) ? store.getAttachment(args.id) : undefined;
      if (!row) return { ok: false, content: 'Attachment unavailable in this conversation.' };
      if (row.imageAssetId) {
        const asset = store.getImageAsset(row.imageAssetId);
        if (asset?.sessionId !== context.session.id)
          return { ok: false, content: 'Original image unavailable.' };
        await access(join(context.stateDir, asset.localRelPath));
        store.updateImageAsset(asset.id, { retentionTier: 'hot', lastAccessAt: new Date().toISOString() });
        return {
          ok: true,
          content: JSON.stringify({ file: row.fileName, id: row.id, imageAssetId: asset.id }),
          images: [{ type: 'image', assetId: asset.id, mimeType: asset.mimeType }]
        };
      }

      const text = await attachmentText(row, context.stateDir);
      const limit = Math.min(16000, Math.max(1, args.maxChars ?? 12000));
      const chunk = text.slice(offset, offset + limit);
      return {
        ok: true,
        content: JSON.stringify({
          file: row.fileName,
          id: row.id,
          offset,
          totalChars: text.length,
          archive: row.artifactHandle,
          content: fenceExternalContent({ source: 'attachment', label: row.fileName, body: chunk })
        })
      };
    }
  };
}
