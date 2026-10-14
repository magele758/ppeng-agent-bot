import type { ModelAdapter } from '../../types.js';
import { botCompactTokenThresholds } from '../bot-compact-policy.js';
import { resolveMaxContextTokens } from '../session-budget.js';

export const BOT_CONTEXT_SETTINGS_KEY = 'bot.contextSettings';

export interface BotContextSettings {
  fallbackContextTokens: number;
}

export interface ContextSettingsStore {
  getDaemonControl<T>(key: string): T | undefined;
  setDaemonControl?(key: string, value: unknown): void;
}

export interface BotWindowShape {
  systemPromptChars?: number;
  toolCount?: number;
  toolSchemaTokens?: number;
}

function savedFallback(store: ContextSettingsStore): number | undefined {
  const raw = store.getDaemonControl<BotContextSettings>(BOT_CONTEXT_SETTINGS_KEY);
  const tokens = raw?.fallbackContextTokens;
  if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 1024 || tokens > 10_000_000) {
    return undefined;
  }
  return tokens;
}

/** Operator-saved window, including 32768. Unset stays the model default (131072). */
export function readBotContextSettings(store: ContextSettingsStore): BotContextSettings {
  return { fallbackContextTokens: savedFallback(store) ?? resolveMaxContextTokens() };
}

export function writeBotContextSettings(store: ContextSettingsStore, value: unknown): BotContextSettings {
  const tokens = (value as BotContextSettings)?.fallbackContextTokens;
  if (!Number.isSafeInteger(tokens) || tokens < 1024 || tokens > 10_000_000) {
    throw new Error('fallbackContextTokens must be an integer between 1024 and 10000000');
  }
  const settings = { fallbackContextTokens: tokens };
  store.setDaemonControl?.(BOT_CONTEXT_SETTINGS_KEY, settings);
  return readBotContextSettings(store);
}

function declaredContextTokens(adapter: Partial<ModelAdapter> & { contextWindow?: number }): number | undefined {
  const declared = adapter.contextWindow;
  if (typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0) return declared;
  return undefined;
}

/**
 * Real model window. A declared adapter window wins. When the adapter omits
 * one, use an explicit saved size, else {@link resolveMaxContextTokens}.
 * Compact tiers are fractions of this window, not of the history remainder.
 */
export function resolveBotContextTokens(
  store: ContextSettingsStore,
  adapter: Partial<ModelAdapter> & { contextWindow?: number },
  env: NodeJS.ProcessEnv = process.env
): number {
  return declaredContextTokens(adapter) ?? savedFallback(store) ?? resolveMaxContextTokens(env);
}

export function resolveBotWindowBudget(
  store: ContextSettingsStore,
  adapter: Partial<ModelAdapter> & { contextWindow?: number },
  shape: BotWindowShape = {},
  env: NodeJS.ProcessEnv = process.env
) {
  const contextTokens = resolveBotContextTokens(store, adapter, env);
  const { structuredTokens, hygieneTokens } = botCompactTokenThresholds(contextTokens);
  const overhead =
    Math.ceil((shape.systemPromptChars ?? 0) / 4) +
    (shape.toolSchemaTokens ?? (shape.toolCount ?? 0) * 120);
  const reserve =
    Math.min(16_000, Math.floor(contextTokens * 0.2)) + Math.min(2_000, Math.floor(contextTokens * 0.05));
  const historyTokens = Math.max(1, contextTokens - overhead - reserve);
  return { contextTokens, historyTokens, structuredTokens, hygieneTokens };
}
