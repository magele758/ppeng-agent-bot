import { ComputerUseSettingsCard } from '../../../ComputerUseSettingsCard';
import { ConnectorsSettingsCard } from '../../../ConnectorsSettingsCard';
import { DiscoverySettingsCard } from '../../../DiscoverySettingsCard';
import { DynToolsSettingsCard } from '../../../DynToolsSettingsCard';
import { SkillSettingsCard } from '../../../SkillSettingsCard';
import type { SettingsEntry } from '../registry';

export const toolsEntries: SettingsEntry[] = [
  { id: 'computerUse', category: 'tools', titleKey: 'settingsEntries.computerUse.title', keywordsKey: 'settingsEntries.computerUse.keywords', render: () => <ComputerUseSettingsCard /> },
  { id: 'connectors', category: 'tools', titleKey: 'settingsEntries.connectors.title', keywordsKey: 'settingsEntries.connectors.keywords', render: () => <ConnectorsSettingsCard /> },
  {
    id: 'skills',
    category: 'tools',
    titleKey: 'settingsEntries.skills.title',
    keywordsKey: 'settingsEntries.skills.keywords',
    render: () => <SkillSettingsCard />
  },
  {
    id: 'dynTools',
    category: 'tools',
    advanced: true,
    titleKey: 'settingsEntries.dynTools.title',
    keywordsKey: 'settingsEntries.dynTools.keywords',
    render: ({ sessionId }) => <DynToolsSettingsCard sessionId={sessionId} />
  },
  {
    id: 'discovery',
    category: 'tools',
    advanced: true,
    titleKey: 'settingsEntries.discovery.title',
    keywordsKey: 'settingsEntries.discovery.keywords',
    render: () => <DiscoverySettingsCard />
  }
];
