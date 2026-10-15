import type { BotFaceColor, BotFaceShape } from './bot-appearance.js';

export interface BotRecord {
  id: string;
  name: string;
  title: string;
  description: string;
  agentId: string;
  canonicalSessionId: string;
  hidden: boolean;
  /** Saved silhouette. Null keeps the name-based shape. */
  faceShape: BotFaceShape | null;
  /** Saved swatch. Null keeps the name-based color. */
  faceColor: BotFaceColor | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBotInput {
  name: string;
  title?: string;
  description?: string;
  /** Omitted or null keeps the name-based shape. */
  faceShape?: unknown;
  /** Omitted or null keeps the name-based color. */
  faceColor?: unknown;
}

export interface UpdateBotInput {
  name?: string;
  title?: string;
  description?: string;
  hidden?: boolean;
  /** 24, 48, or 96. Written onto this bot's canonical chats. */
  maxTurns?: unknown;
  /** Empty array clears the allowlist (full catalog). Unknown names are rejected. */
  allowedTools?: unknown;
  /** Empty array clears the allowlist (every skill). Unknown names are rejected. */
  allowedSkills?: unknown;
  /** `null` clears (follow global default). Otherwise { providerId, modelId } from the picker list. */
  modelOverride?: unknown;
  /** `null` clears the saved shape. Omitted leaves it unchanged. */
  faceShape?: unknown;
  /** `null` clears the saved color. Omitted leaves it unchanged. */
  faceColor?: unknown;
}

export interface ListBotsOptions {
  includeHidden?: boolean;
}

export interface OpenBotResult {
  bot: BotRecord;
  sessionId: string;
  createdSession: boolean;
}

export const BOT_NAME_MAX = 64;
export const BOT_TITLE_MAX = 80;
export const BOT_DESCRIPTION_MAX = 2000;
export const BOT_ROSTER_CAP = 50;

export const CANONICAL_BOT_CHAT_META = 'canonicalBotChat';
/** Bot 长对话走会话切割（autoCompact + fold budget），同一条 session 续聊。 */
export const SESSION_CUT_META = 'sessionCut';
/** New Bot chats default to auto. Existing modes are left alone on open. */
export const BOT_DEFAULT_PERMISSION_MODE = 'auto' as const;
export const BOT_DEFAULT_MAX_TURNS = 24;
