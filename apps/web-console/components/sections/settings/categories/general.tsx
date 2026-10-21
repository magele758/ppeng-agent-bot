import { FontSizeSettingsCard } from '../../../FontSizeSettingsCard';
import { LanguageSettingsCard } from '../../../LanguageSettingsCard';
import { RoomCapacitySettingsCard } from '../../../RoomCapacitySettingsCard';
import { ThemeSettingsCard } from '../../../ThemeSettingsCard';
import type { SettingsEntry } from '../registry';

export const generalEntries: SettingsEntry[] = [
  { id: 'font-size', category: 'general', titleKey: 'settings.fontSize.title', keywordsKey: 'settings.fontSize.keywords', render: () => <FontSizeSettingsCard /> },
  {
    id: 'language',
    category: 'general',
    titleKey: 'settings.entries.language.title',
    keywordsKey: 'settings.entries.language.keywords',
    render: () => <LanguageSettingsCard />
  },
  {
    id: 'theme',
    category: 'general',
    titleKey: 'settings.entries.theme.title',
    keywordsKey: 'settings.entries.theme.keywords',
    render: () => <ThemeSettingsCard />
  },
  {
    id: 'room-capacity',
    category: 'general',
    titleKey: 'settings.entries.roomCapacity.title',
    keywordsKey: 'settings.entries.roomCapacity.keywords',
    render: () => <RoomCapacitySettingsCard />
  }
];
