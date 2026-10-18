import { EventLogSettingsCard } from '../../../EventLogSettingsCard';
import { ExternalAgentSettingsCard } from '../../../ExternalAgentSettingsCard';
import { JevSettingsCard } from '../../../JevSettingsCard';
import { LangfuseSettingsCard } from '../../../LangfuseSettingsCard';
import type { SettingsEntry } from '../registry';

export const integrationsEntries: SettingsEntry[] = [
  {
    id: 'externalAgents',
    category: 'integrations',
    titleKey: 'externalAgents.title',
    keywordsKey: 'externalAgents.keywords',
    render: () => <ExternalAgentSettingsCard />
  },
  {
    id: 'eventLog',
    category: 'integrations',
    titleKey: 'settingsEntries.eventLog.title',
    keywordsKey: 'settingsEntries.eventLog.keywords',
    render: () => <EventLogSettingsCard />
  },
  {
    id: 'langfuse',
    category: 'integrations',
    advanced: true,
    titleKey: 'settingsEntries.langfuse.title',
    keywordsKey: 'settingsEntries.langfuse.keywords',
    render: () => <LangfuseSettingsCard />
  },
  {
    id: 'jev',
    category: 'integrations',
    advanced: true,
    titleKey: 'settingsEntries.jev.title',
    keywordsKey: 'settingsEntries.jev.keywords',
    render: () => <JevSettingsCard />
  }
];
