import { EventLogSettingsCard } from '../../../EventLogSettingsCard';
import { ExternalAgentSettingsCard } from '../../../ExternalAgentSettingsCard';
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
  }
];
