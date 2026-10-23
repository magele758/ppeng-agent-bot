import { ModelProvidersCard } from '../../../ModelProvidersCard';
import { JevSettingsCard } from '../../../JevSettingsCard';
import type { SettingsEntry } from '../registry';

export const modelsEntries: SettingsEntry[] = [
  {
    id: 'modelProviders',
    category: 'models',
    titleKey: 'settings.entries.modelProviders.title',
    keywordsKey: 'settings.entries.modelProviders.keywords',
    render: () => <ModelProvidersCard />
  },
  {
    id: 'jev',
    category: 'models',
    titleKey: 'settingsEntries.jev.title',
    keywordsKey: 'settingsEntries.jev.keywords',
    render: () => <JevSettingsCard />
  }
];
