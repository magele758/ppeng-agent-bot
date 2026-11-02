import { DebugDisplaySettingsCard } from '../../../DebugDisplay';
import { FontSizeSettingsCard } from '../../../FontSizeSettingsCard';
import { LanguageSettingsCard } from '../../../LanguageSettingsCard';
import { RoomCapacitySettingsCard } from '../../../RoomCapacitySettingsCard';
import { SessionBriefSettingsCard } from '../../../SessionBriefSettingsCard';
import { ThemeSettingsCard } from '../../../ThemeSettingsCard';
import type { SettingsEntry } from '../registry';

export const generalEntries: SettingsEntry[] = [
  { id: 'debug-display', category: 'general', titleKey: 'settings.debugDisplay.title', keywordsKey: 'settings.debugDisplay.keywords', render: () => <DebugDisplaySettingsCard /> },
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
    id: 'session-brief',
    category: 'general',
    titleKey: 'settings.entries.sessionBrief.title',
    keywordsKey: 'settings.entries.sessionBrief.keywords',
    render: () => <SessionBriefSettingsCard />
  },
  {
    id: 'room-capacity',
    category: 'general',
    titleKey: 'settings.entries.roomCapacity.title',
    keywordsKey: 'settings.entries.roomCapacity.keywords',
    render: () => <RoomCapacitySettingsCard />
  }
];
