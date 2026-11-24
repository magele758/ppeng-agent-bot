/**
 * Local coding-agent CLI tools (`claude_code`, `codex_exec`, `cursor_agent`).
 *
 * Settings live in Lab KV (`daemon_control`), with `RAW_AGENT_EXTERNAL_AI_TOOLS`
 * kept only as the CI / unpersisted fallback. Never auto-enabled solely from
 * binaries present on PATH.
 */

import { envBool } from '../env.js';
import { ValidationError } from '../errors.js';
import { nowIso } from '../id.js';

export const EXTERNAL_AI_SETTINGS_KEY = 'external_ai_settings';

export const EXTERNAL_AI_TOOL_NAMES = ['claude_code', 'codex_exec', 'cursor_agent'] as const;

export type ExternalAiToolName = (typeof EXTERNAL_AI_TOOL_NAMES)[number];
export type PreferredExternalAiTool = 'auto' | ExternalAiToolName;

const VALID_PREFERRED_TOOLS = new Set<string>(['auto', ...EXTERNAL_AI_TOOL_NAMES]);
const VALID_PATCH_KEYS = new Set<string>(['enabled', 'allowInBotChats', 'preferredTool', 'cursorAgentModel']);
const CURSOR_MODEL_MAX_CHARS = 128;

export interface ExternalAiSettings {
  /** Master switch for local coding-agent CLI tools. */
  enabled: boolean;
  /** Whether Bot chats may invoke local coding-agent tools without per-session opt-in metadata. */
  allowInBotChats: boolean;
  /** Preferred coding agent when multiple CLIs are installed; 'auto' lets the Bot pick. */
  preferredTool: PreferredExternalAiTool;
  /** Optional model override for cursor_agent (blank uses env / default composer-2-fast). */
  cursorAgentModel: string;
  updatedAt: string;
}

export interface ExternalAiSettingsPatch {
  enabled?: unknown;
  allowInBotChats?: unknown;
  preferredTool?: unknown;
  cursorAgentModel?: unknown;
}

export interface ExternalAiSettingsReadStore {
  getDaemonControl?(key: string): unknown;
}

export interface ExternalAiSettingsStore extends ExternalAiSettingsReadStore {
  getDaemonControl(key: string): unknown;
  setDaemonControl(key: string, value: unknown): void;
}

function isReadStore(store: unknown): store is ExternalAiSettingsReadStore {
  return Boolean(store && typeof (store as ExternalAiSettingsReadStore).getDaemonControl === 'function');
}

export function defaultExternalAiSettings(): ExternalAiSettings {
  return {
    enabled: false,
    allowInBotChats: true,
    preferredTool: 'auto',
    cursorAgentModel: '',
    updatedAt: nowIso()
  };
}

function normalizePreferredTool(raw: unknown): PreferredExternalAiTool {
  if (typeof raw === 'string' && VALID_PREFERRED_TOOLS.has(raw)) {
    return raw as PreferredExternalAiTool;
  }
  return 'auto';
}

function normalizeCursorAgentModel(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > CURSOR_MODEL_MAX_CHARS || /\s/.test(trimmed)) return '';
  return trimmed;
}

export function normalizeExternalAiSettings(
  raw: Partial<ExternalAiSettings> | null | undefined
): ExternalAiSettings {
  const base = defaultExternalAiSettings();
  if (!raw || typeof raw !== 'object') return base;
  return {
    enabled: Boolean(raw.enabled),
    allowInBotChats: typeof raw.allowInBotChats === 'boolean' ? raw.allowInBotChats : true,
    preferredTool: normalizePreferredTool(raw.preferredTool),
    cursorAgentModel: normalizeCursorAgentModel(raw.cursorAgentModel),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt
  };
}

export function hasPersistedExternalAiSettings(
  store: ExternalAiSettingsReadStore | undefined | null
): boolean {
  return isReadStore(store) && store.getDaemonControl?.(EXTERNAL_AI_SETTINGS_KEY) != null;
}

export function readExternalAiSettings(
  store: ExternalAiSettingsReadStore | undefined | null
): ExternalAiSettings {
  if (!isReadStore(store)) return defaultExternalAiSettings();
  const saved = store.getDaemonControl?.(EXTERNAL_AI_SETTINGS_KEY) as Partial<ExternalAiSettings> | undefined;
  if (!saved) return defaultExternalAiSettings();
  return normalizeExternalAiSettings(saved);
}

/** Lab persisted settings win; otherwise fall back to existing RAW_AGENT_EXTERNAL_AI_TOOLS env. */
export function resolveExternalAiSettings(
  store: ExternalAiSettingsReadStore | undefined | null,
  env: NodeJS.ProcessEnv = process.env
): ExternalAiSettings {
  if (hasPersistedExternalAiSettings(store)) {
    return readExternalAiSettings(store);
  }
  const base = defaultExternalAiSettings();
  return {
    ...base,
    enabled: envBool(env, 'RAW_AGENT_EXTERNAL_AI_TOOLS', false)
  };
}

function assertBooleanField(record: Record<string, unknown>, key: 'enabled' | 'allowInBotChats'): boolean | undefined {
  if (!(key in record)) return undefined;
  if (typeof record[key] !== 'boolean') throw new ValidationError(`${key} must be boolean`);
  return record[key];
}

function assertPreferredToolField(record: Record<string, unknown>): PreferredExternalAiTool | undefined {
  if (!('preferredTool' in record)) return undefined;
  const raw = record.preferredTool;
  if (typeof raw !== 'string' || !VALID_PREFERRED_TOOLS.has(raw)) {
    throw new ValidationError('Invalid preferredTool (expected auto, claude_code, codex_exec, or cursor_agent)');
  }
  return raw as PreferredExternalAiTool;
}

function assertCursorModelField(record: Record<string, unknown>): string | undefined {
  if (!('cursorAgentModel' in record)) return undefined;
  if (typeof record.cursorAgentModel !== 'string') throw new ValidationError('cursorAgentModel must be string');
  const trimmed = record.cursorAgentModel.trim();
  if (trimmed.length > CURSOR_MODEL_MAX_CHARS || /\s/.test(trimmed)) {
    throw new ValidationError('Invalid cursorAgentModel (no whitespace, max 128 chars)');
  }
  return trimmed;
}

function assertKnownKeys(record: Record<string, unknown>): void {
  const unknown = Object.keys(record).find((key) => !VALID_PATCH_KEYS.has(key));
  if (unknown) throw new ValidationError(`Unknown external-ai setting: ${unknown}`);
}

function validatePatch(patch: unknown): Partial<ExternalAiSettings> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new ValidationError('Settings object required');
  }
  const record = patch as Record<string, unknown>;
  assertKnownKeys(record);
  const enabled = assertBooleanField(record, 'enabled');
  const allowInBotChats = assertBooleanField(record, 'allowInBotChats');
  const preferredTool = assertPreferredToolField(record);
  const cursorAgentModel = assertCursorModelField(record);
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(allowInBotChats !== undefined ? { allowInBotChats } : {}),
    ...(preferredTool !== undefined ? { preferredTool } : {}),
    ...(cursorAgentModel !== undefined ? { cursorAgentModel } : {})
  };
}

export function writeExternalAiSettings(
  store: ExternalAiSettingsStore,
  patch: ExternalAiSettingsPatch,
  env: NodeJS.ProcessEnv = process.env
): ExternalAiSettings {
  const clean = validatePatch(patch);
  const current = resolveExternalAiSettings(store, env);
  const next = normalizeExternalAiSettings({
    ...current,
    ...clean,
    updatedAt: nowIso()
  });
  store.setDaemonControl(EXTERNAL_AI_SETTINGS_KEY, next);
  return next;
}

/** True for canonical Bot chats and Bot-owned chat sessions; never true for subagents. */
export function isBotOwnedCodingSession(session: {
  mode?: string;
  metadata?: Record<string, unknown> | null;
}): boolean {
  if (session.mode !== 'chat') return false;
  if (session.metadata?.canonicalBotChat === true) return true;
  const botId = session.metadata?.botId;
  return typeof botId === 'string' && botId.trim().length > 0;
}

/**
 * Effective external-AI tool gate for a session.
 * - Master switch (Lab persisted setting or RAW_AGENT_EXTERNAL_AI_TOOLS fallback) must be on.
 * - Explicit `session.metadata.allowExternalAiTools === false` denies.
 * - Explicit `session.metadata.allowExternalAiTools === true` grants.
 * - Otherwise, Bot chats inherit `allowInBotChats`; ordinary non-bot chats stay isolated.
 */
export function isExternalAiAllowedForSession(
  store: ExternalAiSettingsReadStore | undefined | null,
  env: NodeJS.ProcessEnv,
  session: { mode?: string; metadata?: Record<string, unknown> | null }
): boolean {
  const settings = resolveExternalAiSettings(store, env);
  if (!settings.enabled) return false;
  if (session.metadata?.allowExternalAiTools === false) return false;
  if (session.metadata?.allowExternalAiTools === true) return true;
  return settings.allowInBotChats && isBotOwnedCodingSession(session);
}
