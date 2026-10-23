import { parseBotPermissionMode, type BotPermissionMode } from './bot-permission.ts';
import { parseBotModelOverride } from './bot-model.ts';
import type { ModelRef } from './model-providers.ts';

export interface BotSettingsSnapshot {
  maxTurns: number;
  allowedTools: string[];
  allowedSkills: string[];
  permissionMode: BotPermissionMode;
  modelOverride: ModelRef | null;
}

function nameList(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    : [];
}

/** Bot 的运行设置存放在其固定会话的 metadata 里；缺省值与 daemon 一致。 */
export function readBotSettings(metadata: Record<string, unknown> | undefined): BotSettingsSnapshot {
  const raw = metadata?.maxTurns;
  return {
    maxTurns: raw === 24 || raw === 48 || raw === 96 ? raw : 0,
    allowedTools: nameList(metadata?.allowedTools),
    allowedSkills: nameList(metadata?.allowedSkills),
    permissionMode: parseBotPermissionMode(metadata?.permissionMode),
    modelOverride: parseBotModelOverride(metadata)
  };
}
