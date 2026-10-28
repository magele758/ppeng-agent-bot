import { RuntimeCapabilitiesCard } from '../../../RuntimeCapabilitiesCard';
import { ToolExposureSettingsCard } from '../../../ToolExposureSettingsCard';
import { AppControlSettingsCard } from '../../../AppControlSettingsCard';
import { ComputerUseSettingsCard } from '../../../ComputerUseSettingsCard';
import { ConnectorsSettingsCard } from '../../../ConnectorsSettingsCard';
import { SkillSettingsCard } from '../../../SkillSettingsCard';
import type { SettingsEntry } from '../registry';

export const toolsEntries: SettingsEntry[] = [
  {id:'runtimeCapabilities',category:'tools',titleKey:'botSettings.runtimeTitle',keywordsKey:'botSettings.runtimeKeywords',render:()=> <RuntimeCapabilitiesCard/>},
  {id:'toolExposure',category:'tools',titleKey:'settingsEntries.toolExposure.title',keywordsKey:'settingsEntries.toolExposure.keywords',render:({sessionId})=><ToolExposureSettingsCard sessionId={sessionId}/>},
  { id: 'computerUse', category: 'tools', titleKey: 'settingsEntries.computerUse.title', keywordsKey: 'settingsEntries.computerUse.keywords', render: () => <ComputerUseSettingsCard /> },
  { id: 'appControl', category: 'tools', titleKey: 'settingsEntries.appControl.title', keywordsKey: 'settingsEntries.appControl.keywords', render: () => <AppControlSettingsCard /> },
  { id: 'connectors', category: 'tools', titleKey: 'settingsEntries.connectors.title', keywordsKey: 'settingsEntries.connectors.keywords', render: () => <ConnectorsSettingsCard /> },
  {
    id: 'skills',
    category: 'tools',
    titleKey: 'settingsEntries.skills.title',
    keywordsKey: 'settingsEntries.skills.keywords',
    render: () => <SkillSettingsCard />
  }
];
