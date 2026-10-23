import type { ReactNode } from 'react';
import type { MessageKey } from '@/lib/i18n';
import type { SUB_PAGES } from '@/lib/nav';
import { behaviorEntries } from './categories/behavior';
import { experimentalEntries } from './categories/experimental';
import { gatewayEntries } from './categories/gateway';
import { generalEntries } from './categories/general';
import { integrationsEntries } from './categories/integrations';
import { modelsEntries } from './categories/models';
import { safetyEntries } from './categories/safety';
import { toolsEntries } from './categories/tools';

export type SettingsCategoryId = (typeof SUB_PAGES.settings)[number];

export interface SettingsRenderContext {
  sessionId?: string;
}

export interface SettingsEntry {
  /** 全局唯一，DOM id 为 `setting-<id>` */
  id: string;
  category: SettingsCategoryId;
  titleKey: MessageKey;
  /** 额外搜索关键词（i18n，空格分隔多个同义词） */
  keywordsKey?: MessageKey;
  /** 仍由「显示高级」整项收起。实验特性里的条目不要再标这个。 */
  advanced?: boolean;
  render: (ctx: SettingsRenderContext) => ReactNode;
}

/** 各分类文件各自维护自己的条目；此处仅汇总，勿在此写业务 */
export const SETTINGS_ENTRIES: readonly SettingsEntry[] = [
  ...generalEntries,
  ...modelsEntries,
  ...behaviorEntries,
  ...safetyEntries,
  ...toolsEntries,
  ...gatewayEntries,
  ...integrationsEntries,
  ...experimentalEntries
];
