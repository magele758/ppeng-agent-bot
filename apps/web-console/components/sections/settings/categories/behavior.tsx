import { AgentLoopEngineSettingsCard, AgentLoopSettingsCard } from '../../../AgentLoopSettingsCard';
import { CompactSettingsCard } from '../../../CompactSettingsCard';
import { GoalSettingsCard, GoalVerifySettingsCard } from '../../../GoalSettingsCard';
import { BotLimits } from '../../../bot-work/BotLimits';
import type { SettingsEntry } from '../registry';

/** 常用项在前；专家级（引擎内核、压缩、目标校验）标 advanced，被搜索命中时自动展示 */
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
    id: 'goal',
    category: 'behavior',
    titleKey: 'settingsEntries.goal.title',
    keywordsKey: 'settingsEntries.goal.keywords',
    render: () => <GoalSettingsCard />
  },
  {
    id: 'compact',
    category: 'behavior',
    advanced: true,
    titleKey: 'settingsEntries.compact.title',
    keywordsKey: 'settingsEntries.compact.keywords',
    render: () => <CompactSettingsCard />
  },
  {
    id: 'goalVerify',
    category: 'behavior',
    advanced: true,
    titleKey: 'settingsEntries.goalVerify.title',
    keywordsKey: 'settingsEntries.goalVerify.keywords',
    render: () => <GoalVerifySettingsCard />
  },
  {
    id: 'agentLoopEngine',
    category: 'behavior',
    advanced: true,
    titleKey: 'settingsEntries.agentLoopEngine.title',
    keywordsKey: 'settingsEntries.agentLoopEngine.keywords',
    render: () => <AgentLoopEngineSettingsCard />
  }
];
