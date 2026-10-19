export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** One dragged file. `text` is the extracted file body (possibly truncated). */
export interface ContextFileSource {
  kind: 'file';
  name: string;
  text: string;
}

export interface ContextFolderEntry {
  path: string;
  text: string;
}

/** One dragged folder. Entry `text` is the file body (possibly truncated). */
export interface ContextFolderSource {
  kind: 'folder';
  name: string;
  entries: ContextFolderEntry[];
}

export type ContextSource = ContextFileSource | ContextFolderSource;

export interface TextPart {
  type: 'text';
  text: string;
  /**
   * Dragged file/folder context persisted on the user message that carried it.
   * Model adapters read `text` only; this field is for reload and display.
   */
  contextSources?: ContextSource[];
}

/** Chain-of-thought / reasoning from the model (persisted for UI; replayed to the API as text). */
export interface ReasoningPart {
  type: 'reasoning';
  text: string;
}

/** Tier for image memory policy (hot=recent full res, warm=contact sheet / keyframe, cold=text-only archive). */
export type ImageRetentionTier = 'hot' | 'warm' | 'cold';

export interface ImagePart {
  type: 'image';
  assetId: string;
  mimeType: string;
  alt?: string;
  sourceUrl?: string;
  /** Denormalized; source of truth is image_assets table. */
  retentionTier?: ImageRetentionTier;
}

export interface ToolCallPart {
  type: 'tool_call';
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * RFC 9457 / RFC 7807-style problem object for tool failures so agents can branch
 * on `code` / `type` without scraping prose from `content`.
 */
export interface HttpProblemDetails {
  /** URI reference that identifies the problem type. */
  type?: string;
  title: string;
  status?: number;
  detail: string;
  instance?: string;
  /** Stable machine code (extension) for harness / recovery logic. */
  code?: string;
}

export interface ToolResultPart {
  type: 'tool_result';
  toolCallId: string;
  name: string;
  content: string;
  ok: boolean;
  isExternal?: boolean;
  /** Present when the runtime attaches machine-readable failure metadata. */
  problem?: HttpProblemDetails;
}

/**
 * A2UI surface payload persisted on the assistant turn that produced it.
 *
 * `messages` is intentionally typed as `unknown[]` so this package stays free
 * of a2ui imports; callers cast to A2uiMessage[] at the boundary.
 */
export interface SurfaceUpdatePart {
  type: 'surface_update';
  surfaceId: string;
  catalogId: string;
  /** Sequence of A2uiMessage envelopes (createSurface / updateComponents / updateDataModel / deleteSurface). */
  messages: unknown[];
}

export type MessagePart =
  | TextPart
  | ReasoningPart
  | ImagePart
  | ToolCallPart
  | ToolResultPart
  | SurfaceUpdatePart;
