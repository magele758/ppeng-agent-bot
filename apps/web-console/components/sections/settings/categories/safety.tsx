import { SandboxSettingsCard } from '../../../SandboxSettingsCard';
import type { SettingsEntry } from '../registry';

export const safetyEntries: SettingsEntry[] = [
  {
    id: 'sandbox',
    category: 'safety',
    titleKey: 'settingsEntries.sandbox.title',
    keywordsKey: 'settingsEntries.sandbox.keywords',
    render: () => <SandboxSettingsCard />
  }
];
