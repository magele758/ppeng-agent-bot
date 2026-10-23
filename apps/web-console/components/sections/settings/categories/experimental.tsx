import { AgentLoopEngineSettingsCard } from '../../../AgentLoopSettingsCard';
import { CompactSettingsCard } from '../../../CompactSettingsCard';
import { DiscoverySettingsCard } from '../../../DiscoverySettingsCard';
import { DynToolsSettingsCard } from '../../../DynToolsSettingsCard';
import { GoalVerifySettingsCard } from '../../../GoalSettingsCard';
import { LangfuseSettingsCard } from '../../../LangfuseSettingsCard';
import { ModelFallbackCard } from '../../../ModelFallbackCard';
import { SandboxCloudflareSettingsCard } from '../../../SandboxSettingsCard';
import type { SettingsEntry } from '../registry';

/** 原先整项标 advanced 的设置。每一项自带总闸，详细配置只在打开时出现。 */
export const experimentalEntries: SettingsEntry[] = [
  {
    id: 'modelFallback',
    category: 'experimental',
    titleKey: 'settings.entries.modelFallback.title',
    keywordsKey: 'settings.entries.modelFallback.keywords',
    render: () => <ModelFallbackCard />
  },
  {
    id: 'compact',
    category: 'experimental',
    titleKey: 'settingsEntries.compact.title',
    keywordsKey: 'settingsEntries.compact.keywords',
    render: () => <CompactSettingsCard />
  },
  {
    id: 'goalVerify',
    category: 'experimental',
    titleKey: 'settingsEntries.goalVerify.title',
    keywordsKey: 'settingsEntries.goalVerify.keywords',
    render: () => <GoalVerifySettingsCard />
  },
  {
    id: 'agentLoopEngine',
    category: 'experimental',
    titleKey: 'settingsEntries.agentLoopEngine.title',
    keywordsKey: 'settingsEntries.agentLoopEngine.keywords',
    render: () => <AgentLoopEngineSettingsCard />
  },
  {
    id: 'sandboxCloudflare',
    category: 'experimental',
    titleKey: 'settingsEntries.sandboxCloudflare.title',
    keywordsKey: 'settingsEntries.sandboxCloudflare.keywords',
    render: () => <SandboxCloudflareSettingsCard />
  },
  {
    id: 'dynTools',
    category: 'experimental',
    titleKey: 'settingsEntries.dynTools.title',
    keywordsKey: 'settingsEntries.dynTools.keywords',
    render: ({ sessionId }) => <DynToolsSettingsCard sessionId={sessionId} />
  },
  {
    id: 'discovery',
    category: 'experimental',
    titleKey: 'settingsEntries.discovery.title',
    keywordsKey: 'settingsEntries.discovery.keywords',
    render: () => <DiscoverySettingsCard />
  },
  {
    id: 'langfuse',
    category: 'experimental',
    titleKey: 'settingsEntries.langfuse.title',
    keywordsKey: 'settingsEntries.langfuse.keywords',
    render: () => <LangfuseSettingsCard />
  }
];
