import { AgentLoopSettingsCard } from '../../../AgentLoopSettingsCard';
import { PromptVariantSettingsCard } from '../../../PromptVariantSettingsCard';
import { ThinkingEffortSettingsCard } from '../../../ThinkingEffortSettingsCard';
import { InputSuggestionSettingsCard } from '../../../InputSuggestionSettingsCard';
import { SessionRecapSettingsCard } from '../../../SessionRecapSettingsCard';
import { GoalSettingsCard } from '../../../GoalSettingsCard';
import { BotFinishSettingsCard } from '../../../BotFinishSettingsCard';
import { DeliveryQuietHoursSettingsCard } from '../../../DeliveryQuietHoursSettingsCard';
import { BotLimits } from '../../../bot-work/BotLimits';
import type { SettingsEntry } from '../registry';

export const behaviorEntries: SettingsEntry[] = [
  {
    id: 'botLimits',
    category: 'behavior',
    titleKey: 'botWork.globalLimits',
    keywordsKey: 'botWork.globalLimitsKeywords',
    render: () => <BotLimits />
  },
  {
    id: 'agentLoop',
    category: 'behavior',
    titleKey: 'settingsEntries.agentLoop.title',
    keywordsKey: 'settingsEntries.agentLoop.keywords',
    render: () => <AgentLoopSettingsCard />
  },
  {
    id: 'promptVariant',
    category: 'behavior',
    titleKey: 'settingsEntries.promptVariant.title',
    keywordsKey: 'settingsEntries.promptVariant.keywords',
    render: () => <PromptVariantSettingsCard />
  },
  {
    id: 'thinkingEffort',
    category: 'behavior',
    titleKey: 'settingsEntries.thinkingEffort.title',
    keywordsKey: 'settingsEntries.thinkingEffort.keywords',
    render: () => <ThinkingEffortSettingsCard />
  },
  {
    id: 'inputSuggestion',
    category: 'behavior',
    titleKey: 'settingsEntries.inputSuggestion.title',
    keywordsKey: 'settingsEntries.inputSuggestion.keywords',
    render: () => <InputSuggestionSettingsCard />
  },
  {
    id: 'sessionRecap',
    category: 'behavior',
    titleKey: 'settingsEntries.sessionRecap.title',
    keywordsKey: 'settingsEntries.sessionRecap.keywords',
    render: () => <SessionRecapSettingsCard />
  },
  {
    id: 'goal',
    category: 'behavior',
    titleKey: 'settingsEntries.goal.title',
    keywordsKey: 'settingsEntries.goal.keywords',
    render: () => <GoalSettingsCard />
  },
  {
    id: 'botFinish',
    category: 'behavior',
    titleKey: 'settingsEntries.botFinish.title',
    keywordsKey: 'settingsEntries.botFinish.keywords',
    render: () => <BotFinishSettingsCard />
  },
  {
    id: 'deliveryQuietHours',
    category: 'behavior',
    titleKey: 'settingsEntries.deliveryQuietHours.title',
    keywordsKey: 'settingsEntries.deliveryQuietHours.keywords',
    render: () => <DeliveryQuietHoursSettingsCard />
  }
];
