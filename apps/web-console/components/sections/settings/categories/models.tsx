import { ModelProvidersCard } from '../../../ModelProvidersCard';
import type { SettingsEntry } from '../registry';

export const modelsEntries: SettingsEntry[] = [
  {
    id: 'modelProviders',
    category: 'models',
    titleKey: 'settings.entries.modelProviders.title',
    keywordsKey: 'settings.entries.modelProviders.keywords',
    render: () => <ModelProvidersCard />
  }
];
