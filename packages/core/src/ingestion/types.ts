/**
 * Five-stage attachment ingestion types.
 * Progressive union: Raw → Fetched → Classified → Decoded → Resolved.
 */

export type AttachmentSource = 'upload' | 'url';

export type AttachmentKind = 'image' | 'rawtext' | 'workspace' | 'unsupported';

export type SourceSpec =
  | { via: 'upload'; base64: string; mimeType?: string }
  | { via: 'url'; url: string; mimeType?: string }
  | { via: 'none' };

export interface RawAttachment {
  source: AttachmentSource;
  fileName: string;
  index: number;
  spec: SourceSpec;
  declaredSize?: number;
  mimeType?: string;
}

export interface FetchedPayload {
  buffer?: Buffer;
  mimeType?: string;
  url?: string;
  error?: string;
  skip?: boolean;
  skipReason?: string;
}

export interface FetchedAttachment extends RawAttachment {
  fetched: FetchedPayload;
}

export interface ClassifiedAttachment extends FetchedAttachment {
  kind: AttachmentKind;
  reason?: string;
}

export interface DecodedAttachment extends ClassifiedAttachment {
  decodedText?: string;
  encoding?: 'utf-8' | 'gbk';
}

export type StorageRoute =
  | { mode: 'inline'; text: string }
  | { mode: 'archive'; handle: string; preview: string; pages: number }
  | { mode: 'archive-failed'; reason: string }
  | {
      mode: 'workspace';
      relPath: string;
      handle?: string;
      text?: string;
      truncated?: boolean;
      textUnavailable?: string;
      pdfPlaceholder?: boolean;
    }
  | { mode: 'workspace-failed'; reason: string }
  | { mode: 'inline-image'; imageAssetId: string }
  | { mode: 'unsupported'; reason: string }
  | { mode: 'skip'; reason?: string };

export interface ResolvedAttachment extends DecodedAttachment {
  route: StorageRoute;
}

export type IngestContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; imageAssetId: string };

export interface PerAttachmentResult {
  index: number;
  parts: IngestContentPart[];
  images: number;
  fatalError?: Error;
}
