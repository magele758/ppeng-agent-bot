import type { ModelAdapter } from '../../types.js';
export const BOT_CONTEXT_SETTINGS_KEY = 'bot.contextSettings';
export interface BotContextSettings { fallbackContextTokens: number }
export interface ContextSettingsStore { getDaemonControl<T>(key: string): T | undefined; setDaemonControl?(key: string, value: unknown): void }
export function readBotContextSettings(store: ContextSettingsStore): BotContextSettings {
 const raw=store.getDaemonControl<BotContextSettings>(BOT_CONTEXT_SETTINGS_KEY);
 return {fallbackContextTokens: Number.isSafeInteger(raw?.fallbackContextTokens) && raw!.fallbackContextTokens >= 1024 ? raw!.fallbackContextTokens : 32768};
}
export function writeBotContextSettings(store: ContextSettingsStore, value: unknown): BotContextSettings {
 const tokens=(value as BotContextSettings)?.fallbackContextTokens;
 if(!Number.isSafeInteger(tokens)||tokens<1024||tokens>10000000) throw new Error('fallbackContextTokens must be an integer between 1024 and 10000000');
 const settings={fallbackContextTokens:tokens};store.setDaemonControl?.(BOT_CONTEXT_SETTINGS_KEY,settings);return settings;
}
export function resolveBotWindowBudget(store: ContextSettingsStore, adapter: Partial<ModelAdapter> & {contextWindow?:number}, shape:{systemPromptChars?:number;toolCount?:number;toolSchemaTokens?:number}={}) {
 const contextTokens=adapter.contextWindow && Number.isSafeInteger(adapter.contextWindow) && adapter.contextWindow>0 ? adapter.contextWindow : readBotContextSettings(store).fallbackContextTokens;
 const overhead=Math.ceil((shape.systemPromptChars??0)/4)+(shape.toolSchemaTokens??(shape.toolCount??0)*120);
 const reserve=Math.min(16000,Math.floor(contextTokens*.2))+Math.min(2000,Math.floor(contextTokens*.05));
 const historyTokens=Math.max(1,contextTokens-overhead-reserve);
 return {contextTokens,historyTokens,structuredTokens:Math.max(1,Math.min(Math.floor(contextTokens*.5),historyTokens)),hygieneTokens:Math.max(1,Math.min(Math.floor(contextTokens*.85),historyTokens))};
}
