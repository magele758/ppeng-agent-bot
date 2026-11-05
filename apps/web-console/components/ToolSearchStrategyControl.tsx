'use client';
import { useI18n } from '@/lib/i18n';

export function ToolSearchStrategyControl({ value, busy, save }: {
    value: string;
    busy: boolean;
    save: (patch: Record<string, unknown>) => Promise<void>;
}) {
    const { t } = useI18n();
    return <div>
        <label htmlFor="tool-search-strategy">{t('settingsEntries.toolExposure.searchStrategy')}</label>
        <select id="tool-search-strategy" value={value} disabled={busy} onChange={e => void save({ searchStrategy: e.target.value })}>
            <option value="legacy">{t('settingsEntries.toolExposure.searchLegacy')}</option>
            <option value="enhanced">{t('settingsEntries.toolExposure.searchEnhanced')}</option>
        </select>
        <p>{t('settingsEntries.toolExposure.searchHint')}</p>
    </div>;
}
